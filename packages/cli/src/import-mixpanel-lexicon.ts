import { readFile } from "node:fs/promises";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { DEFAULT_API_URL } from "./defaults.js";
import { postWithRetry, type SenderDeps } from "./import-sender.js";
import { UsageError } from "./usage-error.js";

// `cohorly import mixpanel-lexicon`: the schemas export of Mixpanel's Lexicon
// (names, descriptions, tags, hidden) into PUT /api/lexicon/:type/:name. It
// only fills what the Cohorly Lexicon has empty, unless --overwrite, and never
// sends governance fields (dropped, mergedInto, verified, reviewStatus).

export type LexiconType = "event" | "event_property" | "profile_property";

export interface MappedEntry {
  type: LexiconType;
  name: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  hidden?: boolean;
}

export interface MappedSchemas {
  entries: MappedEntry[];
  /** Schemas of a kind Cohorly has no Lexicon type for (groups, lookup tables, custom events, ...). */
  skippedUnsupported: number;
}

// Hypothesis, not checked against a real export: the body of Mixpanel's
// `GET /api/app/projects/{projectId}/schemas`, a list of
// `{ entityType, name, schemaJson }`, with `schemaJson.description` and
// `schemaJson.metadata["com.mixpanel"]` (`displayName`, `hidden`, `tags`),
// event properties under `schemaJson.properties[<prop>]` with the same two
// fields. All of it lives here so a different real format changes one function.
const MIXPANEL_METADATA_KEY = "com.mixpanel";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function fieldsOf(node: unknown): Omit<MappedEntry, "type" | "name"> {
  if (!isObject(node)) return {};
  const meta = isObject(node.metadata) && isObject(node.metadata[MIXPANEL_METADATA_KEY]) ? (node.metadata[MIXPANEL_METADATA_KEY] as Record<string, unknown>) : {};
  const out: Omit<MappedEntry, "type" | "name"> = {};
  const displayName = text(meta.displayName);
  if (displayName !== undefined) out.displayName = displayName;
  const description = text(node.description);
  if (description !== undefined) out.description = description;
  if (Array.isArray(meta.tags)) {
    const tags = [...new Set(meta.tags.map(text).filter((t): t is string => t !== undefined))];
    if (tags.length > 0) out.tags = tags;
  }
  if (typeof meta.hidden === "boolean") out.hidden = meta.hidden;
  return out;
}

function addEntry(entries: Map<string, MappedEntry>, type: LexiconType, name: string, fields: Omit<MappedEntry, "type" | "name">): void {
  const key = `${type}\u0000${name}`;
  // The same property under several events (a Cohorly event property is keyed
  // by name alone): the first value of each field wins.
  entries.set(key, { ...fields, ...entries.get(key), type, name });
}

/**
 * Pure: the Mixpanel schemas export (a bare array, or `{ results: [...] }`)
 * as one entry per Cohorly Lexicon name. `entityType` "event" gives the event
 * and each property under `schemaJson.properties`; "profile" gives each
 * property of the user profile. Anything else is counted in
 * `skippedUnsupported`. Missing fields are tolerated; a field with no value is
 * left out, never emptied.
 */
export function mapMixpanelSchemas(json: unknown): MappedSchemas {
  const list = Array.isArray(json) ? json : isObject(json) && Array.isArray(json.results) ? json.results : null;
  if (!list) throw new UsageError("the schemas file is not a list of schemas (expected a JSON array or an object with a results array)");
  const entries = new Map<string, MappedEntry>();
  let skippedUnsupported = 0;
  for (const item of list) {
    if (!isObject(item)) {
      skippedUnsupported++;
      continue;
    }
    const kind = typeof item.entityType === "string" ? item.entityType.toLowerCase() : "";
    const name = typeof item.name === "string" ? item.name : "";
    const schema = isObject(item.schemaJson) ? item.schemaJson : {};
    if (kind === "event" && name !== "") {
      addEntry(entries, "event", name, fieldsOf(schema));
      if (isObject(schema.properties)) {
        for (const [prop, node] of Object.entries(schema.properties)) {
          if (prop !== "") addEntry(entries, "event_property", prop, fieldsOf(node));
        }
      }
    } else if (kind === "profile" && isObject(schema.properties)) {
      for (const [prop, node] of Object.entries(schema.properties)) {
        if (prop !== "") addEntry(entries, "profile_property", prop, fieldsOf(node));
      }
    } else if (kind === "profile" && name !== "") {
      addEntry(entries, "profile_property", name, fieldsOf(schema));
    } else {
      skippedUnsupported++;
    }
  }
  // An entry Mixpanel documented nothing for (or only marked `hidden: false`,
  // which is the default) has nothing to import: it is not an entry of the summary.
  const documented = [...entries.values()].filter((e) => Object.entries(e).some(([field, value]) => field !== "type" && field !== "name" && value !== false));
  return { entries: documented, skippedUnsupported };
}

