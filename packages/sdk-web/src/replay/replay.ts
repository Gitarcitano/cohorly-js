/**
 * Session replay recording (VEL-1782, docs/SESSION-REPLAY.md), loaded by
 * session.ts with a dynamic import() only when a session records or
 * buffers. rrweb (`@rrweb/record`, pinned 2.2.0) is imported from here, again
 * dynamically, so it lands in its own chunk.
 *
 * - "session" mode (sampled by `sampleRate`): everything is recorded and sent
 *   in chunks every 5 s or 1000 events, and when the page is hidden.
 * - "error" mode (sampled by `onErrorSampleRate`): the last 30 to 60 s are
 *   kept in memory and sent only when the SDK captures an `$exception`. The
 *   SDK takes a full snapshot every 30 s when something was recorded since the
 *   previous one, so the buffer can always start at a snapshot.
 * - An expired session (30 min without activity) stops the recorder; the next
 *   interaction or tracked event starts a new session from a full snapshot.
 */
import { absoluteWithoutQuery, observeNetwork, sdkRequestMatcher } from "../network.js";
import type { ChunkMode, ReplayChunk } from "./sender.js";
import { ReplaySender } from "./sender.js";
import type {
  Recording,
  RecordingContext,
  ReplaySession,
  SessionReplayOptions,
} from "./session.js";
import { QUOTA_PAUSE_KEY } from "./session.js";

export const DEFAULT_MASK_SELECTOR = "[data-cohorly-mask]";
export const DEFAULT_BLOCK_SELECTOR = "[data-cohorly-block]";
export const FLUSH_INTERVAL_MS = 5000;
export const MAX_CHUNK_EVENTS = 1000;
/** A chunk is split before sending past this serialized size (the server's wire limit is 1 MB). */
export const MAX_CHUNK_BYTES = 1_000_000 - 1024;
/** Error mode never sends events older than this before the error... */
export const ERROR_WINDOW_MS = 60_000;
/** ...and covers at least this much when the recording is that old. */
export const ERROR_MIN_WINDOW_MS = 30_000;
export const CHECKOUT_EVERY_MS = 30_000;
/** Error mode memory bound (serialized events); whole oldest segments go first. */
export const ERROR_BUFFER_MAX_BYTES = 10 * 1024 * 1024;
/** Minimum time between two error-triggered sends (a later error waits, it is not lost). */
export const ERROR_SEND_GAP_MS = 5000;
export const NETWORK_TAG = "$network";

/** Every input type rrweb knows, plus `hidden`: no input value is ever recorded. */
export const MASK_INPUT_OPTIONS: Readonly<Record<string, true>> = {
  color: true,
  date: true,
  "datetime-local": true,
  email: true,
  month: true,
  number: true,
  range: true,
  search: true,
  tel: true,
  text: true,
  time: true,
  url: true,
  week: true,
  textarea: true,
  select: true,
  password: true,
  hidden: true,
};

// rrweb event types and incremental sources (rrweb 2.x `EventType`, `IncrementalSource`).
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
/** DomContentLoaded, Load, FullSnapshot, Meta: page state, not something that happened. */
const STATE_TYPES = new Set([0, 1, FULL_SNAPSHOT, META]);
const INTERACTION_SOURCES = new Set([1, 2, 3, 5, 6]); // mouse move/interaction, scroll, input, touch
/** DOM events that end an idle stop (listened to only while the session is expired). */
const WAKE_EVENTS = ["pointerdown", "keydown", "scroll", "touchstart", "mousemove", "input"];
/** Interactions recorded after a rotation, before the new recorder is up, carried over at most. */
const MAX_CARRIED_EVENTS = 100;

export interface RrwebEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

/** The part of `@rrweb/record` this SDK uses (declared here, not imported from rrweb). */
export interface RecordFn {
  (options: Record<string, unknown>): (() => void) | undefined;
  addCustomEvent?: (tag: string, payload: unknown) => void;
  takeFullSnapshot?: (isCheckout?: boolean) => void;
}

export interface RecordModule {
  record: RecordFn;
}

function combineSelectors(base: string, extra: unknown): string {
  return typeof extra === "string" && extra.trim() !== "" && extra.trim() !== base
    ? `${base}, ${extra.trim()}`
    : base;
}

/**
 * The rrweb options: every input masked (explicit `maskInputOptions`, since
 * rrweb's `maskAllInputs` leaves hidden inputs out), the Cohorly mask and
 * block selectors always on. No `checkoutEveryNms`: rrweb would take that
 * checkout lazily, right after the event that crossed the interval, so the
 * buffer cut at that checkout would lose the event that caused an error. The
 * SDK times the checkouts instead.
 */
