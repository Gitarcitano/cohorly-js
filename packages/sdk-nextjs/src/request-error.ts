/**
 * Runtime-neutral pieces of `onRequestError`, shared by the Node and the Edge
 * entry points. Pure: no Node API, no `@cohorly/node`, so the Edge build can
 * import it.
 */

declare const process: { env?: Record<string, string | undefined> } | undefined;

/** The request Next.js passes to `onRequestError` (declared here so `next` stays an optional peer). */
export interface OnRequestErrorRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The context Next.js passes to `onRequestError`. */
export interface OnRequestErrorContext {
  routerKind: "Pages Router" | "App Router";
  routePath: string;
  routeType: "render" | "route" | "action" | "middleware" | "proxy";
  renderSource?:
    | "react-server-components"
    | "react-server-components-payload"
    | "server-rendering";
  revalidateReason?: "on-demand" | "stale";
  renderType?: "dynamic" | "dynamic-resume";
}

/** A fully built `$exception` event, the same shape `@cohorly/node` sends. */
export interface CohorlyExceptionEvent {
  event: string;
  properties: Record<string, unknown> & {
    distinct_id: string;
    time: number;
    $insert_id: string;
    $lib: string;
    $lib_version: string;
  };
}

export interface CohorlyRequestErrorOptions {
  /** Project token. Default: the `COHORLY_TOKEN` env var. Without one, nothing is captured. */
  token?: string;
  /** Cohorly API base URL. Default: `COHORLY_API_HOST`, else the hosted API. */
  apiHost?: string;
  /** Sent as `$exception_release` and `$app_version_string`. Default: `VERCEL_GIT_COMMIT_SHA`. */
  release?: string;
  /** Build inside the release, sent as `$exception_dist`. */
  dist?: string;
  /** Sent as `server_name`, and the `distinct_id` of every exception (default `"server"`). */
  serverName?: string;
  /** How long `onRequestError` waits for the exception to be sent, in ms. Default 2000. */
  flushTimeoutMs?: number;
  /** Change or drop (`null`) an exception before it is sent. Throwing drops it too. */
  beforeSendException?: (event: CohorlyExceptionEvent) => CohorlyExceptionEvent | null;
  /** Log failures via console.warn. Default false. */
  debug?: boolean;
}

export type OnRequestError = (
  error: unknown,
  request: OnRequestErrorRequest,
  context: OnRequestErrorContext,
) => Promise<void>;

export const DEFAULT_API_HOST = "https://cohorly-service.velloalabs.com";
/** Same default as `@cohorly/node`'s `flushTimeoutMs`. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
/** Same fixed id `@cohorly/node` uses when there is no `serverName`. */
export const DEFAULT_SERVER_DISTINCT_ID = "server";
export const REQUEST_ERROR_MECHANISM = Object.freeze({
  type: "nextjs.onRequestError",
  handled: false,
});

export interface ResolvedRequestErrorConfig {
  token: string;
  host: string;
  release: string | undefined;
  dist: string | undefined;
  serverName: string | undefined;
  flushTimeoutMs: number;
  beforeSendException: CohorlyRequestErrorOptions["beforeSendException"];
  debug: boolean;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Each env var is read with a static `process.env.NAME` access: Next.js
 * inlines or allowlists those on the Edge runtime, while a dynamic
 * `process.env[name]` is not guaranteed to see anything there.
 */
function fromEnv(read: () => string | undefined): string | undefined {
  try {
    return typeof process === "undefined" ? undefined : nonEmpty(read());
  } catch {
    return undefined;
  }
}

const envToken = () => fromEnv(() => process?.env?.COHORLY_TOKEN);
const envApiHost = () => fromEnv(() => process?.env?.COHORLY_API_HOST);
const envRelease = () => fromEnv(() => process?.env?.VERCEL_GIT_COMMIT_SHA);

/** Options merged with the env vars, or `undefined` when there is no token (capture is off). */
export function resolveRequestErrorConfig(
  options: CohorlyRequestErrorOptions,
): ResolvedRequestErrorConfig | undefined {
  const token = nonEmpty(options.token) ?? envToken();
  if (!token) return undefined;
  const host = nonEmpty(options.apiHost) ?? envApiHost() ?? DEFAULT_API_HOST;
  const timeout = options.flushTimeoutMs;
  return {
    token,
    host: host.replace(/\/+$/, ""),
    release: nonEmpty(options.release) ?? envRelease(),
    dist: nonEmpty(options.dist),
    serverName: nonEmpty(options.serverName),
    flushTimeoutMs:
      typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0
        ? timeout
        : DEFAULT_FLUSH_TIMEOUT_MS,
    beforeSendException: options.beforeSendException,
    debug: options.debug ?? false,
  };
}

/** `path` without its query string and fragment: they can carry tokens or e-mails. */
export function stripQuery(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

/**
 * The tags of a request error. Built from an allowlist of route facts only:
 * headers, cookies and the query string are never read.
 */
export function requestErrorTags(
  error: unknown,
  request: OnRequestErrorRequest | undefined,
  context: OnRequestErrorContext | undefined,
): Record<string, string> {
  const tags: Record<string, string> = {};
  const set = (key: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) tags[key] = value;
  };
  set("route", context?.routePath);
  set("method", request?.method);
  set("router_kind", context?.routerKind);
  set("route_type", context?.routeType);
  set("render_source", context?.renderSource);
  set("revalidate_reason", context?.revalidateReason);
  set("render_type", context?.renderType);
  if (typeof request?.path === "string") set("request_path", stripQuery(request.path));
  if (typeof error === "object" && error !== null) {
    set("digest", (error as { digest?: unknown }).digest);
  }
  return tags;
}

const RESERVED_EXCEPTION_KEYS: ReadonlySet<string> = new Set([
  "error_title",
  "distinct_id",
  "time",
  "$insert_id",
  "token",
]);

/** The reserved-key rule of `@cohorly/node`, replicated because the Edge build cannot import it. */
export function isReservedExceptionKey(key: string): boolean {
  return (
    key.startsWith("$exception_") ||
    key.startsWith("$lib") ||
    RESERVED_EXCEPTION_KEYS.has(key)
  );
}

export function withoutReservedKeys(props: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!isReservedExceptionKey(key)) out[key] = value;
  }
  return out;
}

export function debugLog(debug: boolean | undefined, ...args: unknown[]): void {
  if (debug) console.warn("[cohorly]", ...args);
}
