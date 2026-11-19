import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// An in-memory stand-in for POST /api/import/events, injected as `fetch`.
// It follows the contract of apps/server/src/import.ts and
// routes/import.ts as far as the CLI depends on it: limits, refusal reasons in
// checking order, deduplication on $insert_id. It is NOT the server: the real
// route is only exercised by a manual run against a server.

export const MAX_EVENTS = 5000;
export const MAX_BYTES = 8 * 1024 * 1024;
const SECONDS_THRESHOLD_MS = 100_000_000_000;
// Same as IMPORT_MAX_NEW_PARTITIONS in apps/server/src/import.ts.
const MAX_NEW_MONTHS = 3;

export const FIXTURE = new URL("./fixtures/mixpanel/export.jsonl", import.meta.url);
export const fixtureText = () => readFileSync(FIXTURE, "utf8");

export interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  /** The bytes on the wire (gzip). */
  wire: Buffer;
  /** The decompressed body. */
  body: string;
  events: unknown[];
}

export type Override = (req: FakeRequest, n: number) => Response | "network-error" | undefined;

export interface FakeOptions {
  /** Events older than this (ms) are refused `older_than_retention`. */
  retentionCutoffMs?: number;
  /** Clock of the fake, for time_in_future (default: Date.now). */
  nowMs?: number;
  /** Answer request n (1-based) differently; undefined keeps the normal answer. */
  override?: Override;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// Same as apps/server/src/import.ts: keys sorted at every level.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

/** The server's unique key: insert id AND time (the events dedup key includes time). */
function insertKey(event: string, distinctId: string, time: number, props: Record<string, unknown>): string {
  const { distinct_id: _d, time: _t, $insert_id: rawId, token: _token, ...rest } = props;
  const id =
    rawId !== undefined && rawId !== null && rawId !== ""
      ? String(rawId)
      : `imp-${createHash("sha256")
          .update(JSON.stringify([event, distinctId, time, canonical(rest)]))
          .digest("hex")}`;
  return `${id}@${time}`;
}

export function fakeImportServer(options: FakeOptions = {}) {
  const requests: FakeRequest[] = [];
  /** Stored events by $insert_id: what the server would hold. */
  const stored = new Map<string, Record<string, unknown>>();
  let override = options.override;

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const wire = Buffer.from(init?.body as Uint8Array);
    const raw = headers["content-encoding"] === "gzip" ? gunzipSync(wire) : wire;
    const body = raw.toString("utf8");
    const parsed = JSON.parse(body) as unknown;
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const req: FakeRequest = { url: String(input), headers, wire, body, events };
    requests.push(req);

    const special = override?.(req, requests.length);
    if (special === "network-error") throw new TypeError("fetch failed");
    if (special) return special;

    if (wire.length > MAX_BYTES || raw.length > MAX_BYTES) return json(413, { status: 0, error: "payload too large" });
    if (events.length > MAX_EVENTS) return json(400, { status: 0, error: `batch too large (max ${MAX_EVENTS})` });

    let inserted = 0;
    let duplicates = 0;
    const refused: { index: number; reason: string }[] = [];
    const accepted: { index: number; ev: Record<string, unknown>; distinctId: string; time: number; props: Record<string, unknown> }[] = [];
    events.forEach((item, index) => {
      const refuse = (reason: string) => refused.push({ index, reason });
      if (!item || typeof item !== "object" || Array.isArray(item)) return refuse("invalid_event");
      const ev = item as Record<string, unknown>;
      if (typeof ev.event !== "string" || ev.event === "") return refuse("invalid_event");
      const props = (ev.properties && typeof ev.properties === "object" && !Array.isArray(ev.properties) ? ev.properties : {}) as Record<
        string,
        unknown
      >;
      const rawDistinct = props.distinct_id;
      const distinctId =
        typeof rawDistinct === "string" && rawDistinct !== "" ? rawDistinct : typeof rawDistinct === "number" && Number.isFinite(rawDistinct) ? String(rawDistinct) : null;
      if (distinctId === null) return refuse("missing_distinct_id");
      const time = props.time;
      if (time === undefined || time === null) return refuse("missing_time");
      if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0) return refuse("invalid_time");
      if (time < SECONDS_THRESHOLD_MS) return refuse("time_in_seconds");
      if (time > (options.nowMs ?? Date.now()) + 60 * 60 * 1000) return refuse("time_in_future");
      if (options.retentionCutoffMs !== undefined && time < options.retentionCutoffMs) return refuse("older_than_retention");
      if (ev.event === "$exception") return refuse("exception_event");
      accepted.push({ index, ev, distinctId, time, props });
    });
    // The fake has no partitions, so every month is new: only the oldest
    // MAX_NEW_MONTHS months of the batch are kept (IMPORT_MAX_NEW_PARTITIONS).
    const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
    const kept = new Set([...new Set(accepted.map((a) => monthOf(a.time)))].sort().slice(0, MAX_NEW_MONTHS));
    for (const { index, ev, distinctId, time, props } of accepted) {
      if (!kept.has(monthOf(time))) {
        refused.push({ index, reason: "too_many_months" });
        continue;
      }
      const key = insertKey(ev.event as string, distinctId, time, props);
      if (stored.has(key)) duplicates++;
      else {
        stored.set(key, ev);
        inserted++;
      }
    }
    refused.sort((a, b) => a.index - b.index);
    return json(200, { status: 1, received: events.length, inserted, duplicates, refused });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    requests,
    stored,
    setOverride(next: Override | undefined) {
      override = next;
    },
  };
}

