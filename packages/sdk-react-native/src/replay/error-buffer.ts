/**
 * Error mode's memory buffer, the rules of the web SDK's error buffer
 * (`@cohorly/web` replay/replay.ts): events are kept in segments that each
 * start at a Meta (the FullSnapshot follows it), and a send covers the
 * newest segment at least 30 s old when it has no activity older than 60 s
 * (else the oldest segment inside the last 60 s) up to the error. At most
 * 10 MB (UTF-8) of serialized events are kept, checked on every event:
 * whole oldest segments go first, and a segment over the bound on its own is
 * discarded (a checkout starts the next one). The
 * recorder takes a checkout every 30 s when something was recorded since
 * the previous one, so a send can always start at a snapshot.
 */
import { FULL_SNAPSHOT, META, utf8Length } from "./chunks.js";

/** A send never holds activity older than this before the error... */
export const ERROR_WINDOW_MS = 60_000;
/** ...and covers at least this much when the recording is that old. */
export const ERROR_MIN_WINDOW_MS = 30_000;
export const CHECKOUT_EVERY_MS = 30_000;
export const ERROR_BUFFER_MAX_BYTES = 10 * 1024 * 1024;
/** Minimum time between two error sends (a later error waits, it is not lost). */
export const ERROR_SEND_GAP_MS = 5000;

/** DomContentLoaded, Load, FullSnapshot, Meta: screen state, not something that happened. */
const STATE_TYPES = new Set([0, 1, FULL_SNAPSHOT, META]);

export interface BufferedEvent {
  json: string;
  type: unknown;
}

interface Segment {
  /** Timestamp of its Meta. */
  start: number;
  events: BufferedEvent[];
  /** How many leading events are screen state. */
  lead: number;
  /** Timestamp of the first event that is not screen state, or null. */
  firstActivity: number | null;
  /** Timestamp of its FullSnapshot while that is the last state event, else null (the keyboard sent with it is state). */
  fullAt: number | null;
  bytes: number;
}

/** Tag of the Custom event of the software keyboard. */
const KEYBOARD_TAG = "keyboard";
const CUSTOM = 5;

export type Cut =
  /** Nothing new since the previous send. */
  | { kind: "nothing" }
  /** No snapshot inside the window: a checkout is needed before anything can go. */
  | { kind: "need-snapshot" }
  | { kind: "events"; events: BufferedEvent[] };

function lastIndex<T>(list: T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i])) return i;
  return -1;
}

export class ErrorBuffer {
  private segments: Segment[] = [];
  private bytes = 0;
  /** Something besides screen state was buffered since the last checkout. */
  dirtySinceCheckout = false;
  /** ...since the last send. */
  private dirtySinceSend = true;
  /** The `data` of the last FullSnapshot: a different one is a new screen, worth sending again. */
  private lastFullData: string | null = null;

  constructor(private readonly now: () => number) {}

  get size(): number {
    return this.bytes;
  }

  hasSnapshot(): boolean {
    return this.segments.length > 0;
  }

