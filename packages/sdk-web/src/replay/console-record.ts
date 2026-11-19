/**
 * Session replay `$console` lines (VEL-2144, docs/SESSION-REPLAY.md): turns
 * the raw `(level, args)` console.ts dispatches into one scrubbed, bounded
 * line and applies the per-minute limit. Lives in the replay's lazy chunk.
 */
import { isErrorLike, scrubDeep, scrubText } from "@cohorly/core";
import type { ConsoleLevel } from "../console.js";

export const CONSOLE_TAG = "$console";
export const MAX_CONSOLE_MESSAGE_CHARS = 2048;
export const CONSOLE_LINES_PER_WINDOW = 500;
export const CONSOLE_WINDOW_MS = 60_000;
/** Objects and arrays nested deeper than this become {@link OBJECT_MARKER} / {@link ARRAY_MARKER}. */
export const MAX_CONSOLE_DEPTH = 4;
/** Keys per object and items per array; the rest is replaced by one `[+N]` marker. */
export const MAX_CONSOLE_KEYS = 50;
/** Values visited per line, so a wide and deep object costs the same as a small one. */
export const MAX_CONSOLE_NODES = 1000;
/**
 * Text kept before the scrub (cut before a partial secret): the scrub then never
 * walks megabytes for a line cut at 2048 anyway.
 */
const MAX_RAW_CHARS = 16 * 1024;

export const OBJECT_MARKER = "[Object]";
export const ARRAY_MARKER = "[Array]";
export const CIRCULAR_MARKER = "[Circular]";
export const UNSERIALIZABLE_MARKER = "[Unserializable]";

const SDK_PREFIX = "[cohorly]";

export interface ConsoleLine {
  level: ConsoleLevel;
  message: string;
}

/** The line written when a window closes after dropping lines. */
export interface ConsoleDroppedLine {
  level: "warn";
  message: "";
  dropped: number;
  /** Unix ms of the first line dropped in that window. */
  at: number;
}

export type ConsolePayload = ConsoleLine | ConsoleDroppedLine;

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Characters an e-mail, a JWT, a `key=value` secret or a card number can be made of. */
const SECRET_TAIL = /[A-Za-z0-9@._%+\-=/~]+$/;

/** Longest trailing run {@link cutWhole} drops: an e-mail, a card or a short secret fits; a longer run is a blob. */
const MAX_SECRET_TAIL = 256;

/**
 * Cuts `text` to `max` and drops a trailing run of up to
 * {@link MAX_SECRET_TAIL} characters that may be the start of a secret the
 * scrub could only recognize whole.
 */
function cutWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const tail = SECRET_TAIL.exec(cut)?.[0].length ?? 0;
  return tail > 0 && tail <= MAX_SECRET_TAIL ? cut.slice(0, cut.length - tail) : cut;
}

function errorText(error: { name?: unknown; message?: unknown; stack?: unknown }): string {
  const name = typeof error.name === "string" && error.name ? error.name : "Error";
  const header = `${name}: ${String(error.message)}`;
  const stack = typeof error.stack === "string" ? error.stack : "";
  if (stack === "") return header;
  return stack.startsWith(header) ? stack : `${header}\n${stack}`;
}

/**
 * A JSON-safe copy of `value`, bounded in depth, width, values visited and
 * text kept, with cycles marked. Only a Date's own ISO form is used: a page's
 * `toJSON` is never called, so it cannot move a secret out of the key that
 * marks it. A getter that throws becomes {@link UNSERIALIZABLE_MARKER}.
 */
function bounded(value: unknown): unknown {
  let nodes = 0;
  let chars = 0;
  const ancestors = new Set<object>();
  // Scrubbed before it is cut, so a cut never leaves part of a secret the scrub would not know.
  const text = (s: string): string => {
    const limit = Math.max(0, Math.min(MAX_CONSOLE_MESSAGE_CHARS, MAX_RAW_CHARS - chars));
    const kept = cutWhole(scrubText(cutWhole(s, limit * 4)), limit);
    chars += kept.length;
    return kept;
  };
  const walk = (v: unknown, depth: number): unknown => {
    nodes += 1;
    if (typeof v === "string") return text(v);
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "boolean" || v === null || v === undefined) return v;
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "function") return "[Function]";
    if (typeof v !== "object") return text(String(v));
    if (ancestors.has(v)) return CIRCULAR_MARKER;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (isErrorLike(v)) return text(errorText(v));
    if (typeof Node !== "undefined" && v instanceof Node) return text(String(v));
    const isArray = Array.isArray(v);
    if (depth >= MAX_CONSOLE_DEPTH || nodes > MAX_CONSOLE_NODES || chars >= MAX_RAW_CHARS) {
      return isArray ? ARRAY_MARKER : OBJECT_MARKER;
    }
    ancestors.add(v);
    try {
      if (isArray) {
        const list = v as unknown[];
        const items: unknown[] = [];
        for (let i = 0; i < Math.min(list.length, MAX_CONSOLE_KEYS); i++) {
          items.push(guarded(() => list[i], depth + 1));
        }
        const rest = list.length - MAX_CONSOLE_KEYS;
        if (rest > 0) items.push(`[+${rest}]`);
        return items;
      }
      const out: Record<string, unknown> = {};
      let kept = 0;
      let rest = 0;
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        if (kept >= MAX_CONSOLE_KEYS) {
          rest += 1;
          continue;
        }
        kept += 1;
        out[key] = guarded(() => (v as Record<string, unknown>)[key], depth + 1);
      }
      if (rest > 0) out["..."] = `[+${rest}]`;
      return out;
    } finally {
      ancestors.delete(v);
    }
  };
  /** Reads and walks one value; a getter or String() that throws becomes a marker. */
  const guarded = (read: () => unknown, depth: number): unknown => {
    try {
      return walk(read(), depth);
    } catch {
      return UNSERIALIZABLE_MARKER;
    }
  };
  return guarded(() => value, 0);
}

