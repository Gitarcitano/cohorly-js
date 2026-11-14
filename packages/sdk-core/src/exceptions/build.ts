import type { ExceptionListEntry, ExceptionMechanism } from "../types.js";
import { parseStackTrace } from "./stack-parser.js";

/** Entries in `$exception_list`: the reported exception plus up to 4 causes. */
export const MAX_EXCEPTION_CHAIN = 5;
/** Length cap of a stringified non-Error value. */
export const MAX_STRINGIFIED_LENGTH = 1000;

interface ErrorLike {
  name?: unknown;
  message: unknown;
  stack?: unknown;
  cause?: unknown;
}

/**
 * True for Errors, including ones from another realm (an iframe, a VM
 * context), where `instanceof Error` is false but the shape is the same.
 */
export function isErrorLike(value: unknown): value is ErrorLike {
  if (value instanceof Error) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.message === "string" &&
    (typeof candidate.name === "string" || typeof candidate.stack === "string")
  );
}

/**
 * A safe, bounded string for any thrown value: strings as they are, objects
 * through a guarded JSON.stringify (cycles and throwing getters fall back to
 * the object tag), everything cut to {@link MAX_STRINGIFIED_LENGTH} chars.
 */
export function stringifyValue(value: unknown): string {
  let out: string;
  if (typeof value === "string") {
    out = value;
  } else if (typeof value === "object" && value !== null) {
    try {
      out = JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      out = Object.prototype.toString.call(value);
    }
  } else {
    try {
      out = String(value);
    } catch {
      out = typeof value;
    }
  }
  return out.length > MAX_STRINGIFIED_LENGTH
    ? out.slice(0, MAX_STRINGIFIED_LENGTH)
    : out;
}

function errorType(error: ErrorLike): string {
  if (typeof error.name === "string" && error.name) return error.name;
  const ctor = (error as { constructor?: { name?: unknown } }).constructor;
  return typeof ctor?.name === "string" && ctor.name ? ctor.name : "Error";
}

function entryFromError(
  error: ErrorLike,
  mechanism: ExceptionMechanism,
): ExceptionListEntry {
  const entry: ExceptionListEntry = {
    type: errorType(error),
    value: typeof error.message === "string" ? error.message : stringifyValue(error.message),
    mechanism,
  };
  const frames = parseStackTrace(error.stack);
  if (frames.length > 0) entry.stacktrace = { type: "raw", frames };
  return entry;
}

function syntheticEntry(value: unknown, handled: boolean, type: string): ExceptionListEntry {
  return {
    type: "Error",
    value: stringifyValue(value),
    mechanism: { handled, type, synthetic: true },
  };
}

/**
 * Builds `$exception_list` for anything thrown. Entry 0 is the reported
 * value with `mechanism`; an Error's `cause` chain follows, outermost first,
 * as `{ handled: true, type: "chained" }`, stopping at
 * {@link MAX_EXCEPTION_CHAIN} entries or at a cause already seen (cycles).
 * A non-Error (string, plain object, number, undefined) becomes a synthetic
 * `Error` entry with no stacktrace.
 */
export function buildExceptionList(
  error: unknown,
  mechanism: { handled: boolean; type: string },
): ExceptionListEntry[] {
  if (!isErrorLike(error)) {
    return [syntheticEntry(error, mechanism.handled, mechanism.type)];
  }
  const list: ExceptionListEntry[] = [
    entryFromError(error, { ...mechanism, synthetic: false }),
  ];
  const seen = new Set<unknown>([error]);
  let cause = readCause(error);
  while (cause !== undefined && cause !== null && list.length < MAX_EXCEPTION_CHAIN) {
    if (seen.has(cause)) break;
    seen.add(cause);
    if (!isErrorLike(cause)) {
      list.push(syntheticEntry(cause, true, "chained"));
      break;
    }
    list.push(entryFromError(cause, { handled: true, type: "chained", synthetic: false }));
    cause = readCause(cause);
  }
  return list;
}

/** `type` of the entry for a promise rejected with something that is not an Error. */
export const UNHANDLED_REJECTION_TYPE = "UnhandledRejection";

/**
 * `$exception_list` for an unhandled promise rejection, the same on every
 * client SDK. An Error reason keeps its own type and frames (`buildError`
 * lets a platform swap in its stack parser, e.g. Hermes); anything else is a
 * synthetic {@link UNHANDLED_REJECTION_TYPE} entry, so a rejected string or
 * object groups as one issue type instead of a generic `Error`.
 */
export function buildRejectionList(
  reason: unknown,
  buildError: (
    error: unknown,
    mechanism: { handled: boolean; type: string },
  ) => ExceptionListEntry[] = buildExceptionList,
): ExceptionListEntry[] {
  const mechanism = { handled: false, type: "onunhandledrejection" };
  if (isErrorLike(reason)) return buildError(reason, mechanism);
  return [
    {
      type: UNHANDLED_REJECTION_TYPE,
      value: `Non-Error promise rejection captured with value: ${stringifyValue(reason)}`,
      mechanism: { ...mechanism, synthetic: true },
    },
  ];
}

function readCause(error: ErrorLike): unknown {
  try {
    return error.cause;
  } catch {
    return undefined;
  }
}
