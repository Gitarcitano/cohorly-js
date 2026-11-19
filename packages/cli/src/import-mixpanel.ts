import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { DEFAULT_API_URL } from "./defaults.js";
import { listImportFiles, readLines } from "./import-files.js";
import { type LoadedProgress, loadProgress, progressPath, saveProgress } from "./import-progress.js";
import { ImportReport, type ReportRow, renderReport, reportCsv, UNKNOWN_DAY } from "./import-report.js";
import { postWithRetry, type SenderDeps } from "./import-sender.js";
import { UsageError } from "./usage-error.js";

// `cohorly import mixpanel`: a raw Mixpanel event export (one JSON event per
// line) into POST /api/import/events, streamed file by file with constant
// memory, resumable from the progress file next to each input.

// Copied from apps/server/src/import.ts (the CLI never imports the server).
// Below this, a numeric `time` is in seconds and the server refuses it as
// `time_in_seconds`: the CLI converts it to ms first.
export const SECONDS_THRESHOLD_MS = 100_000_000_000;
// Copied from apps/server/src/import.ts: IMPORT_MAX_EVENTS and
// IMPORT_MAX_DECOMPRESSED_BYTES (the wire limit is the same 8 MiB).
export const IMPORT_MAX_EVENTS = 5000;
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
// Copied from apps/server/src/import.ts: IMPORT_MAX_NEW_PARTITIONS. The server
// creates at most this many monthly partitions per batch and refuses events of
// further new months as `too_many_months`.
export const IMPORT_MAX_NEW_PARTITIONS = 3;
// apps/server/src/routes/import.ts
export const IMPORT_EVENTS_PATH = "/api/import/events";

/** Local refusal reasons: lines that never reach the server. */
export const LOCAL_REASONS = { invalidJson: "invalid_json", eventTooLarge: "event_too_large" } as const;
/** Individual invalid or oversized lines printed per run; the rest only reach the report. */
export const MAX_PRINTED_LINES = 20;
/** Progress lines are printed at most this often. */
export const PROGRESS_INTERVAL_MS = 1000;
// Largest ms value a Date can hold.
const MAX_DATE_MS = 8.64e15;

export const IMPORT_MIXPANEL_HELP = `Usage: cohorly import mixpanel --project <id> [options] <path>

Imports a raw Mixpanel event export (one JSON event per line) into a Cohorly
project through POST /api/import/events. <path> is one export file, or a
directory whose .json, .jsonl and .ndjson files (each optionally .gz) are read
in name order (not recursive).

Each event is sent as exported, with these changes only:
  - properties.time in seconds becomes milliseconds
  - mp_lib is copied to $lib when the event has no $lib
  - --drop-prop and --hash-prop, applied after that copy
$insert_id is never added or changed, so importing a file again is safe: the
server counts its events as duplicates. History is stored without identity
links. Events older than the organization's retention are refused
(older_than_retention).

Progress is saved after every confirmed batch in <file>.cohorly-import.json
next to each input file. Run the same command again to resume after the last
confirmed line; a completed file is skipped.

A batch holds at most ${IMPORT_MAX_NEW_PARTITIONS} UTC months of events (the server creates at most ${IMPORT_MAX_NEW_PARTITIONS} new
monthly partitions per request and refuses the events of further new months as
too_many_months), so the CLI starts a new batch when an event would open one
more month. A file sorted by time is sent in few, large batches.

Options:
  --project <id>              Project to import into (required)
  --token <token>             Superadmin key, or an organization API key allowed
                              to import (default: COHORLY_IMPORT_TOKEN)
  --api-url <url>             API base URL (default: COHORLY_API_URL or ${DEFAULT_API_URL})
  --drop-prop <name>          Remove this property from every event (repeatable)
  --hash-prop <name>          Replace this property's value by its sha256 hex (repeatable);
                              a name passed to both is dropped
  --restart                   Ignore the saved progress and import from the first line
  --report <file.csv>         Also write the report as CSV (not an input or progress file)
  -h, --help                  Show this help

Environment:
  COHORLY_IMPORT_TOKEN        Credential (or --token). A dashboard session token
                              expires after 15 minutes: use an API key
  COHORLY_API_URL             Cohorly API base URL (or --api-url)

Report: one row per (UTC day of the event, reason). An empty reason counts the
events the server accepted (inserted or duplicates); invalid_json and
event_too_large are lines the CLI did not send; any other reason is the
server's refusal.

Examples:
  cohorly import mixpanel --project 12 export.jsonl
  cohorly import mixpanel --project 12 --hash-prop email --drop-prop ip --report import.csv exports/

Exit codes:
  0   every file was read to the end (refused events are in the report)
  1   the import stopped (progress is kept: run it again to resume) or a usage error
`;

