import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { DEFAULT_API_URL } from "./defaults.js";
import { isGzipFile, listImportFiles, PROGRESS_SUFFIX, readLines } from "./import-files.js";
import {
  bodyBytes,
  hashValue,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_EVENTS,
  type ImportIo,
  MAX_PRINTED_LINES,
  PROGRESS_INTERVAL_MS,
  propNames,
  rejectReportOverwrite,
} from "./import-mixpanel.js";
import { postWithRetry } from "./import-sender.js";
import { UsageError } from "./usage-error.js";

// `cohorly import mixpanel-profiles`: a Mixpanel user profile export into
// POST /api/import/profiles, file by file, resumable from the progress file
// next to each input. Sibling of `import mixpanel` (import-mixpanel.ts): the
// files, the sender (retries, gzip) and the property transforms are shared.
//
// Input format (unverified against a real export; it follows Mixpanel's public
// profile query reference): `{ "results": [ { "$distinct_id", "$properties" } ],
// "page", "session_id", "status", "total" }`, where everything but `results`
// is ignored. A JSON array of profiles at the root, and one profile per line
// (JSONL), are read too. The format is detected from the content, by the first
// line alone: when it is a complete JSON value that is not an array, the file is
// JSONL and streams with constant memory (a line that is itself a page, the
// output of a pagination loop appended with `>>`, is flattened into its
// profiles); when it is a JSON array, or not complete JSON by itself (a
// pretty-printed document), the file is tried as one whole JSON document, whose
// memory is the size of the file. A file that is not a whole document after all
// (or is over WHOLE_MAX_BYTES on disk) is read as JSONL, where a line that does
// not parse counts as one invalid_profile without stopping the file.
//
// Progress unit: a profile, i.e. an element of `results` / the root array / a
// page line of a JSONL file, or a non-blank JSONL line (blank lines are not
// counted). `lastLine` in the
// progress file is how many units, in reading order, the server has confirmed
// (or that were refused locally, which is final).

// apps/server/src/routes/import.ts
export const IMPORT_PROFILES_PATH = "/api/import/profiles";
export const PROFILES_SOURCE = "mixpanel-profiles";
export const PROFILES_PROGRESS_VERSION = 1;
export const PROFILES_CSV_HEADER = "reason,read,applied,refused";
/** Ids that cannot be hashed or dropped: they link a profile to its events. */
const PROTECTED_PROPS = ["$distinct_id", "distinct_id"] as const;

export const LOCAL_PROFILE_REASONS = {
  invalidProfile: "invalid_profile",
  missingDistinctId: "missing_distinct_id",
  tooLarge: "profile_too_large",
} as const;

export interface ProfileLimits {
  maxProfiles: number;
  maxBytes: number;
}
export const DEFAULT_PROFILE_LIMITS: ProfileLimits = { maxProfiles: IMPORT_MAX_EVENTS, maxBytes: IMPORT_MAX_BYTES };