/** Event names of every event in `events`, counted. */
export function countByName(events: Iterable<unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    const name = String((e as { event?: unknown }).event);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** `n` small valid events, one JSON line each, with times in seconds. */
export function generatedLines(n: number, start = 1): string[] {
  const names = ["Signed Up", "Viewed Page", "Purchase"];
  return Array.from({ length: n }, (_, i) => {
    const k = start + i;
    return JSON.stringify({
      event: names[k % names.length],
      properties: { time: 1_700_000_000 + k, distinct_id: `user-${k % 97}`, $insert_id: `gen-${k}`, mp_lib: "web" },
    });
  });
}

export const PROFILES_PAGE_FIXTURE = new URL("./fixtures/mixpanel/profiles-page.json", import.meta.url);
export const PROFILES_JSONL_FIXTURE = new URL("./fixtures/mixpanel/profiles.jsonl", import.meta.url);

export interface FakeProfileRequest {
  url: string;
  headers: Record<string, string>;
  wire: Buffer;
  body: string;
  profiles: unknown[];
}

export type ProfileOverride = (req: FakeProfileRequest, n: number) => Response | "network-error" | undefined;

/**
 * An in-memory stand-in for POST /api/import/profiles, injected as `fetch`:
 * per-profile $set_once (existing properties win), refusal reasons
 * invalid_profile / missing_distinct_id, same limits as the events route.
 */
export function fakeProfilesServer(options: { override?: ProfileOverride; seed?: Record<string, Record<string, unknown>> } = {}) {
  const requests: FakeProfileRequest[] = [];
  const stored = new Map<string, Record<string, unknown>>(Object.entries(options.seed ?? {}));
  let override = options.override;

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const wire = Buffer.from(init?.body as Uint8Array);
    const raw = headers["content-encoding"] === "gzip" ? gunzipSync(wire) : wire;
    const body = raw.toString("utf8");
    const parsed = JSON.parse(body) as unknown;
    const profiles = Array.isArray(parsed) ? parsed : [parsed];
    const req: FakeProfileRequest = { url: String(input), headers, wire, body, profiles };
    requests.push(req);

    const special = override?.(req, requests.length);
    if (special === "network-error") throw new TypeError("fetch failed");
    if (special) return special;

    if (wire.length > MAX_BYTES || raw.length > MAX_BYTES) return json(413, { status: 0, error: "payload too large" });
    if (profiles.length > MAX_EVENTS) return json(400, { status: 0, error: `batch too large (max ${MAX_EVENTS})` });

    let applied = 0;
    const refused: { index: number; reason: string }[] = [];
    profiles.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return void refused.push({ index, reason: "invalid_profile" });
      const p = item as Record<string, unknown>;
      const id = p.$distinct_id;
      const validId = (typeof id === "string" && id !== "") || (typeof id === "number" && Number.isFinite(id));
      if (!validId) return void refused.push({ index, reason: "missing_distinct_id" });
      const props = p.$properties;
      if (props !== undefined && props !== null && (typeof props !== "object" || Array.isArray(props))) {
        return void refused.push({ index, reason: "invalid_profile" });
      }
      const key = String(id);
      const current = stored.get(key) ?? {};
      for (const [k, v] of Object.entries((props ?? {}) as Record<string, unknown>)) if (!(k in current)) current[k] = v;
      stored.set(key, current);
      applied++;
    });
    return json(200, { status: 1, received: profiles.length, applied, refused });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    requests,
    stored,
    setOverride(next: ProfileOverride | undefined) {
      override = next;
    },
  };
}

/** `n` small valid profiles, one JSON line each. */
export function generatedProfileLines(n: number, start = 1): string[] {
  return Array.from({ length: n }, (_, i) => {
    const k = start + i;
    return JSON.stringify({ $distinct_id: `user-${k}`, $properties: { $email: `u${k}@example.com`, plan: "free" } });
  });
}
