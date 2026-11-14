/**
 * Stack parsing for React Native: Hermes (`at fn (address at <file>:1:2)`,
 * `at fn (native)`), JavaScriptCore (`fn@<file>:1:2`, `[native code]`) and the
 * Metro dev server (`http://localhost:8081/index.bundle?...:12:3`).
 *
 * A frame from the app's own bundle gets the canonical bundle name as
 * `filename` (`index.android.bundle` / `main.jsbundle`), the name its source
 * map index is uploaded under, whatever the file is called on the device (an
 * OTA bundle lives under a hashed name in `.expo-internal`). `abs_path` keeps
 * the original path.
 */
import type {
  ExceptionListEntry,
  ExceptionMechanism,
  ExceptionStackFrame,
} from "@cohorly/core";
import {
  buildExceptionList,
  buildRejectionList,
  createStackFrame,
  isErrorLike,
} from "@cohorly/core";

/** Frames kept per stack (same cap as @cohorly/core); the crashing end is kept. */
export const MAX_HERMES_FRAMES = 50;
const MAX_LINE_LENGTH = 1024;

export const ANDROID_BUNDLE_NAME = "index.android.bundle";
export const IOS_BUNDLE_NAME = "main.jsbundle";

const V8_LINE = /^\s*at\s/;
const NATIVE_LOCATIONS = new Set(["native", "[native code]"]);
/** Runtime-provided code with a fake file name: never the app's bundle. */
const RUNTIME_FILES = new Set(["InternalBytecode.js", "JSContext", "<anonymous>", "unknown"]);
const LOCATION = /^(.*?)(?::(\d+))?(?::(\d+))?$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** `Platform.OS`-style name ("Android", "iOS", "android", ...) -> canonical bundle file. */
export function canonicalBundleName(os: string | undefined): string | undefined {
  const lower = os?.toLowerCase();
  if (lower === "android") return ANDROID_BUNDLE_NAME;
  if (lower === "ios") return IOS_BUNDLE_NAME;
  return undefined;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function nativeFrame(fn: string | undefined): ExceptionStackFrame {
  const frame = createStackFrame(undefined, fn);
  frame.platform = "native";
  frame.in_app = false;
  return frame;
}

function frameFromLocation(
  fn: string | undefined,
  location: string,
  os: string | undefined,
): ExceptionStackFrame | undefined {
  const loc = location.replace(/^address at\s+/, "").trim();
  if (NATIVE_LOCATIONS.has(loc)) return nativeFrame(fn);
  const parts = LOCATION.exec(loc);
  const file = parts?.[1];
  if (!file) return createStackFrame(undefined, fn);
  const lineno = toNumber(parts[2]);
  const colno = toNumber(parts[3]);

  if (RUNTIME_FILES.has(file)) {
    const frame = createStackFrame(file, fn, lineno, colno);
    frame.in_app = false;
    return frame;
  }
  // Dev builds load the bundle from Metro: the URL is what the dev-server
  // symbolicator expects, so it is kept as it is.
  if (URL_SCHEME.test(file) || file.includes("/node_modules/")) {
    return createStackFrame(file, fn, lineno, colno);
  }
  const frame = createStackFrame(canonicalBundleName(os) ?? basename(file), fn, lineno, colno);
  frame.abs_path = file;
  frame.in_app = true;
  return frame;
}

function cleanName(fn: string | undefined): string | undefined {
  const name = fn?.replace(/^async\s+/, "").trim();
  return name || undefined;
}

/** `at fn (loc)`, `at loc`, `at fn` (no location). */
function parseV8Line(line: string, os: string | undefined): ExceptionStackFrame | undefined {
  const body = line.replace(V8_LINE, "").trim();
  if (!body) return undefined;
  const withLocation = /^(.*?) \((.*)\)$/.exec(body);
  if (withLocation) {
    return frameFromLocation(cleanName(withLocation[1]), withLocation[2], os);
  }
  if (NATIVE_LOCATIONS.has(body) || /:\d+(?::\d+)?$/.test(body)) {
    return frameFromLocation(undefined, body, os);
  }
  return createStackFrame(undefined, cleanName(body));
}

/** `fn@loc`, `@loc`, `loc`, `[native code]`. */
function parseJscLine(line: string, os: string | undefined): ExceptionStackFrame | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const at = trimmed.indexOf("@");
  if (at >= 0) {
    return frameFromLocation(cleanName(trimmed.slice(0, at)), trimmed.slice(at + 1), os);
  }
  if (NATIVE_LOCATIONS.has(trimmed) || /:\d+(?::\d+)?$/.test(trimmed)) {
    return frameFromLocation(undefined, trimmed, os);
  }
  return undefined;
}