export const IMPORT_MIXPANEL_PROFILES_HELP = `Usage: cohorly import mixpanel-profiles --project <id> [options] <path>

Imports Mixpanel user profiles into a Cohorly project through
POST /api/import/profiles. <path> is one file, or a directory whose .json,
.jsonl and .ndjson files (each optionally .gz) are read in name order (not
recursive). A file is either a profile export page ({ "results": [ ... ] }), a
JSON array of profiles, or one profile per line; the format is detected from
the content: a file whose first line is a complete JSON value that is not an
array is read line by line (a line that is a page is read as its profiles, a
line that is not JSON counts as invalid_profile); any other file is read as one
JSON document, falling back to line by line when it is not one. Each profile is { "$distinct_id": ..., "$properties": { ... } }.

Each profile is sent as exported, with --drop-prop and --hash-prop applied to
its $properties. The server only fills what the profile lacks ($set_once): a
property Cohorly already has is not overwritten. There is no geo from the IP and
no $last_seen of the import time: $last_seen, $timezone and the rest enter as
exported. Importing a file again is safe.

Progress is saved after every confirmed batch in <file>.cohorly-import.json
next to each input file. Run the same command again to resume after the last
confirmed profile; a completed file is skipped.

Options:
  --project <id>              Project to import into (required)
  --token <token>             Superadmin key, or an organization API key allowed
                              to import (default: COHORLY_IMPORT_TOKEN)
  --api-url <url>             API base URL (default: COHORLY_API_URL or ${DEFAULT_API_URL})
  --drop-prop <name>          Remove this property from every profile (repeatable)
  --hash-prop <name>          Replace this property's value by its sha256 hex (repeatable);
                              a name passed to both is dropped
  --restart                   Ignore the saved progress and import from the first profile
  --report <file.csv>         Also write the report as CSV (not an input or progress file)
  -h, --help                  Show this help

$distinct_id and distinct_id cannot be dropped or hashed: they tie a profile to
its events.

Environment:
  COHORLY_IMPORT_TOKEN        Credential (or --token). A dashboard session token
                              expires after 15 minutes: use an API key
  COHORLY_API_URL             Cohorly API base URL (or --api-url)

Report (${PROFILES_CSV_HEADER}): one row per reason. An empty reason counts the
profiles the server applied; invalid_profile, missing_distinct_id and
profile_too_large are profiles the CLI did not send; any other reason is the
server's refusal.

Examples:
  cohorly import mixpanel-profiles --project 12 profiles.jsonl
  cohorly import mixpanel-profiles --project 12 --hash-prop '$email' --report profiles.csv exports/

Exit codes:
  0   every file was read to the end (refused profiles are in the report)
  1   the import stopped (progress is kept: run it again to resume) or a usage error
`;

interface ProfileCounts {
  read: number;
  applied: number;
  refused: number;
}
interface ProfileRow extends ProfileCounts {
  reason: string;
}
const COUNT_KEYS = ["read", "applied", "refused"] as const;

/** Counts per reason; an empty reason is the profiles the server applied. */
export class ProfileReport {
  private readonly rows = new Map<string, ProfileRow>();

  add(reason: string, counts: Partial<ProfileCounts>): void {
    let row = this.rows.get(reason);
    if (!row) {
      row = { reason, read: 0, applied: 0, refused: 0 };
      this.rows.set(reason, row);
    }
    for (const k of COUNT_KEYS) row[k] += counts[k] ?? 0;
  }

  applied(count = 1): void {
    this.add("", { read: count, applied: count });
  }

  refusal(reason: string, count = 1): void {
    this.add(reason, { read: count, refused: count });
  }

  merge(other: ProfileReport): void {
    for (const row of other.toRows()) this.add(row.reason, row);
  }

  totals(): ProfileCounts {
    const total: ProfileCounts = { read: 0, applied: 0, refused: 0 };
    for (const row of this.rows.values()) for (const k of COUNT_KEYS) total[k] += row[k];
    return total;
  }

  toRows(): ProfileRow[] {
    return [...this.rows.values()].map((r) => ({ ...r })).sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  }

