import { readFileSync } from "node:fs";
import { json } from "./import-fake.js";

// An in-memory stand-in for GET /api/lexicon and PUT /api/lexicon/:type/:name,
// injected as `fetch`. It keeps the entries the real route would hold, as far
// as the CLI depends on them. It is NOT the server.

export const LEXICON_FIXTURE = new URL("./fixtures/mixpanel/lexicon-schemas.json", import.meta.url);
export const lexiconFixture = () => JSON.parse(readFileSync(LEXICON_FIXTURE, "utf8")) as { results: unknown[] };

export interface FakeEntry {
  entity_type: string;
  name: string;
  display_name: string | null;
  description: string | null;
  tags: string[];
  hidden: boolean;
}

export interface LexiconRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export type LexiconOverride = (req: LexiconRequest, n: number) => Response | "network-error" | undefined;

export function fakeLexiconServer(initial: Partial<FakeEntry>[] = [], override?: LexiconOverride) {
  const entries = new Map<string, FakeEntry>();
  for (const e of initial) {
    const entry: FakeEntry = { entity_type: "event", name: "", display_name: null, description: null, tags: [], hidden: false, ...e };
    entries.set(`${entry.entity_type}/${entry.name}`, entry);
  }
  const requests: LexiconRequest[] = [];
  let seen = 0;

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) as Record<string, unknown>) : null;
    const req: LexiconRequest = { method, url: String(input), path: url.pathname, headers, body };
    requests.push(req);
    seen++;

    const special = override?.(req, seen);
    if (special === "network-error") throw new TypeError("fetch failed");
    if (special) return special;

    if (method === "GET" && url.pathname === "/api/lexicon") return json(200, [...entries.values()]);
    const m = /^\/api\/lexicon\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (method === "PUT" && m && body) {
      const type = m[1]!;
      const name = decodeURIComponent(m[2]!);
      const entry: FakeEntry = entries.get(`${type}/${name}`) ?? {
        entity_type: type,
        name,
        display_name: null,
        description: null,
        tags: [],
        hidden: false,
      };
      if (typeof body.displayName === "string") entry.display_name = body.displayName;
      if (typeof body.description === "string") entry.description = body.description;
      if (Array.isArray(body.tags)) entry.tags = body.tags as string[];
      if (typeof body.hidden === "boolean") entry.hidden = body.hidden;
      entries.set(`${type}/${name}`, entry);
      return json(200, entry);
    }
    return json(404, { error: "not found" });
  }) as typeof globalThis.fetch;

  return { fetch, requests, entries };
}

export const putsOf = (requests: LexiconRequest[]) => requests.filter((r) => r.method === "PUT");
