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
 * - With `allowedIframeOrigins`, cross-origin iframes running the SDK are
 *   recorded in place (iframes.ts here, relay.ts in the iframe, VEL-2152).
 *   They keep relaying through an idle expiry, and an interaction inside one
 *   wakes the session.
 * - Console lines become `$console` events (console-record.ts) unless
 *   `console: false`.
 * - Requests become `$network` events; headers and bodies only with the
 *   `network` option, for URLs in its `allowUrls` (network-record.ts).
 * - With a remote minimum duration (VEL-2185, decided with the session's
 *   mode and kept in its record), session mode sends nothing until the
 *   recording, from its first event (`recStart`, kept across the session's
 *   pages) to its last, is that long; a shorter one dies with the page. Past
 *   {@link MIN_DURATION_HOLD_MAX_BYTES} held it is sent anyway (the outbox
 *   bound would otherwise drop its snapshot), and once sent a recording never
 *   holds again. Error mode always sends.
 * - A trigger hit (VEL-2187, session.ts) promotes an `off` or `error` session
 *   to session mode: `promote()` queues the error buffer at once, as an error
 *   would, then the recorder restarts in session mode from a new full
 *   snapshot on the next task, so the minimum duration counts from there.
 *   Every switch from error to session mode in the same session (the tick
 *   included, at the end of a quota pause) sends the buffer first.
 */
import { CONSOLE_LEVELS, observeConsole } from "../console.js";
import { absoluteWithoutQuery, observeNetwork, sdkRequestMatcher } from "../network.js";
import { canvasBudgetFull, canvasFilter } from "./canvas.js";
import { CONSOLE_TAG, consoleRecorder } from "./console-record.js";
import { iframeBridge } from "./iframes.js";
import { networkRecorder } from "./network-record.js";
import type { ChunkMode, ReplayChunk } from "./sender.js";
import { MAX_CHUNK_BYTES, MAX_OUTBOX_BYTES, ReplaySender } from "./sender.js";
import type {
  Recording,
  RecordingContext,
  ReplaySession,
  SessionReplayOptions,
} from "./session.js";
import { canvasSettings, QUOTA_PAUSE_KEY } from "./session.js";

export const DEFAULT_MASK_SELECTOR = "[data-cohorly-mask]";
export const DEFAULT_BLOCK_SELECTOR = "[data-cohorly-block]";
export const FLUSH_INTERVAL_MS = 5000;
export const MAX_CHUNK_EVENTS = 1000;
export { MAX_CHUNK_BYTES };
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
export { CONSOLE_TAG };
/** A recording held by its minimum duration is sent anyway past this much (serialized). */
export const MIN_DURATION_HOLD_MAX_BYTES = MAX_OUTBOX_BYTES / 2;

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

/** An iframe's full snapshot, inserted by rrweb as a mutation (any iframe, same-origin ones too). */
function isAttachIframe(event: RrwebEvent): boolean {
  return event.type === INCREMENTAL && (event.data as { isAttachIframe?: unknown } | undefined)?.isAttachIframe === true;
}

function isInteraction(event: RrwebEvent | null | undefined): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    event.type === INCREMENTAL &&
    INTERACTION_SOURCES.has((event.data as { source?: number } | undefined)?.source ?? -1)
  );
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
 *
 * `canvas: false` leaves the canvas keys out whatever the option says: the
 * session's canvas budget is spent (VEL-2176) and rrweb must stop drawing and
 * encoding frames the SDK would drop.
 */