/** One argument as text: strings as they are, errors with their stack, objects as bounded scrubbed JSON. */
function argumentText(arg: unknown): string {
  const over = MAX_RAW_CHARS + 1;
  try {
    if (typeof arg === "string") return cap(arg, over);
    if (isErrorLike(arg)) return cap(errorText(arg), over);
    if (typeof arg === "object" && arg !== null) {
      const tree = bounded(arg);
      if (typeof tree === "string") return cap(tree, over);
      // Secret keys are replaced before the object becomes text.
      const json = JSON.stringify(scrubDeep(tree));
      return typeof json === "string" ? cap(json, over) : UNSERIALIZABLE_MARKER;
    }
    return cap(String(arg), over);
  } catch {
    return UNSERIALIZABLE_MARKER;
  }
}

/**
 * The `message` of a console line: arguments joined by a space, scrubbed
 * (scrubText on the whole line, after scrubDeep on each object), then cut at
 * {@link MAX_CONSOLE_MESSAGE_CHARS}.
 */
export function formatConsoleMessage(args: readonly unknown[]): string {
  let raw = "";
  for (let i = 0; i < args.length; i++) {
    raw += (i === 0 ? "" : " ") + argumentText(args[i]);
    if (raw.length > MAX_RAW_CHARS) break;
  }
  return cutWhole(scrubText(cutWhole(raw, MAX_RAW_CHARS)), MAX_CONSOLE_MESSAGE_CHARS);
}

/** The SDK's own messages (`console.warn("[cohorly] ...")`) are never recorded. */
function isSdkMessage(args: readonly unknown[]): boolean {
  const first = args[0];
  return typeof first === "string" && first.startsWith(SDK_PREFIX);
}

export interface ConsoleSink {
  /** Whether a line written now lands in a recording (a live session with a recorder). */
  recording(): boolean;
  /** The session the recorder writes to, or null without one. */
  session(): string | null;
  /** Writes the line into the recording (`record.addCustomEvent`). */
  add(payload: ConsolePayload): void;
}

export interface ConsoleRecorder {
  /** A console call, as console.ts dispatches it. */
  line(level: ConsoleLevel, args: readonly unknown[]): void;
  /**
   * Writes the window's dropped line now, before the recorder stops or the
   * page goes away; only into the session that dropped the lines.
   */
  flush(): void;
  /** Stops the window timer; later lines are ignored. */
  stop(): void;
}

/**
 * Lines for one replay instance: at most {@link CONSOLE_LINES_PER_WINDOW}
 * per {@link CONSOLE_WINDOW_MS} for the page, whatever session or recorder
 * is running (a rotation or a recorder restart keeps the window). A window
 * starts at its first line. Past the limit, lines are dropped; when the
 * window closes (a timer, armed only by a drop), one
 * {@link ConsoleDroppedLine} is written if something is recording, else
 * nothing. A line with nothing recording is dropped at once and not counted.
 */
export function consoleRecorder(sink: ConsoleSink, now: () => number = Date.now): ConsoleRecorder {
  let stopped = false;
  let writing = false;
  let windowStart: number | null = null;
  let count = 0;
  let dropped = 0;
  let firstDropAt = 0;
  let dropSession: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = (payload: ConsolePayload) => {
    writing = true;
    try {
      sink.add(payload);
    } catch {
      // rrweb errors must not reach the page
    } finally {
      writing = false;
    }
  };

  const writeDropped = (live: boolean) => {
    const lost = dropped;
    dropped = 0;
    if (lost > 0 && !stopped && live && sink.session() === dropSession) {
      write({ level: "warn", message: "", dropped: lost, at: firstDropAt });
    }
  };

  const closeWindow = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    windowStart = null;
    count = 0;
    writeDropped(sink.recording());
  };

  return {
    line(level, args) {
      if (stopped || writing || isSdkMessage(args) || !sink.recording()) return;
      const t = now();
      // A clock set back starts a new window too.
      if (windowStart !== null && (t - windowStart >= CONSOLE_WINDOW_MS || t < windowStart)) {
        closeWindow();
      }
      if (windowStart === null) windowStart = t;
      if (count >= CONSOLE_LINES_PER_WINDOW) {
        if (dropped === 0) {
          firstDropAt = t;
          dropSession = sink.session();
          if (timer === null) timer = setTimeout(closeWindow, Math.max(0, windowStart + CONSOLE_WINDOW_MS - t));
        }
        dropped += 1;
        return;
      }
      count += 1;
      write({ level, message: formatConsoleMessage(args) });
    },
    flush() {
      writeDropped(true);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