export interface CurrentEntry {
  display_name: string | null;
  description: string | null;
  tags: string[];
  hidden: boolean;
}

export type LexiconBody = Pick<MappedEntry, "displayName" | "description" | "tags" | "hidden">;

/**
 * The fields to send for one entry, or null when there is nothing to send.
 * Without `overwrite`, a field the Cohorly entry already has stays as it is;
 * a field the Mixpanel entry has no value for is never sent.
 */
export function planPut(entry: MappedEntry, current: CurrentEntry | undefined, overwrite: boolean): LexiconBody | null {
  const body: LexiconBody = {};
  if (entry.displayName !== undefined && (overwrite || !current?.display_name)) body.displayName = entry.displayName;
  if (entry.description !== undefined && (overwrite || !current?.description)) body.description = entry.description;
  if (entry.tags !== undefined && (overwrite || !current || current.tags.length === 0)) body.tags = entry.tags;
  // `hidden: true` fills an entry that is not hidden yet; an explicit
  // `hidden: false` only ever replaces a hidden entry, and only with --overwrite.
  if (entry.hidden === true && (overwrite || !current?.hidden)) body.hidden = true;
  if (entry.hidden === false && overwrite && current?.hidden) body.hidden = false;
  if (Object.keys(body).length === 0) return null;
  if (current && sameFields(body, current)) return null;
  return body;
}

function sameFields(body: LexiconBody, current: CurrentEntry): boolean {
  return (
    (body.displayName === undefined || body.displayName === current.display_name) &&
    (body.description === undefined || body.description === current.description) &&
    (body.tags === undefined || (body.tags.length === current.tags.length && body.tags.every((t, i) => t === current.tags[i]))) &&
    (body.hidden === undefined || body.hidden === current.hidden)
  );
}

export interface LexiconSummary {
  created: number;
  updated: number;
  alreadyFilled: number;
  unsupported: number;
  failed: number;
}

export function renderLexiconSummary(s: LexiconSummary, dryRun: boolean): string {
  const tense = dryRun ? " (would be)" : "";
  return [
    `Lexicon import${dryRun ? " (dry run, nothing written)" : ""}:`,
    `  created, new Lexicon entry${tense}: ${s.created}`,
    `  updated, existing entry${tense}: ${s.updated}`,
    `  skipped, already filled: ${s.alreadyFilled}`,
    `  skipped, unsupported type: ${s.unsupported}`,
    `  failed: ${s.failed}`,
    "",
  ].join("\n");
}

export const IMPORT_MIXPANEL_LEXICON_HELP = `Usage: cohorly import mixpanel-lexicon --project <id> [options] <schemas.json>

Imports names, descriptions, tags and hidden from the Lexicon export of Mixpanel
(the JSON of its schemas API) into the Lexicon of a Cohorly project, one
PUT /api/lexicon/:type/:name per event, event property and profile property.
<schemas.json> is a JSON array of schemas, or an object with a results array.

A field the Cohorly Lexicon already has is not overwritten (--overwrite changes
that). A field Mixpanel has no value for is never cleared. dropped, mergedInto
and verified are never written. Group, lookup table, custom event and calculated
property schemas are skipped and counted.

Options:
  --project <id>              Project to import into (required)
  --token <token>             Organization API key with the import scope, or the
                              superadmin key (default: COHORLY_IMPORT_TOKEN)
  --api-url <url>             API base URL (default: COHORLY_API_URL or ${DEFAULT_API_URL})
  --overwrite                 Replace fields the Cohorly Lexicon already has
  --dry-run                   Print what would change and write nothing
  -h, --help                  Show this help

Environment:
  COHORLY_IMPORT_TOKEN        Credential (or --token). The key's creator must be an
                              organization owner
  COHORLY_API_URL             Cohorly API base URL (or --api-url)

Summary: created, updated, skipped because already filled, skipped because the
type is unsupported, failed.

Examples:
  cohorly import mixpanel-lexicon --project 12 schemas.json
  cohorly import mixpanel-lexicon --project 12 --dry-run --overwrite schemas.json

Exit codes:
  0   every entry was handled
  1   at least one entry failed, the credential was refused, or a usage error
`;