export interface ImportIo extends SenderDeps {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now?: () => number;
}

export interface TransformOptions {
  dropProps: ReadonlySet<string>;
  hashProps: ReadonlySet<string>;
}

// Mirrors the server's checks exactly: only a positive safe integer below the
// threshold is `time_in_seconds` there. A float, zero, a negative or a
// non-number would be `invalid_time` and passes untouched. x * 1000 stays a
// safe integer (below 1e14), so the conversion is exact.
export function toMilliseconds(time: unknown): unknown {
  if (typeof time === "number" && Number.isSafeInteger(time) && time > 0 && time < SECONDS_THRESHOLD_MS) return time * 1000;
  return time;
}

/** sha256 hex of the value as text; null and undefined stay as they are. */
export function hashValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const text =
    typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The event as it is sent. Pure and deterministic: the same input always
 * gives the same output, key order included. Anything that is not an object
 * with an object `properties` is returned as it is (the server refuses it).
 */
export function transformEvent(event: unknown, options: TransformOptions): unknown {
  if (!isPlainObject(event) || !isPlainObject(event.properties)) return event;
  const props = event.properties;
  const entries: [string, unknown][] = Object.entries(props).map(([k, v]) => [k, k === "time" ? toMilliseconds(v) : v]);
  if (!Object.hasOwn(props, "$lib") && Object.hasOwn(props, "mp_lib")) entries.push(["$lib", props.mp_lib]);
  const out = entries
    .filter(([k]) => !options.dropProps.has(k))
    .map(([k, v]): [string, unknown] => (options.hashProps.has(k) ? [k, hashValue(v)] : [k, v]));
  // Object.fromEntries and spread define own properties, so even a
  // "__proto__" key stays an ordinary property.
  return { ...event, properties: Object.fromEntries(out) };
}

/** UTC day (YYYY-MM-DD) of a transformed event's `properties.time`, or "unknown". */
export function eventDay(event: unknown): string {
  if (!isPlainObject(event) || !isPlainObject(event.properties)) return UNKNOWN_DAY;
  const time = event.properties.time;
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0 || time > MAX_DATE_MS) return UNKNOWN_DAY;
  return new Date(time).toISOString().slice(0, 10);
}

/** UTC month (YYYY-MM) of a day from `eventDay`, or null when the day is unknown. */
export function monthOf(day: string): string | null {
  return day === UNKNOWN_DAY ? null : day.slice(0, 7);
}

/** Bytes of a serialized body holding `count` events of `sum` bytes: brackets and commas. */
export function bodyBytes(count: number, sum: number): number {
  return 2 + sum + Math.max(0, count - 1);
}

interface PendingEvent {
  line: number;
  json: string;
  day: string;
}

interface LocalRefusal {
  line: number;
  day: string;
  reason: string;
}

interface Options {
  projectId: string;
  /** API base URL without trailing slashes: recorded in the progress files. */
  apiUrl: string;
  url: string;
  token: string;
  transform: TransformOptions;
  restart: boolean;
}

class ImportStopped extends Error {}

interface ImportResponse {
  received: number;
  inserted: number;
  duplicates: number;
  refused: { index: unknown; reason: string }[];
}

function readResponse(body: unknown, sent: number): ImportResponse | null {
  const b = body as Record<string, unknown>;
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!count(b.received) || !count(b.inserted) || !count(b.duplicates) || !Array.isArray(b.refused)) return null;
  const refused: ImportResponse["refused"] = [];
  for (const r of b.refused as unknown[]) {
    if (!isPlainObject(r) || typeof r.reason !== "string") return null;
    refused.push({ index: r.index, reason: r.reason });
  }
  const res = { received: b.received as number, inserted: b.inserted as number, duplicates: b.duplicates as number, refused };
  if (res.received !== sent || res.inserted + res.duplicates + refused.length !== sent) return null;
  return res;
}

