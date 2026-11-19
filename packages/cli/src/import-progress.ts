import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROGRESS_SUFFIX } from "./import-files.js";
import { ImportReport, type ReportRow } from "./import-report.js";

// The progress file `<input>.cohorly-import.json`, next to each input file.
// It records the last line whose effect the server confirmed, and the report
// counts up to that line, so a new run resumes where the last one stopped and
// still reports on the whole file.

export const PROGRESS_VERSION = 1;

export interface ImportProgress {
  version: typeof PROGRESS_VERSION;
  /** Basename of the input file. */
  source: string;
  projectId: string;
  /** API base URL the lines were sent to (trailing slashes removed): another server is another import. */
  apiUrl: string;
  /** Last line of the input whose effect is confirmed; 0 before the first. */
  lastLine: number;
  complete: boolean;
  report: ReportRow[];
}

export interface LoadedProgress {
  lastLine: number;
  complete: boolean;
  report: ImportReport;
}

export function progressPath(file: string): string {
  return `${file}${PROGRESS_SUFFIX}`;
}

/** The progress of `file`, or null when there is none. Throws when it cannot be used. */
export async function loadProgress(file: string, projectId: string, apiUrl: string): Promise<LoadedProgress | null> {
  const p = progressPath(file);
  let text: string;
  try {
    text = await readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const restart = "pass --restart to import the file from its first line";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${p} is not valid JSON: ${restart}`);
  }
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (data.version !== PROGRESS_VERSION) {
    throw new Error(`${p} has an unknown version (${JSON.stringify(data.version)}): ${restart}`);
  }
  if (data.projectId !== projectId) {
    throw new Error(`${p} records an import into project ${JSON.stringify(data.projectId)}, not ${projectId}: ${restart}`);
  }
  if (data.apiUrl !== apiUrl) {
    throw new Error(`${p} records an import into ${JSON.stringify(data.apiUrl)}, not ${apiUrl}: ${restart}`);
  }
  if (data.source !== path.basename(file)) {
    throw new Error(`${p} belongs to ${JSON.stringify(data.source)}, not ${path.basename(file)}: ${restart}`);
  }
  if (typeof data.lastLine !== "number" || !Number.isSafeInteger(data.lastLine) || data.lastLine < 0 || typeof data.complete !== "boolean") {
    throw new Error(`${p} is damaged: ${restart}`);
  }
  let report: ImportReport;
  try {
    report = ImportReport.fromRows(data.report);
  } catch (err) {
    throw new Error(`${p} has a damaged report (${err instanceof Error ? err.message : String(err)}): ${restart}`);
  }
  return { lastLine: data.lastLine, complete: data.complete, report };
}

/** Writes the progress atomically: a `.tmp` file renamed over the old one. */
export async function saveProgress(file: string, progress: Omit<ImportProgress, "version" | "source">): Promise<void> {
  const p = progressPath(file);
  const content: ImportProgress = {
    version: PROGRESS_VERSION,
    source: path.basename(file),
    projectId: progress.projectId,
    apiUrl: progress.apiUrl,
    lastLine: progress.lastLine,
    complete: progress.complete,
    report: progress.report,
  };
  const tmp = `${p}.tmp`;
  await writeFile(tmp, `${JSON.stringify(content)}\n`);
  await rename(tmp, p);
}
