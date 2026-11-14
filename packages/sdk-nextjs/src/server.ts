/**
 * Server-side helper for proxying Cohorly ingestion requests through a
 * first-party Next.js route, so browsers call your own domain instead of
 * the Cohorly server directly (avoids ad-blockers, keeps apiHost private).
 *
 * Usage (app/api/cohorly/[...path]/route.ts):
 *
 *   export const { POST } = createCohorlyProxy({ apiHost: "https://cohorly-service.velloalabs.com" });
 *
 * Then point the client SDK's apiHost at "/api/cohorly" and it will
 * transparently forward POST /api/cohorly/track (etc.) upstream.
 *
 * Typed loosely against the platform Request/Response globals (available in
 * both Node.js Route Handlers and the Edge runtime) so this package doesn't
 * need "next" as a hard dependency.
 *
 * ## Token modes
 *
 * There are two ways to attach a project token to ingested data:
 *
 * 1. Client-side: pass `token` to `CohorlyProvider` / `init()` (from
 *    `@cohorly/react` / `@cohorly/web`). The token ships in the browser
 *    bundle and is included in every request body the client sends, which
 *    this proxy then forwards upstream unmodified.
 * 2. Server-side (this option): pass `token` here instead. The token stays
 *    out of the client bundle entirely; this proxy injects it into every
 *    forwarded /track event's properties and every /engage or /alias body
 *    before relaying the request upstream. Leave `token` unset on the
 *    client SDK when using this mode.
 */
export interface CohorlyProxyOptions {
  /**
   * Upstream Cohorly ingestion API to relay to. Defaults to the hosted
   * endpoint (`https://cohorly-service.velloalabs.com`); only set this to
   * point at a different deployment.
   */
  apiHost?: string;
  /**
   * Upstream paths allowed to be forwarded. Defaults to
   * track/engage/alias/flags/evaluate/replay. Multi-segment paths (like
   * `flags/evaluate`) are matched on their full slash-joined form.
   */
  allowedPaths?: string[];
  /**
   * Project token injected server-side into every forwarded /track event's
   * properties and every /engage, /alias or /flags/evaluate body, and sent as
   * the `X-Cohorly-Token` header of every /replay chunk. Use this to
   * keep the token out of client bundles instead of passing it to the client
   * SDK's `init`.
   */
  token?: string;
}

interface RouteContext {
  params?: { path?: string[] } | Promise<{ path?: string[] }>;
}

export interface CohorlyProxyHandlers {
  POST(request: Request, context?: RouteContext): Promise<Response>;
}

const DEFAULT_API_HOST = "https://cohorly-service.velloalabs.com";

export function createCohorlyProxy(options: CohorlyProxyOptions = {}): CohorlyProxyHandlers {
  const apiHost = (options.apiHost ?? DEFAULT_API_HOST).replace(/\/$/, "");
  const allowed = new Set(
    options.allowedPaths ?? ["track", "engage", "alias", "flags/evaluate", "replay"],
  );

  async function POST(request: Request, context?: RouteContext): Promise<Response> {
    const resolvedParams = context?.params ? await context.params : undefined;
    const segments = resolvedParams?.path ?? segmentsFromUrl(request.url);
    // Prefer the longest trailing match, so a two-segment upstream path like
    // `flags/evaluate` wins over the bare last segment (`evaluate`).
    const target = resolveTarget(segments, allowed);

    if (!target) {
      return new Response(JSON.stringify({ error: "unknown cohorly proxy path" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    let upstream: Response;
    try {
      upstream =
        target === "replay"
          ? await forwardReplay(request, `${apiHost}/${target}`, options.token)
          : await forwardJson(request, `${apiHost}/${target}`, target, options.token);
    } catch {
      return new Response(JSON.stringify({ error: "cohorly upstream unreachable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    const text = await upstream.text();
    const headers: Record<string, string> = {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    };
    // The SDK honors Retry-After on 429/5xx (replay quota, rate limits).
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter !== null) headers["retry-after"] = retryAfter;
    return new Response(text, { status: upstream.status, headers });
  }

  return { POST };
}

async function forwardJson(
  request: Request,
  url: string,
  target: string,
  token: string | undefined,
): Promise<Response> {
  let body = await request.text();
  if (token) body = injectToken(body, target, token);
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/**
 * A session replay chunk (`@cohorly/web` sessionReplay) is forwarded as
 * bytes: it is usually gzip, so it is never decoded or rewritten here. The
 * token and compression travel as headers or, for `keepalive` sends, as the
 * `token` / `compression` query parameters; both are passed through. A
 * server-side `token` is sent as the `X-Cohorly-Token` header.
 */
async function forwardReplay(
  request: Request,
  url: string,
  token: string | undefined,
): Promise<Response> {
  const body = await request.arrayBuffer();
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "content-encoding", "x-cohorly-token"]) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  if (token) headers["x-cohorly-token"] = token;
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const name of ["token", "compression"]) {
    const value = incoming.get(name);
    if (value !== null && !(name === "token" && token)) query.set(name, value);
  }
  const search = query.toString();
  return fetch(search ? `${url}?${search}` : url, { method: "POST", headers, body });
}

/**
 * Resolves the upstream path from the route's trailing segments, matching the
 * longest allowed suffix first (max 2 segments, enough for `flags/evaluate`).
 * Returns undefined when nothing matches.
 */
function resolveTarget(segments: string[], allowed: Set<string>): string | undefined {
  for (const depth of [2, 1]) {
    if (segments.length < depth) continue;
    const candidate = segments.slice(segments.length - depth).join("/");
    if (allowed.has(candidate)) return candidate;
  }
  return undefined;
}

function segmentsFromUrl(url: string): string[] {
  const { pathname } = new URL(url);
  return pathname.split("/").filter(Boolean);
}

/**
 * Injects `token` server-side into a forwarded ingestion body. `/track`
 * bodies are `{ event, properties }` (or an array of those) and get the
 * token stamped into `properties.token`; `/engage` and `/alias` bodies get a
 * top-level `token` field, each of which may also be a single object or an
 * array. Falls back to the original raw text if parsing fails, so a
 * malformed body still gets relayed upstream (and rejected there) instead of
 * throwing here.
 */
function injectToken(rawBody: string, target: string, token: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }

  const withToken = <T extends Record<string, unknown>>(item: T): T => {
    if (target === "track") {
      return {
        ...item,
        properties: { ...(item as { properties?: Record<string, unknown> }).properties, token },
      };
    }
    return { ...item, token };
  };

  const next = Array.isArray(parsed) ? parsed.map((item) => withToken(item)) : withToken(parsed as Record<string, unknown>);
  return JSON.stringify(next);
}
