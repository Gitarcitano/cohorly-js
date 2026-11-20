/**
 * Replay triggers (VEL-2187, docs/SESSION-REPLAY.md "Triggers in the SDK"):
 * the project's saved event, URL and flag triggers, served by
 * `/replay/config` (VEL-2186), evaluated in the browser. Main bundle, no
 * dependency: it runs while the session is `off` and replay.ts and rrweb are
 * not loaded. Only session.ts imports it.
 *
 * An event trigger's filters are the client-evaluated subset of FilterSpec
 * (docs/QUERY-IR.md "Client-evaluated subset"); `matchesClientFilter` gives
 * the answer `compile()` gives for every case of the shared table
 * test/fixtures/client-filter-cases.json. A URL pattern matches the whole
 * path: `*` is any run of characters, `/` included, everything else is
 * literal. Parsing is defensive: an entry the SDK cannot read is skipped,
 * never an error.
 */
import type { FlagResult } from "@cohorly/core";

export type ClientFilterOp = "eq" | "neq" | "contains" | "set" | "not_set" | "gt" | "lt";

/** A FilterSpec of the client-evaluated subset. */
export interface ClientFilter {
  kind: "property";
  scope: "event";
  key: string;
  op: ClientFilterOp;
  value?: string | number | boolean;
}

export interface EventTrigger {
  id: string;
  kind: "event";
  event: string;
  filters: ClientFilter[];
  rate: number;
}

export interface UrlTrigger {
  id: string;
  kind: "url";
  pattern: string;
  rate: number;
}

export interface FlagTrigger {
  id: string;
  kind: "flag";
  flag: string;
  /** null: the flag on with any variant. */
  variant: string | null;
  rate: number;
}

export type ReplayTrigger = EventTrigger | UrlTrigger | FlagTrigger;

/** What the server accepts (apps/server/src/replays/triggers.ts); more is not read. */
export const MAX_REPLAY_TRIGGERS = 10;
export const MAX_TRIGGER_FILTERS = 20;

/**
 * Events the client hook also sees but that never fire an event trigger:
 * exception capture and custom metrics (teardown flushes included). Only
 * `track()` events do, autotracked ones (pageviews) included.
 */
export const NON_TRIGGER_EVENTS: ReadonlySet<string> = new Set(["$exception", "$metric"]);

const OPS = new Set<string>(["eq", "neq", "contains", "set", "not_set", "gt", "lt"]);
/** The only text `gt` / `lt` read as a number (Postgres `::numeric` of a plain decimal). */
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

const has = (o: object, key: string) => Object.hasOwn(o, key);

/** The property's text as `->>` gives it, or null when absent or JSON null. */
function text(properties: Record<string, unknown>, key: string): string | null {
  if (!has(properties, key)) return null;
  const v = properties[key];
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Objects and arrays: outside the table (Postgres compares the jsonb text form).
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
}

export function matchesClientFilter(filter: ClientFilter, properties: Record<string, unknown>): boolean {
  const actual = text(properties, filter.key);
  const value = filter.value;
  switch (filter.op) {
    case "set":
      return actual !== null;
    case "not_set":
      return actual === null;
    case "eq":
      return actual !== null && value !== undefined && actual === String(value);
    case "neq":
      return actual === null || value === undefined || actual !== String(value);
    case "contains":
      return actual !== null && typeof value === "string" && actual.includes(value);
    case "gt":
    case "lt": {
      // Booleans ("true") and exponent forms never read as a decimal.
      if (actual === null || typeof value !== "number" || !DECIMAL.test(actual)) return false;
      const n = Number(actual);
      return filter.op === "gt" ? n > value : n < value;
    }
    default:
      return false;
  }
}

const patterns = new Map<string, RegExp>();

/** `pattern` against a path (no query, no fragment): anchored, `*` any run, the rest literal. */
export function matchesUrlPattern(pattern: string, pathname: string): boolean {
  let re = patterns.get(pattern);
  if (!re) {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    re = new RegExp(`^${source}$`);
    patterns.set(pattern, re);
  }
  return re.test(pathname);
}

/** On, and with the trigger's variant when it names one (never another variant). */
export function flagMatches(trigger: FlagTrigger, flags: Record<string, FlagResult>): boolean {
  if (!has(flags, trigger.flag)) return false;
  const flag = flags[trigger.flag];
  if (!flag || flag.enabled !== true) return false;
  return trigger.variant === null || flag.variant === trigger.variant;
}

/** Every filter passes on the event's final properties (none: the name alone). */
export function eventMatches(trigger: EventTrigger, event: string, properties: Record<string, unknown>): boolean {
  return trigger.event === event && trigger.filters.every((f) => matchesClientFilter(f, properties));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseFilter(v: unknown): ClientFilter | null {
  if (!isRecord(v) || v.kind !== "property" || v.scope !== "event" || !isName(v.key)) return null;
  if (typeof v.op !== "string" || !OPS.has(v.op)) return null;
  const op = v.op as ClientFilterOp;
  const value = v.value;
  if (op === "set" || op === "not_set") return { kind: "property", scope: "event", key: v.key, op };
  if (op === "contains" && typeof value !== "string") return null;
  if ((op === "gt" || op === "lt") && !(typeof value === "number" && Number.isFinite(value))) return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  return { kind: "property", scope: "event", key: v.key, op, value };
}

function parseTrigger(v: unknown): ReplayTrigger | null {
  if (!isRecord(v) || !isName(v.id)) return null;
  const rate = v.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) return null;
  const { id } = v;
  if (v.kind === "event") {
    if (!isName(v.event) || !Array.isArray(v.filters) || v.filters.length > MAX_TRIGGER_FILTERS) return null;
    const filters: ClientFilter[] = [];
    for (const raw of v.filters) {
      const filter = parseFilter(raw);
      // A filter the SDK cannot read would widen the trigger: the whole trigger is skipped.
      if (!filter) return null;
      filters.push(filter);
    }
    return { id, kind: "event", event: v.event, filters, rate };
  }
  if (v.kind === "url") {
    if (typeof v.pattern !== "string" || !v.pattern.startsWith("/")) return null;
    return { id, kind: "url", pattern: v.pattern, rate };
  }
  if (v.kind === "flag") {
    if (!isName(v.flag) || (v.variant !== null && !isName(v.variant))) return null;
    return { id, kind: "flag", flag: v.flag, variant: v.variant, rate };
  }
  return null;
}

/** The triggers of a `/replay/config` answer: invalid entries and duplicate ids skipped, at most 10. */
export function parseTriggers(value: unknown): ReplayTrigger[] {
  if (!Array.isArray(value)) return [];
  const out: ReplayTrigger[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (out.length >= MAX_REPLAY_TRIGGERS) break;
    const trigger = parseTrigger(raw);
    if (!trigger || ids.has(trigger.id)) continue;
    ids.add(trigger.id);
    out.push(trigger);
  }
  return out;
}
