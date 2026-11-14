/**
 * JavaScript stack-trace parsing for Chrome/V8 (also Node and Edge),
 * Firefox/Gecko and Safari/JavaScriptCore.
 *
 * Adapted from posthog-js (MIT, Copyright (c) 2020 PostHog Inc.), whose
 * parsers are themselves derived from the Sentry JavaScript SDK (MIT,
 * Copyright (c) Functional Software, Inc. dba Sentry). See the repo NOTICE.
 */
import type { ExceptionStackFrame } from "../types.js";

/** Frames kept per stack trace; the crashing end is kept on overflow. */
export const MAX_STACK_FRAMES = 50;
/** Longer lines are cut before matching, so a pathological line cannot stall a regex. */
const MAX_LINE_LENGTH = 1024;

const CHROME_LINE = /^\s*at\s/;
const CHROME_NO_FN =
  /^\s*at (\S+?)(?::(\d+))(?::(\d+))\s*$/i;
const CHROME =
  /^\s*at (?:(.+?\)(?: \[.+\])?|.*?) ?\((?:address at )?)?(?:async )?((?:<anonymous>|[-a-z]+:|.*bundle|\/)?.*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i;
const CHROME_EVAL = /\((\S*)(?::(\d+))(?::(\d+))\)/;

const GECKO =
  /^\s*(.*?)(?:\((.*?)\))?(?:^|@)?((?:[-a-z]+)?:\/.*?|\[native code\]|[^@]*(?:bundle|\d+\.js)|\/[\w\-. /=]+)(?::(\d+))?(?::(\d+))?\s*$/i;
const GECKO_EVAL = /(\S+) line (\d+)(?: > eval line \d+)* > eval/i;

/** Filename prefixes of code that is never the app's own (browser extensions, runtime internals). */
const NOT_IN_APP_PREFIXES = [
  "chrome-extension://",
  "moz-extension://",
  "safari-extension://",
  "safari-web-extension://",
  "node:",
  "internal/",
];
const NOT_IN_APP_NAMES = new Set(["<anonymous>", "native", "[native code]"]);

/**
 * Whether a frame's file is application code. False for dependencies
 * (`/node_modules/`), browser extensions, runtime internals and frames with
 * no real file (`<anonymous>`, native code, `Promise.all (index 0)`).
 */
export function isInAppFilename(filename: string | undefined): boolean {
  if (!filename) return false;
  if (NOT_IN_APP_NAMES.has(filename)) return false;
  if (/^index \d+$/.test(filename)) return false;
  if (filename.includes("/node_modules/")) return false;
  return !NOT_IN_APP_PREFIXES.some((prefix) => filename.startsWith(prefix));
}

/** One `platform: "javascript"` frame; unknown parts are omitted rather than guessed. */
export function createStackFrame(
  filename: string | undefined,
  fn?: string,
  lineno?: number,
  colno?: number,
): ExceptionStackFrame {
  const frame: ExceptionStackFrame = {
    platform: "javascript",
    in_app: isInAppFilename(filename),
  };
  if (filename) {
    frame.filename = filename;
    frame.abs_path = filename;
  }
  const name = cleanFunctionName(fn);
  if (name) frame.function = name;
  if (lineno !== undefined && Number.isFinite(lineno)) frame.lineno = lineno;
  if (colno !== undefined && Number.isFinite(colno)) frame.colno = colno;
  return frame;
}

/** Drops the async markers V8 (`async fn`) and Gecko (`async*fn`) prefix to names. */
function cleanFunctionName(fn: string | undefined): string | undefined {
  if (!fn || fn === "?") return undefined;
  const name = fn.replace(/^async\*/, "").replace(/^async /, "").trim();
  return name || undefined;
}

function toNumber(value: string | undefined): number | undefined {
  return value ? Number(value) : undefined;
}

/**
 * Safari reports frames of its extensions as `fn@safari-extension:(//...)`;
 * this moves the scheme back onto the filename and the name before the `@`
 * back onto the function.
 */
function extractSafariExtensionDetails(
  fn: string | undefined,
  filename: string | undefined,
): [string | undefined, string | undefined] {
  if (!fn) return [fn, filename];
  const isSafariExtension = fn.includes("safari-extension");
  const isSafariWebExtension = fn.includes("safari-web-extension");
  if (!isSafariExtension && !isSafariWebExtension) return [fn, filename];
  return [
    fn.includes("@") ? fn.split("@")[0] : undefined,
    isSafariExtension
      ? `safari-extension:${filename}`
      : `safari-web-extension:${filename}`,
  ];
}

function parseChromeLine(line: string): ExceptionStackFrame | undefined {
  const noFn = CHROME_NO_FN.exec(line);
  if (noFn) {
    return createStackFrame(noFn[1], undefined, toNumber(noFn[2]), toNumber(noFn[3]));
  }
  const parts = CHROME.exec(line);
  if (!parts) return undefined;
  let filename = parts[2];
  let lineno = parts[3];
  let colno = parts[4];
  if (filename?.startsWith("eval")) {
    const sub = CHROME_EVAL.exec(filename);
    if (sub) {
      filename = sub[1];
      lineno = sub[2];
      colno = sub[3];
    }
  }
  const [fn, file] = extractSafariExtensionDetails(parts[1], filename);
  return createStackFrame(file, fn, toNumber(lineno), toNumber(colno));
}

function parseGeckoLine(line: string): ExceptionStackFrame | undefined {
  const parts = GECKO.exec(line);
  if (!parts) return undefined;
  let fn = parts[1];
  let filename = parts[3];
  let lineno = parts[4];
  let colno: string | undefined = parts[5];
  if (filename?.includes(" > eval")) {
    const sub = GECKO_EVAL.exec(filename);
    if (sub) {
      fn = fn || "eval";
      filename = sub[1];
      lineno = sub[2];
      colno = undefined;
    }
  }
  const [name, file] = extractSafariExtensionDetails(fn, filename);
  return createStackFrame(file, name, toNumber(lineno), toNumber(colno));
}

/**
 * Parses an `Error.stack` string into frames ordered OLDEST call first,
 * crashing frame last (ADR-0019), the reverse of how every JS engine prints
 * them. A V8 stack (any line starting with `at `) is parsed line by line with
 * the Chrome parser only, so the message lines above the frames are never
 * mistaken for a frame; anything else is a Gecko/JavaScriptCore stack.
 * Unparseable lines are skipped. At most {@link MAX_STACK_FRAMES} frames are
 * kept, the ones closest to the crash.
 */
export function parseStackTrace(stack: unknown): ExceptionStackFrame[] {
  if (typeof stack !== "string" || stack.length === 0) return [];
  const lines = stack.split("\n").map((line) => line.slice(0, MAX_LINE_LENGTH));
  const isV8 = lines.some((line) => CHROME_LINE.test(line));
  const frames: ExceptionStackFrame[] = [];
  for (const line of lines) {
    if (frames.length >= MAX_STACK_FRAMES) break;
    if (isV8) {
      if (!CHROME_LINE.test(line)) continue;
      const frame = parseChromeLine(line);
      if (frame) frames.push(frame);
      continue;
    }
    if (line.trim().length === 0) continue;
    const frame = parseGeckoLine(line);
    if (frame) frames.push(frame);
  }
  return frames.reverse();
}