export interface LexiconIo extends SenderDeps {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const OPTIONS = {
  project: { type: "string" },
  token: { type: "string" },
  "api-url": { type: "string" },
  overwrite: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

async function readSchemas(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`${file} is not valid JSON`);
  }
}

const key = (type: string, name: string) => `${type}\u0000${name}`;

interface ServerEntry extends CurrentEntry {
  entity_type: string;
  name: string;
}

export async function importMixpanelLexicon(args: string[], io: LexiconIo): Promise<number> {
  const { values, positionals } = parseOptions(args);
  if (values.help) {
    io.stdout(IMPORT_MIXPANEL_LEXICON_HELP);
    return 0;
  }
  const project = values.project?.trim();
  if (!project) throw new UsageError("missing required option --project");
  if (!/^[1-9]\d{0,9}$/.test(project) || Number(project) > 2_147_483_647) {
    throw new UsageError(`invalid --project: ${project} (expected the numeric project id)`);
  }
  if (positionals.length !== 1) throw new UsageError("expected exactly one path (the Mixpanel schemas JSON file)");
  const token = values.token ?? io.env.COHORLY_IMPORT_TOKEN;
  if (!token) throw new UsageError("missing import credential: set COHORLY_IMPORT_TOKEN or pass --token");
  const apiUrl = (values["api-url"] ?? io.env.COHORLY_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiUrl)) throw new UsageError(`invalid API URL: ${apiUrl}`);
  const overwrite = values.overwrite === true;
  const dryRun = values["dry-run"] === true;

  const { entries, skippedUnsupported } = mapMixpanelSchemas(await readSchemas(positionals[0]!));
  const onRetry = (n: { message: string; delayMs: number; attempt: number }) =>
    io.stderr(`${n.message}; retrying in ${n.delayMs / 1000}s (attempt ${n.attempt + 1})\n`);

  const read = await postWithRetry({ url: `${apiUrl}/api/lexicon?projectId=${project}`, token, method: "GET", expectStatusOne: false }, io, { onRetry });
  if (read.kind !== "ok" || !Array.isArray(read.body)) {
    const why = read.kind === "failed" ? read.message : read.kind === "too_large" ? "HTTP 413" : "the answer is not a list of entries";
    throw new Error(`cannot read the current Lexicon: ${why}`);
  }
  const current = new Map<string, ServerEntry>();
  for (const e of read.body as ServerEntry[]) current.set(key(e.entity_type, e.name), { ...e, tags: Array.isArray(e.tags) ? e.tags : [] });

  const summary: LexiconSummary = { created: 0, updated: 0, alreadyFilled: 0, unsupported: skippedUnsupported, failed: 0 };
  for (const entry of entries) {
    const existing = current.get(key(entry.type, entry.name));
    const body = planPut(entry, existing, overwrite);
    const label = `${entry.type} ${entry.name}`;
    if (entry.name === "." || entry.name === "..") {
      summary.failed++;
      io.stderr(`${label}: a name of "." or ".." cannot be sent in a URL path\n`);
      continue;
    }
    if (!body) {
      summary.alreadyFilled++;
      continue;
    }
    if (dryRun) {
      io.stdout(`${existing ? "update" : "create"} ${label}: ${JSON.stringify(body)}\n`);
      if (existing) summary.updated++;
      else summary.created++;
      continue;
    }
    const url = `${apiUrl}/api/lexicon/${entry.type}/${encodeURIComponent(entry.name)}?projectId=${project}`;
    const res = await postWithRetry({ url, token, method: "PUT", gzip: false, expectStatusOne: false, body: Buffer.from(JSON.stringify(body), "utf8") }, io, { onRetry });
    if (res.kind === "ok") {
      if (existing) summary.updated++;
      else summary.created++;
      continue;
    }
    const message = res.kind === "failed" ? res.message : "HTTP 413";
    if (res.kind === "failed" && res.reason === "auth") {
      io.stdout(`\n${renderLexiconSummary(summary, dryRun)}`);
      throw new Error(`the server refused the credential: ${message}`);
    }
    summary.failed++;
    io.stderr(`${label}: ${message}\n`);
  }

  io.stdout(`\n${renderLexiconSummary(summary, dryRun)}`);
  return summary.failed > 0 ? 1 : 0;
}