/**
 * Parses a React Native `Error.stack` into frames ordered OLDEST call first,
 * crashing frame last (ADR-0019). `os` is the platform ("Android"/"iOS") and
 * picks the canonical bundle name. A stack with any `at ` line is read as
 * Hermes/V8 and only those lines count (the message line and Hermes'
 * `... skipping N frames` are ignored); anything else is read as
 * JavaScriptCore. Never throws.
 */
export function parseHermesStack(stack: unknown, os: string | undefined): ExceptionStackFrame[] {
  if (typeof stack !== "string" || stack.length === 0) return [];
  try {
    const lines = stack.split("\n").map((line) => line.slice(0, MAX_LINE_LENGTH));
    const isV8 = lines.some((line) => V8_LINE.test(line));
    const frames: ExceptionStackFrame[] = [];
    for (const line of lines) {
      if (frames.length >= MAX_HERMES_FRAMES) break;
      if (isV8 && !V8_LINE.test(line)) continue;
      const frame = isV8 ? parseV8Line(line, os) : parseJscLine(line, os);
      if (frame) frames.push(frame);
    }
    return frames.reverse();
  } catch {
    return [];
  }
}

/** The `cause` links buildExceptionList walks, in the same order and with the same stops. */
function causeChain(error: unknown, max: number): unknown[] {
  const chain: unknown[] = [error];
  const seen = new Set<unknown>([error]);
  let current: unknown = error;
  while (chain.length < max && isErrorLike(current)) {
    let cause: unknown;
    try {
      cause = (current as { cause?: unknown }).cause;
    } catch {
      break;
    }
    if (cause === undefined || cause === null || seen.has(cause)) break;
    seen.add(cause);
    chain.push(cause);
    current = cause;
  }
  return chain;
}

/**
 * `$exception_list` for a React Native error. Types, values, mechanisms and
 * the cause chain come from @cohorly/core's buildExceptionList; only the
 * frames are replaced by the React Native parser. Entry `i` of that list is
 * link `i` of the cause chain, so each entry is re-parsed from its own stack.
 */
export function buildReactNativeExceptionList(
  error: unknown,
  mechanism: Omit<ExceptionMechanism, "synthetic">,
  os: string | undefined,
): ExceptionListEntry[] {
  const list = buildExceptionList(error, mechanism);
  const chain = causeChain(error, list.length);
  list.forEach((entry, i) => {
    const link = chain[i];
    if (entry.mechanism.synthetic || !isErrorLike(link)) return;
    const frames = parseHermesStack((link as { stack?: unknown }).stack, os);
    if (frames.length > 0) entry.stacktrace = { type: "raw", frames };
    else delete entry.stacktrace;
  });
  return list;
}

/**
 * `$exception_list` for an unhandled promise rejection: the web SDK's rule
 * (`buildRejectionList` in @cohorly/core), with Error reasons parsed as
 * Hermes stacks.
 */
export function buildReactNativeRejectionList(
  reason: unknown,
  os: string | undefined,
): ExceptionListEntry[] {
  return buildRejectionList(reason, (error, mechanism) =>
    buildReactNativeExceptionList(error, mechanism, os),
  );
}