  /**
   * Adds one event. True when a single segment went over the bound: it was
   * discarded, and a checkout is needed before anything is buffered again.
   */
  push(event: { type?: unknown; timestamp?: unknown }, json: string): boolean {
    const timestamp = typeof event.timestamp === "number" ? event.timestamp : this.now();
    const bytes = utf8Length(json);
    if (event.type === META) {
      this.segments.push({
        start: timestamp,
        events: [{ json, type: META }],
        lead: 1,
        firstActivity: null,
        fullAt: null,
        bytes,
      });
      this.bytes += bytes;
      this.dirtySinceCheckout = false;
      // Nothing before the newest segment at least 30 s old can be sent again.
      this.dropSegments(lastIndex(this.segments, (s) => s.start <= this.now() - ERROR_MIN_WINDOW_MS));
      return this.enforceBound();
    }
    const current = this.segments[this.segments.length - 1];
    if (!current) return false; // no snapshot yet: unusable on its own
    if (event.type === FULL_SNAPSHOT) {
      const data = JSON.stringify((event as { data?: unknown }).data ?? null);
      // A checkout of the same screen is state; a changed screen is news.
      if (this.lastFullData !== null && data !== this.lastFullData) this.dirtySinceSend = true;
      this.lastFullData = data;
    }
    current.events.push({ json, type: event.type });
    current.bytes += bytes;
    this.bytes += bytes;
    const state = typeof event.type === "number" && STATE_TYPES.has(event.type);
    // The open keyboard the recorder sends again with every full snapshot is that
    // screen's state: an idle screen with the keyboard open must not look busy.
    const snapshotKeyboard =
      event.type === CUSTOM &&
      current.firstActivity === null &&
      current.fullAt !== null &&
      current.fullAt === timestamp &&
      (event as { data?: { tag?: unknown } }).data?.tag === KEYBOARD_TAG;
    if (event.type === FULL_SNAPSHOT && current.firstActivity === null) current.fullAt = timestamp;
    else if (!snapshotKeyboard) current.fullAt = null;
    if ((state && current.firstActivity === null) || snapshotKeyboard) {
      current.lead += 1;
    } else if (!state) {
      if (current.firstActivity === null) current.firstActivity = timestamp;
      this.dirtySinceCheckout = true;
      this.dirtySinceSend = true;
    }
    return this.enforceBound();
  }

  /**
   * The window to send for an error that happened at `at` (default now),
   * from a snapshot. A segment that starts before the 60 s cutoff with
   * nothing done in it before the cutoff still counts: its screen state is
   * sent stamped at the cutoff. Empties the buffer when it returns events.
   */
  cut(at: number = this.now()): Cut {
    if (!this.dirtySinceSend) return { kind: "nothing" };
    const cutoff = at - ERROR_WINDOW_MS;
    const target = at - ERROR_MIN_WINDOW_MS;
    const usable = (s: Segment) => s.start >= cutoff || s.firstActivity === null || s.firstActivity >= cutoff;
    let first = lastIndex(this.segments, (s) => s.start <= target);
    if (first < 0 || !usable(this.segments[first])) {
      first = this.segments.findIndex((s) => s.start > target);
    }
    if (first < 0) return { kind: "need-snapshot" };
    const events: BufferedEvent[] = [];
    for (const [i, segment] of this.segments.slice(first).entries()) {
      if (i === 0 && segment.start < cutoff) {
        for (const [j, buffered] of segment.events.entries()) {
          if (j < segment.lead) {
            const event = JSON.parse(buffered.json) as { timestamp: number };
            event.timestamp = Math.max(event.timestamp, cutoff);
            events.push({ json: JSON.stringify(event), type: buffered.type });
          } else {
            events.push(buffered);
          }
        }
      } else {
        events.push(...segment.events);
      }
    }
    this.segments = [];
    this.bytes = 0;
    this.dirtySinceSend = false;
    return { kind: "events", events };
  }

  clear(): void {
    this.lastFullData = null;
    this.segments = [];
    this.bytes = 0;
    this.dirtySinceCheckout = false;
    this.dirtySinceSend = true;
  }

  /** Whole oldest segments go first; true when the last one alone was over the bound and went too. */
  private enforceBound(): boolean {
    while (this.bytes > ERROR_BUFFER_MAX_BYTES && this.segments.length > 1) {
      this.bytes -= this.segments[0].bytes;
      this.segments = this.segments.slice(1);
    }
    if (this.bytes <= ERROR_BUFFER_MAX_BYTES) return false;
    // Unusable without its tail, and nothing older may take its events.
    this.segments = [];
    this.bytes = 0;
    return true;
  }

  private dropSegments(count: number): void {
    if (count <= 0) return;
    for (const s of this.segments.slice(0, count)) this.bytes -= s.bytes;
    this.segments = this.segments.slice(count);
  }
}