class Printer {
  private printed = 0;
  private lastProgress = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly io: ImportIo,
    private readonly now: () => number,
  ) {}

  lineIssue(text: string): void {
    this.printed++;
    if (this.printed <= MAX_PRINTED_LINES) this.io.stderr(`${text}\n`);
    else if (this.printed === MAX_PRINTED_LINES + 1) {
      this.io.stderr(`more invalid or oversized lines: they are counted in the report, not printed\n`);
    }
  }

  progress(file: string, report: ImportReport, force = false): void {
    const t = this.now();
    if (!force && t - this.lastProgress < PROGRESS_INTERVAL_MS) return;
    this.lastProgress = t;
    const c = report.totals();
    this.io.stdout(`${file}: ${c.read} read, ${c.inserted} inserted, ${c.duplicates} duplicates, ${c.refused} refused\n`);
  }

  message(text: string): void {
    this.io.stdout(`${text}\n`);
  }
}

/** What the progress file of the current file holds, kept to report a stopped import. */
interface Confirmed {
  rows: ReportRow[];
}

async function importFile(
  file: string,
  saved: LoadedProgress | null,
  opts: Options,
  io: ImportIo,
  out: Printer,
  confirmed: Confirmed,
): Promise<ImportReport> {
  if (saved?.complete) {
    out.message(`${file}: already imported (${progressPath(file)}), skipped`);
    out.progress(file, saved.report, true);
    return saved.report;
  }
  const report = saved?.report ?? new ImportReport();
  const resumeAfter = saved?.lastLine ?? 0;
  // Last line whose effect is confirmed: what the progress file records.
  let lastLine = resumeAfter;
  out.message(resumeAfter > 0 ? `${file}: resuming after line ${resumeAfter}` : `${file}: importing`);

  let savedLine = resumeAfter;
  const save = async (complete: boolean) => {
    const rows = report.toRows();
    await saveProgress(file, { projectId: opts.projectId, apiUrl: opts.apiUrl, lastLine, complete, report: rows });
    savedLine = lastLine;
    confirmed.rows = rows;
  };

  // The open segment: events not confirmed yet and the local refusals read
  // after the first of them. Bounded: at most IMPORT_MAX_EVENTS events of
  // IMPORT_MAX_BYTES, and IMPORT_MAX_EVENTS local refusals.
  let events: PendingEvent[] = [];
  let eventBytes = 0;
  // Distinct UTC months (YYYY-MM) of the open events.
  let months = new Set<string>();
  let locals: LocalRefusal[] = [];
  // Every line before the one being handled has been read and assigned.
  let readThrough = resumeAfter;

  const foldLocals = (before: number) => {
    const keep: LocalRefusal[] = [];
    for (const l of locals) {
      if (l.line < before) report.refusal(l.day, l.reason);
      else keep.push(l);
    }
    locals = keep;
  };

  const localRefusal = (r: LocalRefusal) => {
    if (events.length === 0) {
      // Nothing unconfirmed before it: its effect is final.
      report.refusal(r.day, r.reason);
      lastLine = r.line;
    } else {
      locals.push(r);
    }
  };

  const applyResponse = (batch: PendingEvent[], res: ImportResponse) => {
    const reasons = new Map<number, string>();
    const unplaced: string[] = [];
    for (const r of res.refused) {
      const i = r.index;
      if (typeof i === "number" && Number.isInteger(i) && i >= 0 && i < batch.length && !reasons.has(i)) reasons.set(i, r.reason);
      else unplaced.push(r.reason);
    }
    // The server reports inserted and duplicates per batch, not per event:
    // the duplicates are counted on the first accepted events. Exact per day
    // unless one batch has both.
    let duplicates = res.duplicates;
    let inserted = res.inserted;
    batch.forEach((ev, i) => {
      const reason = reasons.get(i);
      if (reason !== undefined) report.refusal(ev.day, reason);
      else if (duplicates > 0) {
        duplicates--;
        report.accepted(ev.day, 0, 1);
      } else if (inserted > 0) {
        inserted--;
        report.accepted(ev.day, 1, 0);
      } else {
        // A refusal whose index is outside the batch: its event is unknown.
        report.refusal(UNKNOWN_DAY, unplaced.shift() ?? "unknown");
      }
    });
  };

  const send = async (batch: PendingEvent[], endsSegment: boolean): Promise<void> => {
    const first = batch[0]!;
    const last = batch[batch.length - 1]!;
    const body = Buffer.from(`[${batch.map((e) => e.json).join(",")}]`, "utf8");
    const result = await postWithRetry({ url: opts.url, token: opts.token, body }, io, {
      onRetry: (n) => io.stderr(`${n.message}; retrying in ${n.delayMs / 1000}s (attempt ${n.attempt + 1})\n`),
    });
    if (result.kind === "too_large") {
      if (batch.length === 1) {
        out.lineIssue(`${file}:${first.line}: the server refused the event as too large (HTTP 413), not imported`);
        foldLocals(first.line);
        report.refusal(first.day, LOCAL_REASONS.eventTooLarge);
      } else {
        const mid = Math.ceil(batch.length / 2);
        await send(batch.slice(0, mid), false);
        await send(batch.slice(mid), endsSegment);
        return;
      }
    } else if (result.kind === "failed") {
      const lines = first.line === last.line ? `line ${first.line}` : `lines ${first.line}-${last.line}`;
      const resume = `progress is saved up to line ${savedLine}: run the same command again to resume`;
      if (result.reason === "auth") throw new ImportStopped(`the server refused the credential: ${result.message}`);
      if (result.reason === "bad_request") throw new ImportStopped(`the server refused the batch of ${file} ${lines}: ${result.message}`);
      throw new ImportStopped(`${file} ${lines}: ${result.message}; ${resume}`);
    } else {
      const res = readResponse(result.body, batch.length);
      if (!res) {
        throw new ImportStopped(`unexpected response to ${file} lines ${first.line}-${last.line}: ${JSON.stringify(result.body).slice(0, 300)}`);
      }
      foldLocals(last.line);
      applyResponse(batch, res);
    }
    lastLine = last.line;
    if (endsSegment) {
      // Only lines already read and assigned remain after the batch.
      foldLocals(Number.POSITIVE_INFINITY);
      lastLine = Math.max(lastLine, readThrough);
    }
    await save(false);
    out.progress(file, report);
  };

  const flush = async () => {
    if (events.length === 0) return;
    const batch = events;
    events = [];
    eventBytes = 0;
    months = new Set();
    await send(batch, true);
  };

  const stats = { lastLine: 0 };
  for await (const { line, text } of readLines(file, stats)) {
    if (line <= resumeAfter) continue;
    readThrough = line - 1;
    let transformed: unknown;
    let json: string;
    try {
      transformed = transformEvent(JSON.parse(text), opts.transform);
      json = JSON.stringify(transformed);
    } catch {
      out.lineIssue(`${file}:${line}: invalid JSON, not imported`);
      localRefusal({ line, day: UNKNOWN_DAY, reason: LOCAL_REASONS.invalidJson });
      if (locals.length >= IMPORT_MAX_EVENTS) {
        readThrough = line;
        await flush();
      }
      continue;
    }
    const day = eventDay(transformed);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bodyBytes(1, bytes) > IMPORT_MAX_BYTES) {
      out.lineIssue(`${file}:${line}: event is ${bytes} bytes, above the ${IMPORT_MAX_BYTES} byte batch limit, not imported`);
      localRefusal({ line, day, reason: LOCAL_REASONS.eventTooLarge });
      if (locals.length >= IMPORT_MAX_EVENTS) {
        readThrough = line;
        await flush();
      }
      continue;
    }
    // A batch never spans more than IMPORT_MAX_NEW_PARTITIONS UTC months: the
    // CLI cannot know which months already have a partition, and this keeps
    // the server from refusing any of them as too_many_months.
    const month = monthOf(day);
    const opensNewMonth = month !== null && !months.has(month) && months.size >= IMPORT_MAX_NEW_PARTITIONS;
    if (events.length >= IMPORT_MAX_EVENTS || bodyBytes(events.length + 1, eventBytes + bytes) > IMPORT_MAX_BYTES || opensNewMonth) await flush();
    // Local refusals read before this event no longer wait on another one.
    if (events.length === 0) {
      foldLocals(Number.POSITIVE_INFINITY);
      lastLine = Math.max(lastLine, readThrough);
    }
    events.push({ line, json, day });
    eventBytes += bytes;
    if (month !== null) months.add(month);
  }
  readThrough = Math.max(stats.lastLine, resumeAfter);
  await flush();
  foldLocals(Number.POSITIVE_INFINITY);
  lastLine = readThrough;
  await save(true);
  out.progress(file, report, true);
  return report;
}