export function recordOptions(options: SessionReplayOptions): Record<string, unknown> {
  return {
    maskInputOptions: { ...MASK_INPUT_OPTIONS },
    maskTextSelector: combineSelectors(DEFAULT_MASK_SELECTOR, options.maskTextSelector),
    blockSelector: combineSelectors(DEFAULT_BLOCK_SELECTOR, options.blockSelector),
  };
}

/** Requests rrweb must not show: the SDK's own traffic to the Cohorly API. */
function cohorlyMatcher(apiHost: string): (url: string) => boolean {
  const base = absoluteWithoutQuery(apiHost)?.replace(/\/+$/, "");
  if (base === undefined) return () => false;
  // apiHost IS the page's origin (same-origin proxy at the root): only the
  // SDK's endpoints, the app's other requests there still count.
  const pageOrigin = typeof location !== "undefined" ? location.origin : undefined;
  if (base === pageOrigin) return sdkRequestMatcher(apiHost);
  return (url) => {
    const absolute = absoluteWithoutQuery(url);
    return absolute !== undefined && (absolute === base || absolute.startsWith(`${base}/`));
  };
}

/** Only http(s) requests are recorded (never data:, blob:, ...). */
function isHttp(url: string): boolean {
  try {
    const { protocol } = new URL(url, location.href);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function strippedUrl(url: string): string {
  return absoluteWithoutQuery(url) ?? url.split(/[?#]/)[0];
}

let loading: Promise<RecordModule> | null = null;

/** The rrweb record module, imported once per page. */
export function loadRecorder(): Promise<RecordModule> {
  if (!loading) {
    loading = import("@rrweb/record").then((mod) => mod as unknown as RecordModule);
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** What a stopped sender left (re-init on the same page adopts it when the target is the same). */
function lastIndex<T>(list: T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i])) return i;
  return -1;
}

let handoff: { apiHost: string; token: string | undefined; chunks: ReplayChunk[] } | null = null;
let batches = 0;

interface Segment {
  /** Timestamp of its Meta event (the start of a full snapshot). */
  start: number;
  /** Serialized events. */
  events: string[];
  /** How many leading events are page state (snapshot), not activity. */
  lead: number;
  /** Timestamp of the first event that is not page state, or null. */
  firstActivity: number | null;
  bytes: number;
}

export interface RecordingDeps {
  /** rrweb loader (tests inject a stand-in). */
  load?: () => Promise<RecordModule>;
}

export function startRecording(
  options: SessionReplayOptions,
  ctx: RecordingContext,
  recordingDeps: RecordingDeps = {},
): Recording {
  const { store } = ctx;
  const load = recordingDeps.load ?? loadRecorder;
  let halted = false; // stop(), optOut() or 404
  let recorder: { mode: ChunkMode; sessionId: string; stop: () => void } | null = null;
  let record: RecordFn | null = null;
  let generation = 0;
  let pending: RrwebEvent[] = [];
  let segments: Segment[] = [];
  let bufferBytes = 0;
  /** Something besides page state was buffered since the last checkout / the last error send. */
  let dirtySinceCheckout = false;
  let dirtySinceSend = true;
  let lastErrorSend = Number.NEGATIVE_INFINITY;
  let errorSendTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotRequested = false;
  /** The session the last restart() set up (recording or not). */
  let targetSessionId: string | null = null;
  let wakeArmed = false;
  /**
   * Interactions the outgoing recorder saw after the rotation they caused:
   * they belong to the new session, and go in right after its first full
   * snapshot (DOM mutations are not carried, the snapshot already has them).
   */
  let carried: { sessionId: string; events: RrwebEvent[] } | null = null;
  /** An exception stamped with a session whose recorder is still starting. */
  let pendingException: string | null = null;
  const isCohorly = cohorlyMatcher(ctx.apiHost);

  const takeSnapshot = () => {
    try {
      record?.takeFullSnapshot?.(true);
    } catch {
      // rrweb errors must not reach the app
    }
  };

  /** A snapshot on the next task (never from inside rrweb's emit). */
  const requestSnapshot = () => {
    if (snapshotRequested) return;
    snapshotRequested = true;
    setTimeout(() => {
      snapshotRequested = false;
      if (!halted && recorder) takeSnapshot();
    }, 0);
  };

  const sender = new ReplaySender({
    apiHost: ctx.apiHost,
    token: ctx.token,
    maxRetryDelayMs: ctx.maxRetryDelayMs,
    nextSeq: (sessionId) => store.takeSeq(sessionId),
    log: ctx.log,
    onQuotaExceeded: (retryAfterMs) => {
      ctx.localStorage.set(QUOTA_PAUSE_KEY, String(Date.now() + retryAfterMs));
      ctx.log("replay quota exceeded, session recording paused");
      if (recorder?.mode === "session") {
        pending = [];
        restart();
      }
    },
    onGone: () => halt(false),
    onDropped: (chunk) => {
      // Later session-mode chunks would replay against a DOM the player
      // never saw: a fresh snapshot makes them playable again.
      if (chunk.mode === "session" && recorder?.mode === "session") requestSnapshot();
    },
  });
  if (handoff && handoff.apiHost === ctx.apiHost && handoff.token === ctx.token) {
    sender.adopt(handoff.chunks);
  }
  handoff = null;

  /** Chunks of at most 1000 events and ~1 MB serialized, from already serialized events. */
  const enqueue = (
    sessionId: string,
    mode: ChunkMode,
    serialized: string[],
    send = true,
    batch?: number,
  ) => {
    const distinctId = ctx.getDistinctId();
    const chunks: ReplayChunk[] = [];
    let part: string[] = [];
    let bytes = 2;
    const close = () => {
      if (part.length === 0) return;
      chunks.push(
        sender.chunk({
          sessionId,
          distinctId,
          mode,
          eventsJson: `[${part.join(",")}]`,
          count: part.length,
          ...(batch !== undefined ? { batch } : {}),
        }),
      );
      part = [];
      bytes = 2;
    };
    for (const event of serialized) {
      if (part.length >= MAX_CHUNK_EVENTS || (part.length > 0 && bytes + event.length + 1 > MAX_CHUNK_BYTES)) {
        close();
      }
      part.push(event);
      bytes += event.length + 1;
    }
    close();
    sender.enqueue(chunks, send);
  };

  const flushPending = (send = true) => {
    if (!recorder || recorder.mode !== "session" || pending.length === 0) return;
    const events = pending;
    pending = [];
    enqueue(
      recorder.sessionId,
      "session",
      events.map((e) => JSON.stringify(e)),
      send,
    );
  };

  const pushToBuffer = (event: RrwebEvent) => {
    const json = JSON.stringify(event);
    if (event.type === META) {
      segments.push({ start: event.timestamp, events: [json], lead: 1, firstActivity: null, bytes: json.length });
      bufferBytes += json.length;
      dirtySinceCheckout = false;
      // An error send starts at the newest segment at least 30 s old, or a
      // later one: nothing before the newest such segment can be sent again.
      dropSegments(lastIndex(segments, (s) => s.start <= Date.now() - ERROR_MIN_WINDOW_MS));
      return;
    }
    const current = segments[segments.length - 1];
    if (!current) return; // no snapshot yet: unusable on its own
    current.events.push(json);
    current.bytes += json.length;
    bufferBytes += json.length;
    if (STATE_TYPES.has(event.type) && current.firstActivity === null) {
      current.lead += 1;
    } else if (!STATE_TYPES.has(event.type)) {
      if (current.firstActivity === null) current.firstActivity = event.timestamp;
      dirtySinceCheckout = true;
      dirtySinceSend = true;
    }
    if (bufferBytes > ERROR_BUFFER_MAX_BYTES) {
      if (segments.length > 1) {
        let drop = 0;
        while (drop < segments.length - 1 && bufferBytes > ERROR_BUFFER_MAX_BYTES) {
          bufferBytes -= segments[drop].bytes;
          drop += 1;
        }
        segments = segments.slice(drop);
      } else {
        // One segment over the bound: a checkout starts a new one, the old one then goes.
        requestSnapshot();
      }
    }
  };

  const dropSegments = (count: number) => {
    if (count <= 0) return;
    for (const s of segments.slice(0, count)) bufferBytes -= s.bytes;
    segments = segments.slice(count);
  };

  const emit = (raw: RrwebEvent) => {
    if (halted || !recorder) return;
    let event = raw;
    if (event.type === META) {
      // The page URL never carries its query or fragment.
      const data = event.data as { href?: unknown } | undefined;
      if (typeof data?.href === "string") {
        event = { ...event, data: { ...data, href: strippedUrl(data.href) } };
      }
    }
    const interaction =
      event.type === INCREMENTAL &&
      INTERACTION_SOURCES.has((event.data as { source?: number } | undefined)?.source ?? -1);
    const session = interaction ? store.touch() : store.active();
    // Expired (the next tick stops the recorder): these events belong to no one.
    if (!session) return;
    if (session.id !== recorder.sessionId) {
      // Rotated under this recorder (the rotation restarts it): an
      // interaction, the one that woke the session included, is kept for
      // the new session's recording.
      if (interaction && session.id === store.last().id) {
        if (carried?.sessionId !== session.id) carried = { sessionId: session.id, events: [] };
        if (carried.events.length < MAX_CARRIED_EVENTS) carried.events.push(event);
      }
      return;
    }
    accept(event);
    if (event.type === FULL_SNAPSHOT && carried?.sessionId === recorder.sessionId) {
      const { events } = carried;
      carried = null;
      for (const e of events) accept({ ...e, timestamp: Math.max(e.timestamp, event.timestamp) });
    }
  };

  function accept(event: RrwebEvent): void {
    if (!recorder) return;
    if (recorder.mode === "session") {
      pending.push(event);
      if (pending.length >= MAX_CHUNK_EVENTS) flushPending();
    } else {
      pushToBuffer(event);
    }
  }

  let unobserve: (() => void) | null = observeNetwork({
    wants: (url) => !halted && recorder !== null && isHttp(url) && !isCohorly(url),
    done: (request) => {
      if (!recorder || halted) return;
      record?.addCustomEvent?.(NETWORK_TAG, {
        method: request.method,
        url: strippedUrl(request.url),
        status: request.status ?? 0,
        duration_ms: request.durationMs,
      });
    },
  });

  const onWake = () => {
    disarmWake();
    if (halted) return;
    const session = store.touch(); // rotates the expired session
    if (!recorder && targetSessionId !== session.id) restart();
  };
  function armWake(): void {
    if (wakeArmed) return;
    wakeArmed = true;
    for (const type of WAKE_EVENTS) {
      window.addEventListener(type, onWake, { capture: true, passive: true });
    }
  }
  function disarmWake(): void {
    if (!wakeArmed) return;
    wakeArmed = false;
    for (const type of WAKE_EVENTS) {
      window.removeEventListener(type, onWake, { capture: true });
    }
  }

  const stopRecorder = () => {
    generation += 1;
    if (recorder) {
      flushPending();
      try {
        recorder.stop();
      } catch {
        // rrweb teardown errors must not reach the app
      }
    }
    recorder = null;
    pending = [];
    segments = [];
    bufferBytes = 0;
  };

  const startRecorder = (session: ReplaySession, mode: ChunkMode) => {
    const mine = ++generation;
    load()
      .then((mod) => {
        if (halted || mine !== generation) return;
        record = mod.record;
        recorder = { mode, sessionId: session.id, stop: () => {} };
        dirtySinceSend = true;
        dirtySinceCheckout = false;
        const stop = mod.record({ ...recordOptions(options), emit });
        if (!recorder || mine !== generation) return;
        recorder.stop = stop ?? (() => {});
        // An exception captured while this recorder was starting.
        if (pendingException === recorder.sessionId) {
          pendingException = null;
          handleException();
        }
      })
      .catch((err: unknown) => ctx.log("session replay could not load rrweb", err));
  };

  /** (Re)starts the recorder for the live session, or stops it when there is nothing to record. */
  function restart(): void {
    if (halted) return;
    stopRecorder();
    disarmWake();
    const session = store.active();
    if (!session) {
      armWake();
      return;
    }
    targetSessionId = session.id;
    if (carried?.sessionId !== session.id) carried = null;
    if (pendingException !== session.id) pendingException = null;
    const mode = ctx.effectiveMode(session);
    if (mode === "off") {
      carried = null;
      pendingException = null;
      return;
    }
    startRecorder(session, mode);
  }

  const tick = setInterval(() => {
    if (halted) return;
    flushPending();
    const session = store.active();
    if (!session) {
      // Expired without activity: stop recording until something happens.
      if (recorder) stopRecorder();
      armWake();
      return;
    }
    // The quota pause ran out (or began in another tab): switch modes.
    if (recorder && session.id === recorder.sessionId && ctx.effectiveMode(session) !== recorder.mode) {
      restart();
    }
  }, FLUSH_INTERVAL_MS);

  // Error mode: a checkout every 30 s, only when something was recorded since the last one.
  const checkouts = setInterval(() => {
    if (!halted && recorder?.mode === "error" && dirtySinceCheckout) takeSnapshot();
  }, CHECKOUT_EVERY_MS);

  const onHidden = (split: boolean) => {
    if (halted) return;
    // Queued without a regular send: the keepalive requests are the ones
    // that survive the page.
    flushPending(false);
    void sender.flushKeepalive(split);
  };
  const onPageHide = () => onHidden(true);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onHidden(false);
  };
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  function teardown(): void {
    clearInterval(tick);
    clearInterval(checkouts);
    if (errorSendTimer) clearTimeout(errorSendTimer);
    errorSendTimer = null;
    disarmWake();
    unobserve?.();
    unobserve = null;
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  /** Stops everything for this page load; `keep` hands the queue to a later init(). */
  function halt(keep: boolean): void {
    if (halted) return;
    if (keep) flushPending(false);
    else pending = [];
    segments = [];
    stopRecorder();
    halted = true;
    teardown();
    const left = sender.shutdown();
    if (keep) handoff = { apiHost: ctx.apiHost, token: ctx.token, chunks: left };
  }

  /**
   * Error mode: the buffered window, from a full snapshot. It starts at the
   * newest snapshot at least 30 s old when that one has nothing older than
   * 60 s (else at the oldest snapshot inside the last 60 s), and runs to now,
   * so the event that led to the error is always in it.
   */
  const sendErrorBuffer = () => {
    if (halted || !recorder || recorder.mode !== "error") return;
    if (!dirtySinceSend) return; // nothing new since the previous error's send
    const now = Date.now();
    const cutoff = now - ERROR_WINDOW_MS;
    const target = now - ERROR_MIN_WINDOW_MS;
    // A segment that starts before the cutoff is still usable when nothing
    // happened in it before the cutoff (an idle page): its snapshot is then
    // still the page's state at the cutoff, and is sent stamped there.
    const usable = (s: Segment) =>
      s.start >= cutoff || s.firstActivity === null || s.firstActivity >= cutoff;
    let first = lastIndex(segments, (s) => s.start <= target);
    if (first < 0 || !usable(segments[first])) {
      first = segments.findIndex((s) => s.start > target);
    }
    if (first < 0) {
      // Nothing sendable (checkouts throttled in a background tab): a fresh
      // snapshot is the only thing that can go without events older than 60 s.
      takeSnapshot();
      first = segments.findIndex((s) => s.start >= cutoff);
      if (first < 0) return;
    }
    const chosen = segments.slice(first);
    const events: string[] = [];
    for (const [i, segment] of chosen.entries()) {
      if (i === 0 && segment.start < cutoff) {
        for (const [j, json] of segment.events.entries()) {
          if (j < segment.lead) {
            const event = JSON.parse(json) as RrwebEvent;
            event.timestamp = Math.max(event.timestamp, cutoff);
            events.push(JSON.stringify(event));
          } else {
            events.push(json);
          }
        }
      } else {
        events.push(...segment.events);
      }
    }
    const sessionId = recorder.sessionId;
    segments = [];
    bufferBytes = 0;
    dirtySinceSend = false;
    lastErrorSend = now;
    batches += 1;
    enqueue(sessionId, "error", events, true, batches);
    // Keep buffering for the next error, again from a full snapshot.
    takeSnapshot();
  };

  /** The SDK captured an exception stamped with the running recorder's session. */
  function handleException(): void {
    if (halted || !recorder) return;
    if (recorder.mode === "session") {
      flushPending();
      return;
    }
    if (errorSendTimer) return; // a send is already scheduled; it will include this error
    const wait = lastErrorSend + ERROR_SEND_GAP_MS - Date.now();
    if (wait <= 0) {
      sendErrorBuffer();
      return;
    }
    errorSendTimer = setTimeout(() => {
      errorSendTimer = null;
      sendErrorBuffer();
    }, wait);
  }

  restart();

  return {
    onException() {
      if (halted) return;
      // `$exception` is stamped with the tab's session, expired or not.
      const stamped = store.last();
      if (recorder?.sessionId === stamped.id) {
        handleException();
        return;
      }
      // The session rotated (the interaction that woke it, just before this
      // error) and its recorder is not up yet: send under the new id once it
      // is, so the error's `$session_id` always points at the buffer sent.
      if (store.active()?.id === stamped.id && ctx.effectiveMode(stamped) !== "off") {
        pendingException = stamped.id;
      }
    },
    onRotate() {
      // May run inside rrweb's emit (an interaction after the expiry): the
      // recorder restarts on the next task, with a full snapshot.
      setTimeout(() => {
        if (!halted && targetSessionId !== store.active()?.id) restart();
      }, 0);
    },
    beforeReset() {
      if (!halted) flushPending();
    },
    optOut() {
      halt(false);
    },
    stop() {
      halt(true);
    },
  };
}
