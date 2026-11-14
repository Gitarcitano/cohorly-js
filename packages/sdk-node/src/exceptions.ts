import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Breadcrumb,
  type BreadcrumbInput,
  type ExceptionLevel,
  type ExceptionListEntry,
  MAX_BREADCRUMB_MESSAGE_LENGTH,
  MAX_BREADCRUMBS,
  stringifyValue,
} from "@cohorly/core";

export const EXCEPTION_EVENT = "$exception";

const EXCEPTION_LEVELS: ReadonlySet<string> = new Set<ExceptionLevel>([
  "fatal",
  "error",
  "warning",
  "info",
]);

/** Keys `tags`/`extra` can never set on an exception (plus every `$exception_*` and `$lib*`). */
const RESERVED_EXCEPTION_KEYS: ReadonlySet<string> = new Set([
  "error_title",
  "distinct_id",
  "time",
  "$insert_id",
  "token",
]);

export function isReservedExceptionKey(key: string): boolean {
  return (
    key.startsWith("$exception_") ||
    key.startsWith("$lib") ||
    RESERVED_EXCEPTION_KEYS.has(key)
  );
}

/**
 * A copy of `value` that JSON.stringify can always serialize. An error's
 * `extra` often holds a Node `req`/`res` (circular), a BigInt or a throwing
 * getter; left as is it would make the transport throw on every flush and
 * hold the whole queue back. Such a value is kept as a bounded string.
 */
export function jsonSafe(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return stringifyValue(value);
  }
}

export function withoutReservedKeys(
  props: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props || typeof props !== "object") return out;
  for (const [key, value] of Object.entries(props)) {
    if (!isReservedExceptionKey(key)) out[key] = jsonSafe(value);
  }
  return out;
}

export function normalizeLevel(level: unknown): ExceptionLevel {
  return typeof level === "string" && EXCEPTION_LEVELS.has(level)
    ? (level as ExceptionLevel)
    : "error";
}

/**
 * `filename` relative to `root` when it points inside it (a `file://` URL is
 * decoded first, percent-encoding included), with `/` separators. Anything
 * else - outside the root, `node:` internals, `<anonymous>` - is returned as
 * it came.
 */
export function relativeToRoot(filename: string, root: string): string {
  let absolute = filename;
  if (filename.startsWith("file://")) {
    try {
      absolute = fileURLToPath(filename);
    } catch {
      return filename;
    }
  }
  if (!path.isAbsolute(absolute)) return filename;
  const relative = path.relative(root, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return filename;
  }
  return relative.split(path.sep).join("/");
}

/**
 * A copy of `list` whose frames carry `filename`/`abs_path` relative to
 * `root`. `in_app` is left as it was: it was computed on the original path,
 * and `node_modules/x.js` relative would no longer match `/node_modules/`.
 */
export function relativizeFrames(
  list: ExceptionListEntry[],
  root: string,
): ExceptionListEntry[] {
  return list.map((entry) => {
    const stacktrace = entry?.stacktrace;
    if (!stacktrace || !Array.isArray(stacktrace.frames)) return entry;
    return {
      ...entry,
      stacktrace: {
        ...stacktrace,
        frames: stacktrace.frames.map((frame) => {
          const out = { ...frame };
          if (typeof out.filename === "string") {
            out.filename = relativeToRoot(out.filename, root);
          }
          if (typeof out.abs_path === "string") {
            out.abs_path = relativeToRoot(out.abs_path, root);
          }
          return out;
        }),
      },
    };
  });
}

function cloneJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** An independent copy, so neither the ring nor a captured event can mutate the other. */
export function snapshotBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const copy: Breadcrumb = { ...crumb };
  if (crumb.data !== undefined) copy.data = cloneJson(crumb.data) as Record<string, unknown>;
  return copy;
}

/**
 * Appends `crumb` to `ring` with the core SDK's rules: `timestamp` defaults
 * to now, `message` is cut to MAX_BREADCRUMB_MESSAGE_LENGTH, `data` is
 * deep-copied, and only the last MAX_BREADCRUMBS are kept.
 */
export function pushBreadcrumb(ring: Breadcrumb[], crumb: BreadcrumbInput): void {
  if (!crumb || typeof crumb.category !== "string") return;
  const entry: Breadcrumb = {
    timestamp: crumb.timestamp ?? new Date().toISOString(),
    category: crumb.category,
  };
  if (crumb.message !== undefined) {
    const message = String(crumb.message);
    entry.message =
      message.length > MAX_BREADCRUMB_MESSAGE_LENGTH
        ? message.slice(0, MAX_BREADCRUMB_MESSAGE_LENGTH)
        : message;
  }
  if (crumb.level !== undefined) entry.level = crumb.level;
  if (crumb.data !== undefined) {
    const data = cloneJson(crumb.data);
    if (data && typeof data === "object") entry.data = data as Record<string, unknown>;
  }
  ring.push(entry);
  if (ring.length > MAX_BREADCRUMBS) ring.splice(0, ring.length - MAX_BREADCRUMBS);
}