export function recordOptions(
  options: SessionReplayOptions,
  { canvas: withCanvas = true }: { canvas?: boolean } = {},
): Record<string, unknown> {
  const canvas = withCanvas ? canvasSettings(options.canvas) : null;
  return {
    maskInputOptions: { ...MASK_INPUT_OPTIONS },
    maskTextSelector: combineSelectors(DEFAULT_MASK_SELECTOR, options.maskTextSelector),
    blockSelector: combineSelectors(DEFAULT_BLOCK_SELECTOR, options.blockSelector),
    // A numeric sampling.canvas is rrweb's per-frame mode; the default PNG
    // would make every snapshot's canvases huge.
    ...(canvas
      ? {
          recordCanvas: true,
          sampling: { canvas: canvas.fps },
          dataURLOptions: { type: "image/webp", quality: canvas.quality },
        }
      : {}),
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

/** The rrweb type of a serialized event (rrweb writes `type` first; anything else is parsed). */
function serializedType(json: string): number | undefined {
  const match = /^\{"type":(\d+)[,}]/.exec(json);
  if (match) return Number(match[1]);
  try {
    const type = (JSON.parse(json) as { type?: unknown }).type;
    return typeof type === "number" ? type : undefined;
  } catch {
    return undefined;
  }
}

let handoff: { apiHost: string; token: string | undefined; chunks: ReplayChunk[] } | null = null;

/** Drops what a stopped recorder handed on (opt-out while an iframe relay had it suspended). */
export function discardHandoff(): void {
  handoff = null;
}
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
  /** `canvas`: rrweb was asked for canvas frames. */
  let recorder: { mode: ChunkMode; sessionId: string; canvas: boolean; stop: () => void } | null = null;
  let record: RecordFn | null = null;
  let generation = 0;
  /** Session mode's events not queued yet, serialized once, with their size and the last one's timestamp. */
  let pending: string[] = [];
  let pendingBytes = 0;
  let lastPendingAt: number | undefined;
  /** The session-mode recording's first event (the session's `recStart`). */
  let recStart: number | undefined;
  /** The minimum duration of the recording's session (0 outside session mode). */
  let minDuration = 0;
  /** Reached once (by time or by size): this recording never holds again. */
  let minReached = true;
  let segments: Segment[] = [];
  let bufferBytes = 0;
  /** Something besides page state was buffered since the last checkout / the last error send. */
  let dirtySinceCheckout = false;
  let dirtySinceSend = true;
  let lastErrorSend = Number.NEGATIVE_INFINITY;
  let errorSendTimer: ReturnType<typeof setTimeout> | null = null;
  /** `$network` reports waiting for bodies (each settles within 2 s): an error send waits for them. */
  const pendingReads = new Set<Promise<void>>();
  let waitingForReads = false;
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
  /** Cross-origin iframes recorded in place; null without `allowedIframeOrigins` or in a child frame. */
  const iframes = iframeBridge({
    origins: options.allowedIframeOrigins,
    blockSelector: recordOptions(options).blockSelector as string,
    // An interaction inside an iframe while the recorder sleeps after an idle expiry wakes it like one here.
    onChildEvent: (event) => {
      if (wakeArmed && isInteraction(event as RrwebEvent)) onWake();
    },
  });

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
        clearPending();
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

  /**
   * Chunks of at most 1000 events and ~1 MB serialized, from already
   * serialized events. A Meta and the FullSnapshot right after it always go
   * in the same chunk, even past those limits (the Meta alone is unplayable).
   */
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
    let hasSnapshot = false;
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
          ...(hasSnapshot ? { hasSnapshot } : {}),
        }),
      );
      part = [];
      bytes = 2;
      hasSnapshot = false;
    };
    const types = serialized.map(serializedType);
    for (let i = 0; i < serialized.length; ) {
      const size = types[i] === META && types[i + 1] === FULL_SNAPSHOT ? 2 : 1;
      const unit = serialized.slice(i, i + size);
      const unitBytes = unit.reduce((sum, event) => sum + event.length + 1, 0);
      if (
        part.length > 0 &&
        (part.length + size > MAX_CHUNK_EVENTS || bytes + unitBytes > MAX_CHUNK_BYTES)
      ) {
        close();
      }
      part.push(...unit);
      bytes += unitBytes;
      if (types.slice(i, i + size).includes(FULL_SNAPSHOT)) hasSnapshot = true;
      i += size;
    }
    close();
    sender.enqueue(chunks, send);
  };

  function clearPending(): void {
    pending = [];
    pendingBytes = 0;
    lastPendingAt = undefined;
  }

  /** Shorter than the minimum duration: nothing leaves, no seq is taken, the snapshot stays first. */
  const heldByMinDuration = (): boolean => {
    if (minReached) return false;
    const long =
      recStart !== undefined && lastPendingAt !== undefined && lastPendingAt - recStart >= minDuration;
    if (long || pendingBytes > MIN_DURATION_HOLD_MAX_BYTES) minReached = true;
    return !minReached;
  };

  const flushPending = (send = true) => {
    if (!recorder || recorder.mode !== "session" || pending.length === 0) return;
    if (heldByMinDuration()) return;
    const events = pending;
    clearPending();
    enqueue(recorder.sessionId, "session", events, send);
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
    // A cross-origin iframe's snapshot (relayed by its child) is page state. The
    // same mutation from a same-origin iframe stays activity, as it always was.
    const state = STATE_TYPES.has(event.type) || (isAttachIframe(event) && iframes?.fromChild() === true);
    if (state && current.firstActivity === null) {
      current.lead += 1;
    } else if (!state) {
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

  const canvasOn = canvasSettings(options.canvas) !== null;
  /** The recorder generation a canvas-off restart was already asked for (one per recorder). */
  let cappedGeneration = -1;
  const limitCanvas = canvasFilter(ctx.log, {
    storage: ctx.sessionStorage,
    // The session's canvas budget is spent: rrweb keeps drawing and encoding
    // frames that would all be dropped, so the recorder restarts without canvas
    // (a new full snapshot, same session, pending events queued first). Only a
    // recorder that asks for canvas: a child iframe's frames (the parent
    // records none) are dropped by the filter and restarting would not stop them.
    onCeiling: (sessionId) => {
      if (halted || !recorder?.canvas || recorder.mode !== "session" || recorder.sessionId !== sessionId) return;
      if (cappedGeneration === generation) return;
      cappedGeneration = generation;
      ctx.log("session replay canvas budget spent, recording goes on without canvas");
      const mine = generation;
      // Never from inside rrweb's emit: on the next task, if nothing restarted it since.
      setTimeout(() => {
        if (halted || generation !== mine || store.active()?.id !== sessionId) return;
        restart();
      }, 0);
    },
  });

  const emit = (raw: RrwebEvent) => {
    if (halted || !recorder) return;
    // Before the session checks: rrweb listens on an attached iframe's window whether or not the event is kept.
    if (raw.type === FULL_SNAPSHOT || isAttachIframe(raw)) iframes?.guard();
    let event = raw;
    if (event.type === META) {
      // The page URL never carries its query or fragment.
      const data = event.data as { href?: unknown } | undefined;
      if (typeof data?.href === "string") {
        event = { ...event, data: { ...data, href: strippedUrl(data.href) } };
      }
    }
    const interaction = isInteraction(event);
    const session = interaction ? store.touch() : store.active();
    // Expired (the next tick stops the recorder): these events belong to no one.
    if (!session) return;
    if (session.id !== recorder.sessionId) {
      // Rotated under this recorder (the rotation restarts it): an
      // interaction, the one that woke the session included, is kept for
      // the new session's recording. Never one an iframe relayed: its ids
      // were mapped by this recorder, and the iframe sends a new snapshot.
      if (interaction && !iframes?.fromChild() && session.id === store.last().id) {
        if (carried?.sessionId !== session.id) carried = { sessionId: session.id, events: [] };
        if (carried.events.length < MAX_CARRIED_EVENTS) carried.events.push(event);
      }
      return;
    }
    const kept = limitCanvas(event, {
      budget: recorder.mode === "session",
      sessionId: recorder.sessionId,
      pixels: recorder.canvas || iframes?.fromChild() === true,
    });
    if (!kept) return;
    event = kept;
    accept(event);
    // Every full snapshot (start, checkout, rotation) serializes iframes empty: ask them again.
    if (event.type === FULL_SNAPSHOT) iframes?.snapshot();
    if (event.type === FULL_SNAPSHOT && carried?.sessionId === recorder.sessionId) {
      const { events } = carried;
      carried = null;
      for (const e of events) accept({ ...e, timestamp: Math.max(e.timestamp, event.timestamp) });
    }
  };

  function accept(event: RrwebEvent): void {
    if (!recorder) return;
    if (recorder.mode === "session") {
      if (recStart === undefined) {
        recStart = event.timestamp;
        store.setRecStart(recorder.sessionId, recStart);
      }
      const json = JSON.stringify(event);
      pending.push(json);
      pendingBytes += json.length;
      lastPendingAt = event.timestamp;
      // A Meta waits for its FullSnapshot (rrweb emits it right after): the pair goes in one chunk.
      const due =
        pending.length >= MAX_CHUNK_EVENTS || (!minReached && pendingBytes > MIN_DURATION_HOLD_MAX_BYTES);
      if (due && event.type !== META) flushPending();
    } else {
      pushToBuffer(event);
    }
  }

  const network = networkRecorder(options.network, ctx.log);
  let unobserve: (() => void) | null = observeNetwork({
    wants: (url) => !halted && recorder !== null && isHttp(url) && !isCohorly(url),
    detail: (url) => network.detail(url),
    // The reading code comes from here, so the breadcrumbs never load it.
    capture: network.capture,
    reading: (reported) => {
      pendingReads.add(reported);
      const drop = () => pendingReads.delete(reported);
      reported.then(drop, drop);
    },
    done: (request) => {
      if (!recorder || halted) return;
      record?.addCustomEvent?.(NETWORK_TAG, network.payload(request));
    },
  });

  // Subscribed once, like the network: a recorder restart keeps the wrapper and the line limit.
  const consoleLines =
    options.console === false
      ? null
      : consoleRecorder({
          recording: () => !halted && recorder !== null && store.active()?.id === recorder.sessionId,
          session: () => recorder?.sessionId ?? null,
          add: (payload) => record?.addCustomEvent?.(CONSOLE_TAG, payload),
        });
  let unobserveConsole: (() => void) | null = consoleLines
    ? observeConsole({ levels: CONSOLE_LEVELS, call: consoleLines.line })
    : null;

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

  /** The bridge stays attached: the iframes keep relaying across restarts and an idle expiry. */
  const stopRecorder = () => {
    generation += 1;
    if (recorder) {
      consoleLines?.flush();
      flushPending();
      try {
        recorder.stop();
      } catch {
        // rrweb teardown errors must not reach the app
      }
    }
    recorder = null;
    clearPending();
    segments = [];
    bufferBytes = 0;
  };

  const startRecorder = (session: ReplaySession, mode: ChunkMode) => {
    const mine = ++generation;
    load()
      .then((mod) => {
        if (halted || mine !== generation) return;
        record = mod.record;
        // A session whose canvas budget is spent (on an earlier page load too) records without canvas.
        const canvas = canvasOn && !(mode === "session" && canvasBudgetFull(ctx.sessionStorage, session.id));
        recorder = { mode, sessionId: session.id, canvas, stop: () => {} };
        recStart = mode === "session" ? session.recStart : undefined;
        minDuration = mode === "session" ? (session.minDurationMs ?? 0) : 0;
        minReached = minDuration <= 0;
        dirtySinceSend = true;
        dirtySinceCheckout = false;
        // Before record(): its message filter must run ahead of rrweb's listener.
        iframes?.attach();
        const stop = mod.record({
          ...recordOptions(options, { canvas }),
          ...(iframes ? { recordCrossOriginIframes: true } : {}),
          emit,
        });
        if (!recorder || mine !== generation) return;
        recorder.stop = stop ?? (() => {});
        iframes?.started();
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
      // Expired: the iframes keep relaying, an interaction in one wakes it (no stop).
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
      iframes?.release();
      return;
    }
    startRecorder(session, mode);
  }

  const tick = setInterval(() => {
    if (halted) return;
    flushPending();
    const session = store.active();
    if (!session) {
      // Expired without activity: stop recording until something happens,
      // here or inside a relaying iframe (no stop sent to them).
      if (recorder) stopRecorder();
      armWake();
      return;
    }
    // The quota pause ran out (or began in another tab), or a trigger promoted
    // the session before its own switch ran: switch modes.
    if (recorder && session.id === recorder.sessionId && ctx.effectiveMode(session) !== recorder.mode) {
      sendBufferBeforeSession(session);
      restart();
    }
  }, FLUSH_INTERVAL_MS);

  // Error mode: a checkout every 30 s, only when something was recorded since the last one.
  const checkouts = setInterval(() => {
    if (!halted && recorder?.mode === "error" && dirtySinceCheckout) takeSnapshot();
  }, CHECKOUT_EVERY_MS);

  const onHidden = (split: boolean) => {
    if (halted) return;
    consoleLines?.flush();
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
    unobserveConsole?.();
    unobserveConsole = null;
    consoleLines?.stop();
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  /** Stops everything for this page load; `keep` hands the queue to a later init(). */
  function halt(keep: boolean): void {
    if (halted) return;
    if (keep) flushPending(false);
    else clearPending();
    segments = [];
    stopRecorder();
    iframes?.release();
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
  const sendErrorBuffer = (keepBuffering = true) => {
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
    if (keepBuffering) takeSnapshot();
  };

  /**
   * The recorder is leaving error mode for session mode in the same session
   * (a trigger hit, or the end of a quota pause): its buffer is sent first, as
   * on an error (its own chunks, mode "error"), or restart() would drop it.
   * The session-mode recording that follows starts from its own snapshot.
   * The one path for that switch; a no-op once the buffer is sent.
   */
  function sendBufferBeforeSession(session: ReplaySession): void {
    if (!recorder || recorder.mode !== "error" || recorder.sessionId !== session.id) return;
    if (ctx.effectiveMode(session) !== "session") return;
    if (errorSendTimer) clearTimeout(errorSendTimer);
    errorSendTimer = null;
    sendErrorBuffer(false);
  }

  /** The SDK captured an exception stamped with the running recorder's session. */
  function handleException(readsDone = false): void {
    if (halted || !recorder) return;
    if (recorder.mode === "session") {
      flushPending();
      return;
    }
    if (errorSendTimer || waitingForReads) return; // a send is already scheduled; it will include this error
    if (!readsDone && pendingReads.size > 0) {
      // A request the app just saw fail is still being read: its `$network`
      // would otherwise land in the next buffer, after this send. Only the
      // reads pending now are waited for, so steady traffic never holds it.
      waitingForReads = true;
      const resume = () => {
        waitingForReads = false;
        handleException(true);
      };
      Promise.all([...pendingReads]).then(resume, resume);
      return;
    }
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
    onModeChange() {
      setTimeout(() => {
        const session = store.active();
        if (!halted && session && ctx.effectiveMode(session) !== (recorder?.mode ?? "off")) restart();
      }, 0);
    },
    promote() {
      if (halted) return;
      const session = store.active();
      // During a quota pause the session still buffers: the tick switches (and sends) when it ends.
      if (!session || ctx.effectiveMode(session) !== "session") return;
      if (recorder?.mode === "session" && recorder.sessionId === session.id) return;
      // Queued now, inside the track() that fired the trigger: a pagehide,
      // reset() or init() right after it finds the buffer in the sender.
      sendBufferBeforeSession(session);
      // The restart waits for the next task (it may run inside rrweb's emit),
      // for this session only, and only if nothing restarted the recorder
      // since (the tick, a rotation). The new recorder takes recStart from its
      // first event and holds by the session's minimum duration from there.
      const sessionId = session.id;
      const mine = generation;
      setTimeout(() => {
        if (halted || generation !== mine || store.active()?.id !== sessionId) return;
        restart();
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