const OPTIONS = {
  project: { type: "string" },
  token: { type: "string" },
  "api-url": { type: "string" },
  "drop-prop": { type: "string", multiple: true },
  "hash-prop": { type: "string", multiple: true },
  restart: { type: "boolean" },
  report: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

export function propNames(values: string[] | undefined, flag: string): Set<string> {
  const names = new Set<string>();
  for (const v of values ?? []) {
    if (v === "") throw new UsageError(`--${flag} needs a property name`);
    names.add(v);
  }
  return names;
}

function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

async function canonicalPath(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return await realpath(resolved);
  } catch {
    // Not there yet: its directory may still be a link to somewhere else.
    try {
      return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

export async function rejectReportOverwrite(report: string, files: string[]): Promise<void> {
  const target = await canonicalPath(report);
  for (const file of files) {
    for (const protectedPath of [file, progressPath(file), `${progressPath(file)}.tmp`]) {
      if (target === (await canonicalPath(protectedPath))) {
        throw new UsageError(`--report ${report} would overwrite ${protectedPath}: choose another file`);
      }
    }
  }
}

export async function importMixpanel(args: string[], io: ImportIo): Promise<number> {
  const { values, positionals } = parseOptions(args);
  if (values.help) {
    io.stdout(IMPORT_MIXPANEL_HELP);
    return 0;
  }
  const project = values.project?.trim();
  if (!project) throw new UsageError("missing required option --project");
  // Same rule as the route (routes/import.ts): a positive 32-bit integer id.
  if (!/^[1-9]\d{0,9}$/.test(project) || Number(project) > 2_147_483_647) {
    throw new UsageError(`invalid --project: ${project} (expected the numeric project id)`);
  }
  if (positionals.length !== 1) throw new UsageError("expected exactly one path (an export file or a directory)");
  const files = await listImportFiles(positionals[0]!);
  const token = values.token ?? io.env.COHORLY_IMPORT_TOKEN;
  if (!token) throw new UsageError("missing import credential: set COHORLY_IMPORT_TOKEN or pass --token");
  const apiUrl = values["api-url"] ?? io.env.COHORLY_API_URL ?? DEFAULT_API_URL;
  if (!/^https?:\/\//.test(apiUrl)) throw new UsageError(`invalid API URL: ${apiUrl}`);

  const hashProps = propNames(values["hash-prop"], "hash-prop");
  const dropProps = propNames(values["drop-prop"], "drop-prop");
  // $insert_id is what makes importing the same file twice a no-op: changing it
  // would store the events a second time.
  for (const [flag, names] of [["drop-prop", dropProps], ["hash-prop", hashProps]] as const) {
    if (names.has("$insert_id")) throw new UsageError(`--${flag} $insert_id is not allowed: it is what keeps a repeated import from duplicating events`);
  }
  for (const name of dropProps) hashProps.delete(name);
  const opts: Options = {
    projectId: project,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    url: `${apiUrl.replace(/\/+$/, "")}${IMPORT_EVENTS_PATH}?projectId=${project}`,
    token,
    transform: { dropProps, hashProps },
    restart: values.restart === true,
  };

  // The CSV is written at the end, even when the import stopped early: it must
  // never land on an input (the history would be lost) or on a progress file.
  if (values.report !== undefined) await rejectReportOverwrite(values.report, files);

  // Every progress file is checked before anything is sent.
  const saved = new Map<string, LoadedProgress | null>();
  for (const file of files) saved.set(file, opts.restart ? null : await loadProgress(file, project, opts.apiUrl));
  // --restart empties every checkpoint before anything is sent, so a restart that
  // stops early never leaves an old "complete" behind for the next plain run.
  if (opts.restart) {
    for (const file of files) await saveProgress(file, { projectId: project, apiUrl: opts.apiUrl, lastLine: 0, complete: false, report: [] });
  }

  const out = new Printer(io, io.now ?? Date.now);
  const total = new ImportReport();
  let stopped: Error | null = null;
  for (const file of files) {
    const progress = saved.get(file) ?? null;
    const confirmed: Confirmed = { rows: progress?.report.toRows() ?? [] };
    try {
      total.merge(await importFile(file, progress, opts, io, out, confirmed));
    } catch (err) {
      stopped = err instanceof Error ? err : new Error(String(err));
      // The confirmed part of the file: what its progress file holds.
      total.merge(ImportReport.fromRows(confirmed.rows));
      break;
    }
  }

  io.stdout(`\n${stopped ? "Imported before the stop" : "Import report"}:\n${renderReport(total)}`);
  if (values.report !== undefined) {
    await writeFile(values.report, reportCsv(total));
    io.stdout(`report written to ${values.report}\n`);
  }
  if (stopped) throw stopped;
  return 0;
}