  static fromRows(value: unknown): ProfileReport {
    if (!Array.isArray(value)) throw new Error("report is not an array");
    const report = new ProfileReport();
    for (const row of value) {
      if (!row || typeof row !== "object") throw new Error("report row is not an object");
      const r = row as Record<string, unknown>;
      if (typeof r.reason !== "string") throw new Error("report row without reason");
      const counts: Partial<ProfileCounts> = {};
      for (const k of COUNT_KEYS) {
        const n = r[k];
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error(`report row with an invalid ${k}`);
        counts[k] = n;
      }
      report.add(r.reason, counts);
    }
    return report;
  }
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function profileReportCsv(report: ProfileReport): string {
  const lines = [PROFILES_CSV_HEADER];
  for (const r of report.toRows()) lines.push([csvField(r.reason), r.read, r.applied, r.refused].join(","));
  const t = report.totals();
  lines.push(`total,${t.read},${t.applied},${t.refused}`);
  return `${lines.join("\n")}\n`;
}

export function renderProfileReport(report: ProfileReport): string {
  const t = report.totals();
  const table: string[][] = [
    ["reason", "read", "applied", "refused"],
    ...report.toRows().map((r) => [r.reason || "-", String(r.read), String(r.applied), String(r.refused)]),
    ["total", String(t.read), String(t.applied), String(t.refused)],
  ];
  const widths = table[0]!.map((_, col) => Math.max(...table.map((row) => row[col]!.length)));
  const lines = table.map((row) =>
    row
      .map((cell, col) => (col < 1 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!)))
      .join("  ")
      .trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}

interface ProfileProgress {
  lastLine: number;
  complete: boolean;
  report: ProfileReport;
}

const progressFile = (file: string) => `${file}${PROGRESS_SUFFIX}`;

async function loadProfileProgress(file: string, projectId: string, apiUrl: string): Promise<ProfileProgress | null> {
  const p = progressFile(file);
  let text: string;
  try {
    text = await readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const restart = "pass --restart to import the file from its first profile";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${p} is not valid JSON: ${restart}`);
  }
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (data.version !== PROFILES_PROGRESS_VERSION) {
    throw new Error(`${p} has an unknown version (${JSON.stringify(data.version)}): ${restart}`);
  }
  if (data.source !== PROFILES_SOURCE) {
    throw new UsageError(`${p} is the progress file of another kind of import, not of ${PROFILES_SOURCE}: ${restart}`);
  }
  if (data.projectId !== projectId) {
    throw new Error(`${p} records an import into project ${JSON.stringify(data.projectId)}, not ${projectId}: ${restart}`);
  }
  if (data.apiUrl !== apiUrl) {
    throw new Error(`${p} records an import into ${JSON.stringify(data.apiUrl)}, not ${apiUrl}: ${restart}`);
  }
  if (typeof data.lastLine !== "number" || !Number.isSafeInteger(data.lastLine) || data.lastLine < 0 || typeof data.complete !== "boolean") {
    throw new Error(`${p} is damaged: ${restart}`);
  }
  let report: ProfileReport;
  try {
    report = ProfileReport.fromRows(data.report);
  } catch (err) {
    throw new Error(`${p} has a damaged report (${err instanceof Error ? err.message : String(err)}): ${restart}`);
  }
  return { lastLine: data.lastLine, complete: data.complete, report };
}

async function saveProfileProgress(
  file: string,
  opts: { projectId: string; apiUrl: string },
  progress: { lastLine: number; complete: boolean; report: ProfileReport },
): Promise<void> {
  const p = progressFile(file);
  const content = {
    version: PROFILES_PROGRESS_VERSION,
    source: PROFILES_SOURCE,
    projectId: opts.projectId,
    apiUrl: opts.apiUrl,
    lastLine: progress.lastLine,
    complete: progress.complete,
    report: progress.report.toRows(),
  };
  const tmp = `${p}.tmp`;
  await writeFile(tmp, `${JSON.stringify(content)}\n`);
  await rename(tmp, p);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ProfileTransform {
  dropProps: ReadonlySet<string>;
  hashProps: ReadonlySet<string>;
}

type ProfileOutcome = { ok: true; json: string } | { ok: false; reason: string };

/**
 * The profile as it is sent, or the local reason it is not. `$distinct_id` is
 * never touched; a missing `$properties` is `{}`; `$properties` keys are
 * dropped or hashed, and a key the profile lacks is never created.
 */
export function transformProfile(value: unknown, transform: ProfileTransform): ProfileOutcome {
  if (!isPlainObject(value)) return { ok: false, reason: LOCAL_PROFILE_REASONS.invalidProfile };
  const id = value.$distinct_id;
  const validId = (typeof id === "string" && id !== "") || (typeof id === "number" && Number.isFinite(id));
  if (!validId) return { ok: false, reason: LOCAL_PROFILE_REASONS.missingDistinctId };
  const props = value.$properties;
  // null is "no properties", like the server reads it; any other non-object is not a profile.
  if (props !== undefined && props !== null && !isPlainObject(props)) return { ok: false, reason: LOCAL_PROFILE_REASONS.invalidProfile };
  const entries = Object.entries(props ?? {})
    .filter(([k]) => !transform.dropProps.has(k))
    .map(([k, v]): [string, unknown] => (transform.hashProps.has(k) ? [k, hashValue(v)] : [k, v]));
  // fromEntries defines own properties, so a "__proto__" key stays ordinary.
  return { ok: true, json: JSON.stringify({ $distinct_id: id, $properties: Object.fromEntries(entries) }) };
}

type RawUnit = { ok: true; value: unknown } | { ok: false };

// A pretty-printed page is bounded by Mixpanel's page size; a file past this on
// disk is a JSONL export whose first line happens to be garbage, so it streams.
const WHOLE_MAX_BYTES = 256 * 1024 * 1024;

function detectWhole(firstLine: string): boolean {
  try {
    return Array.isArray(JSON.parse(firstLine));
  } catch {
    // Not complete JSON by itself: the first line of a pretty-printed document,
    // or garbage (readWhole hands the file back to JSONL when it does not parse).
    return true;
  }
}

/**
 * The profiles of a file that is one JSON document, or null when the whole file
 * does not parse (the caller then reads it as JSONL).
 */
async function readWhole(file: string): Promise<unknown[] | null> {
  if ((await stat(file)).size > WHOLE_MAX_BYTES) return null;
  let buf = await readFile(file);
  if (isGzipFile(file)) buf = gunzipSync(buf);
  const text = buf.toString("utf8").replace(/^﻿/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  if (isPlainObject(parsed) && Array.isArray(parsed.results)) return parsed.results;
  if (isPlainObject(parsed) && Object.hasOwn(parsed, "$distinct_id")) return [parsed];
  throw new Error(`${file} holds no profiles: expected a "results" array, an array of profiles, or one profile per line`);
}

/** One JSONL line: a profile, a page `{ "results": [...] }` (flattened into its profiles) or an unreadable line. */
function jsonlUnits(text: string): RawUnit[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [{ ok: false }];
  }
  if (isPlainObject(value) && Array.isArray(value.results) && !Object.hasOwn(value, "$distinct_id")) {
    return value.results.map((v): RawUnit => ({ ok: true, value: v }));
  }
  return [{ ok: true, value }];
}

async function* readUnits(file: string): AsyncGenerator<RawUnit> {
  const probe = readLines(file);
  const first = await probe.next();
  await probe.return(undefined);
  if (first.done) return;
  if (detectWhole(first.value.text)) {
    const whole = await readWhole(file);
    if (whole) {
      for (const value of whole) yield { ok: true, value };
      return;
    }
  }
  for await (const l of readLines(file)) yield* jsonlUnits(l.text);
}

class ImportStopped extends Error {}

interface ProfilesResponse {
  received: number;
  applied: number;
  refused: { index: unknown; reason: string }[];
}

function readResponse(body: unknown, sent: number): ProfilesResponse | null {
  const b = body as Record<string, unknown>;
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!count(b.received) || !count(b.applied) || !Array.isArray(b.refused)) return null;
  const refused: ProfilesResponse["refused"] = [];
  for (const r of b.refused as unknown[]) {
    if (!isPlainObject(r) || typeof r.reason !== "string") return null;
    refused.push({ index: r.index, reason: r.reason });
  }
  if (b.received !== sent || (b.applied as number) + refused.length !== sent) return null;
  return { received: b.received as number, applied: b.applied as number, refused };
}

interface Options {
  projectId: string;
  apiUrl: string;
  url: string;
  token: string;
  transform: ProfileTransform;
  restart: boolean;
  limits: ProfileLimits;
}

interface Pending {
  ordinal: number;
  json?: string;
  reason?: string;
  bytes: number;
}

class Printer {
  private printed = 0;
  private lastProgress = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly io: ImportIo,
    private readonly now: () => number,
  ) {}

  issue(text: string): void {
    this.printed++;
    if (this.printed <= MAX_PRINTED_LINES) this.io.stderr(`${text}\n`);
    else if (this.printed === MAX_PRINTED_LINES + 1) this.io.stderr("more invalid or oversized profiles: they are counted in the report, not printed\n");
  }

  progress(file: string, report: ProfileReport, force = false): void {
    const t = this.now();
    if (!force && t - this.lastProgress < PROGRESS_INTERVAL_MS) return;
    this.lastProgress = t;
    const c = report.totals();
    this.io.stdout(`${file}: ${c.read} read, ${c.applied} applied, ${c.refused} refused\n`);
  }

  message(text: string): void {
    this.io.stdout(`${text}\n`);
  }
}

/** The report of the confirmed part of the current file, kept to report a stopped import. */
interface Confirmed {
  report: ProfileReport;
}

async function importFile(
  file: string,
  saved: ProfileProgress | null,
  opts: Options,
  io: ImportIo,
  out: Printer,
  confirmed: Confirmed,
): Promise<ProfileReport> {
  if (saved?.complete) {
    out.message(`${file}: already imported (${progressFile(file)}), skipped`);
    out.progress(file, saved.report, true);
    return saved.report;
  }
  const report = saved?.report ?? new ProfileReport();
  const resumeAfter = saved?.lastLine ?? 0;
  let lastLine = resumeAfter;
  out.message(resumeAfter > 0 ? `${file}: resuming after profile ${resumeAfter}` : `${file}: importing`);

  const save = async (complete: boolean) => {
    await saveProfileProgress(file, opts, { lastLine, complete, report });
    confirmed.report = ProfileReport.fromRows(report.toRows());
  };

  // Outcome of each profile of a sent list: "" when applied, else the refusal reason.
  const sendList = async (items: Pending[]): Promise<string[]> => {
    const body = Buffer.from(`[${items.map((e) => e.json).join(",")}]`, "utf8");
    const first = items[0]!.ordinal;
    const last = items[items.length - 1]!.ordinal;
    const range = first === last ? `profile ${first}` : `profiles ${first}-${last}`;
    const result = await postWithRetry({ url: opts.url, token: opts.token, body }, io, {
      onRetry: (n) => io.stderr(`${n.message}; retrying in ${n.delayMs / 1000}s (attempt ${n.attempt + 1})\n`),
    });
    if (result.kind === "too_large") {
      if (items.length === 1) {
        out.issue(`${file}: ${range}: the server refused the profile as too large (HTTP 413), not imported`);
        return [LOCAL_PROFILE_REASONS.tooLarge];
      }
      const mid = Math.ceil(items.length / 2);
      return [...(await sendList(items.slice(0, mid))), ...(await sendList(items.slice(mid)))];
    }
    if (result.kind === "failed") {
      if (result.reason === "auth") throw new ImportStopped(`the server refused the credential: ${result.message}`);
      if (result.reason === "bad_request") throw new ImportStopped(`the server refused the batch of ${file} ${range}: ${result.message}`);
      throw new ImportStopped(`${file} ${range}: ${result.message}; progress is saved up to profile ${lastLine}: run the same command again to resume`);
    }
    const res = readResponse(result.body, items.length);
    if (!res) throw new ImportStopped(`unexpected response to ${file} ${range}: ${JSON.stringify(result.body).slice(0, 300)}`);
    const reasons = new Map<number, string>();
    const unplaced: string[] = [];
    for (const r of res.refused) {
      const i = r.index;
      if (typeof i === "number" && Number.isInteger(i) && i >= 0 && i < items.length && !reasons.has(i)) reasons.set(i, r.reason);
      else unplaced.push(r.reason);
    }
    let applied = res.applied;
    return items.map((_, i) => {
      const reason = reasons.get(i);
      if (reason !== undefined) return reason;
      if (applied > 0) {
        applied--;
        return "";
      }
      return unplaced.shift() ?? "unknown";
    });
  };

  let pending: Pending[] = [];
  let sendable = 0;
  let sendableBytes = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    sendable = 0;
    sendableBytes = 0;
    const toSend = batch.filter((p) => p.json !== undefined);
    const outcomes = toSend.length > 0 ? await sendList(toSend) : [];
    let k = 0;
    for (const p of batch) {
      const reason = p.json === undefined ? p.reason! : outcomes[k++]!;
      if (reason === "") report.applied();
      else report.refusal(reason);
    }
    lastLine = batch[batch.length - 1]!.ordinal;
    await save(false);
    out.progress(file, report);
  };

  let ordinal = 0;
  for await (const unit of readUnits(file)) {
    ordinal++;
    if (ordinal <= resumeAfter) continue;
    const outcome = unit.ok ? transformProfile(unit.value, opts.transform) : { ok: false as const, reason: LOCAL_PROFILE_REASONS.invalidProfile };
    if (!outcome.ok) {
      out.issue(`${file}: profile ${ordinal}: ${outcome.reason}, not imported`);
      pending.push({ ordinal, reason: outcome.reason, bytes: 0 });
    } else {
      const bytes = Buffer.byteLength(outcome.json, "utf8");
      if (bodyBytes(1, bytes) > opts.limits.maxBytes) {
        out.issue(`${file}: profile ${ordinal}: ${bytes} bytes, above the ${opts.limits.maxBytes} byte batch limit, not imported`);
        pending.push({ ordinal, reason: LOCAL_PROFILE_REASONS.tooLarge, bytes: 0 });
      } else {
        if (sendable >= opts.limits.maxProfiles || bodyBytes(sendable + 1, sendableBytes + bytes) > opts.limits.maxBytes) await flush();
        pending.push({ ordinal, json: outcome.json, bytes });
        sendable++;
        sendableBytes += bytes;
      }
    }
    if (pending.length >= opts.limits.maxProfiles) await flush();
  }
  await flush();
  lastLine = Math.max(lastLine, ordinal);
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

function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

export async function importMixpanelProfiles(args: string[], io: ImportIo, limits: ProfileLimits = DEFAULT_PROFILE_LIMITS): Promise<number> {
  const { values, positionals } = parseOptions(args);
  if (values.help) {
    io.stdout(IMPORT_MIXPANEL_PROFILES_HELP);
    return 0;
  }
  const project = values.project?.trim();
  if (!project) throw new UsageError("missing required option --project");
  if (!/^[1-9]\d{0,9}$/.test(project) || Number(project) > 2_147_483_647) {
    throw new UsageError(`invalid --project: ${project} (expected the numeric project id)`);
  }
  if (positionals.length !== 1) throw new UsageError("expected exactly one path (an export file or a directory)");
  const hashProps = propNames(values["hash-prop"], "hash-prop");
  const dropProps = propNames(values["drop-prop"], "drop-prop");
  for (const [flag, names] of [["drop-prop", dropProps], ["hash-prop", hashProps]] as const) {
    for (const name of PROTECTED_PROPS) {
      if (names.has(name)) throw new UsageError(`--${flag} ${name} is not allowed: the id is what ties a profile to its events`);
    }
  }
  const files = await listImportFiles(positionals[0]!);
  const token = values.token ?? io.env.COHORLY_IMPORT_TOKEN;
  if (!token) throw new UsageError("missing import credential: set COHORLY_IMPORT_TOKEN or pass --token");
  const apiUrl = (values["api-url"] ?? io.env.COHORLY_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiUrl)) throw new UsageError(`invalid API URL: ${apiUrl}`);
  for (const name of dropProps) hashProps.delete(name);
  const opts: Options = {
    projectId: project,
    apiUrl,
    url: `${apiUrl}${IMPORT_PROFILES_PATH}?projectId=${project}`,
    token,
    transform: { dropProps, hashProps },
    restart: values.restart === true,
    limits,
  };

  if (values.report !== undefined) await rejectReportOverwrite(values.report, files);

  const saved = new Map<string, ProfileProgress | null>();
  for (const file of files) saved.set(file, opts.restart ? null : await loadProfileProgress(file, project, apiUrl));
  if (opts.restart) {
    for (const file of files) await saveProfileProgress(file, opts, { lastLine: 0, complete: false, report: new ProfileReport() });
  }

  const out = new Printer(io, io.now ?? Date.now);
  const total = new ProfileReport();
  let stopped: Error | null = null;
  for (const file of files) {
    const progress = saved.get(file) ?? null;
    const confirmed: Confirmed = { report: progress ? ProfileReport.fromRows(progress.report.toRows()) : new ProfileReport() };
    try {
      total.merge(await importFile(file, progress, opts, io, out, confirmed));
    } catch (err) {
      stopped = err instanceof Error ? err : new Error(String(err));
      total.merge(confirmed.report);
      break;
    }
  }

  io.stdout(`\n${stopped ? "Imported before the stop" : "Import report"}:\n${renderProfileReport(total)}`);
  if (values.report !== undefined) {
    await writeFile(values.report, profileReportCsv(total));
    io.stdout(`report written to ${values.report}\n`);
  }
  if (stopped) throw stopped;
  return 0;
}
