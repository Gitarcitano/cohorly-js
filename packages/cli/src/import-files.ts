import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { UsageError } from "./usage-error.js";

// Input side of `cohorly import <source>`: which files to read and how to
// stream them. Source-agnostic, shared by every import source.

/** Extensions read from a directory, each also accepted with a trailing `.gz`. */
export const IMPORT_EXTENSIONS = [".json", ".jsonl", ".ndjson"] as const;
/** Suffix of the progress file written next to each input file. */
export const PROGRESS_SUFFIX = ".cohorly-import.json";

export function isProgressFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(PROGRESS_SUFFIX) || lower.endsWith(`${PROGRESS_SUFFIX}.tmp`);
}

export function isGzipFile(file: string): boolean {
  return file.toLowerCase().endsWith(".gz");
}

/** True for a name a directory import reads: a supported extension, optionally gzipped, never a progress file. */
export function isImportFileName(name: string): boolean {
  if (isProgressFile(name)) return false;
  const lower = name.toLowerCase();
  const base = lower.endsWith(".gz") ? lower.slice(0, -3) : lower;
  return IMPORT_EXTENSIONS.some((ext) => base.endsWith(ext));
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/**
 * The files to import from `target`: the file itself, or the supported files
 * directly inside a directory (not recursive), sorted by name (code point
 * order, so the order never depends on the locale).
 */
export async function listImportFiles(target: string): Promise<string[]> {
  const info = await statOrNull(target);
  if (!info) throw new UsageError(`no such file or directory: ${target}`);
  if (info.isFile()) {
    if (isProgressFile(path.basename(target))) {
      throw new UsageError(`${target} is a progress file of a previous import; pass the export file or its directory`);
    }
    return [target];
  }
  if (!info.isDirectory()) throw new UsageError(`not a file or directory: ${target}`);
  const names: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!isImportFileName(entry.name)) continue;
    if (entry.isFile()) names.push(entry.name);
    else if (entry.isSymbolicLink() && (await statOrNull(path.join(target, entry.name)))?.isFile()) names.push(entry.name);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length === 0) {
    throw new UsageError(
      `no file to import in ${target}: expected ${IMPORT_EXTENSIONS.join(", ")} files (optionally .gz)`,
    );
  }
  return names.map((name) => path.join(target, name));
}

export interface ImportLine {
  /** 1-based line number in the (decompressed) file. */
  line: number;
  text: string;
}

export interface LineStats {
  /** Number of the last line read so far, blank lines included. At the end: the file's line count. */
  lastLine: number;
}

/**
 * Streams the non-blank lines of `file`, gunzipping a `.gz` file on the fly.
 * Memory stays bounded by the longest line. Blank lines are skipped but keep
 * their number; CRLF endings and a leading UTF-8 BOM are removed.
 */
export async function* readLines(file: string, stats: LineStats = { lastLine: 0 }): AsyncGenerator<ImportLine> {
  const raw = createReadStream(file);
  let input: Readable = raw;
  if (isGzipFile(file)) {
    const gunzip = createGunzip();
    raw.on("error", (err) => gunzip.destroy(err));
    input = raw.pipe(gunzip);
  }
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let n = 0;
  try {
    for await (const rawText of rl) {
      n++;
      stats.lastLine = n;
      const text = n === 1 && rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
      if (text.trim() === "") continue;
      yield { line: n, text };
    }
  } finally {
    rl.close();
    input.destroy();
    raw.destroy();
  }
}
