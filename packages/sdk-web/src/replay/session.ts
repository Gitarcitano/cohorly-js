/**
 * Session replay entry point that ships in the main bundle (VEL-1782,
 * docs/SESSION-REPLAY.md). Only this module is imported statically: it owns
 * `$session_id` and the sampling decision, and loads `replay.ts` (with the
 * sender and rrweb) with a dynamic import() only when a session records or
 * buffers. A page without `sessionReplay`, or whose session is sampled out,
 * never downloads them.
 *
 * `$session_id` is per tab: the record (id, last activity, sampling
 * decision, next chunk seq) lives in sessionStorage, so a reload continues
 * it and another tab has its own. It rotates after 30 minutes without
 * activity (a tracked event or a recorded interaction) or 24 hours of total
 * length, but only when activity arrives: an idle tab keeps its expired
 * session until something happens. `reset()` rotates at once.
 *
 * With `remoteConfig` (VEL-2185) the project's saved settings
 * (remote-config.ts) win field by field over the code's. A new session born
 * before they are known is `pending`: it has its id at once, and `settle`
 * decides it when they arrive (or after 3 s). A session minted when the
 * settings in memory are an hour old, or older than the stored copy, reads
 * them again first. The minimum duration is decided with the mode and kept
 * in the session's record, so a session never changes it.
 *
 * The saved triggers (VEL-2187, triggers.ts) exist only with `remoteConfig`
 * and come from the settings in `effective`: until they are adopted there is
 * none, so an event tracked before that never fires one. In a session that is
 * `off` or `error`, a matching event (a `track()`, never `$exception` or
 * `$metric`, on its final properties, `$session_id` included), path (on load
 * and on each SPA navigation; a match in an expired session opens the next
 * one, as a tracked event does) or flag (each time the flags load) draws the
 * trigger's rate once and marks it used for the session, hit or miss, in the
 * session's record: a reload never fires it again. A hit promotes the session
 * to `session` mode for good (a trigger never stops a recording); a session
 * already recording ignores triggers.
 */
import type { CohorlyStorage, FlagResult } from "@cohorly/core";
import { uuid } from "@cohorly/core";
import { onNavigation } from "../navigation.js";
import type { RemoteReplayConfig, ReplayConfigLoad } from "./remote-config.js";
import { loadReplayConfig, REPLAY_CONFIG_TTL_MS, readReplayConfig } from "./remote-config.js";
import type { ReplayTrigger } from "./triggers.js";
import { eventMatches, flagMatches, matchesUrlPattern, NON_TRIGGER_EVENTS } from "./triggers.js";

export interface SessionReplayOptions {
  /**
   * Reads the project's replay settings (Settings > Session replay) from the
   * server (VEL-2185). Default false: the code decides and the settings are
   * ignored. With true, each field the project saved (`sampleRate`,
   * `onErrorSampleRate`, the minimum duration) wins over the code's, a field it
   * never saved keeps the code's value, and with no network and no cached copy
   * the code's values apply. Kept for 1 hour per token; applies to new
   * sessions only. Masking, blocking and iframe origins always come from the
   * code. Replay starts even with both rates at 0 here.
   */
  remoteConfig?: boolean;
  /** Share of sessions recorded whole, 0..1. Default 0. */
  sampleRate?: number;
  /**
   * Share of the remaining sessions that keep the last 30 to 60 seconds in
   * memory and send them when an exception is captured, 0..1. Default 0.
   * Needs exception capture (`captureExceptions` or `captureException()`).
   */
  onErrorSampleRate?: number;
  /**
   * Extra CSS selector whose text is masked. `[data-cohorly-mask]` is always
   * masked too.
   */
  maskTextSelector?: string;
  /**
   * Extra CSS selector of elements never recorded (a placeholder of the same
   * size is). `[data-cohorly-block]` is always blocked too.
   */
  blockSelector?: string;
  /**
   * Exact origins (`"https://pay.example.com"`) of cross-origin iframes
   * recorded inside this page's replay, and, in an iframe, of the parent page
   * allowed to record it. Both pages must run the SDK and list each other.
   * Empty by default; an item that is not an exact http(s) origin (`"*"`, a
   * path, a trailing slash) is ignored with a debug log. In the iframe, its
   * own `maskTextSelector` and `blockSelector` apply, and it relays even with
   * both rates at 0 (the parent decides).
   */
  allowedIframeOrigins?: string[];
  /**
   * Records the content of every `<canvas>` (2D and WebGL) as WebP images, at
   * most `fps` frames per second per canvas. Off unless this is an object
   * (`{}` turns it on with the defaults). Canvases are recorded as pixels:
   * text masking does not apply to them, only `[data-cohorly-block]` and
   * `blockSelector` keep one out. Costs CPU and bytes, see the docs.
   */
  canvas?: {
    /** Frames per second per canvas, 1 to 12 (clamped). Default 2. */
    fps?: number;
    /** WebP quality, 0.1 to 1 (clamped). Default 0.4. */
    quality?: number;
  };
  /**
   * Records `console.log`, `info`, `warn` and `error` as `$console` events,
   * scrubbed of e-mails, tokens and card numbers, at most 500 lines a minute.
   * Default true; `false` records none and leaves the console unwrapped.
   */
  console?: boolean;
  /**
   * Records headers and/or bodies of the requests whose URL is in `allowUrls`
   * (VEL-2145). Off by default: without it, or with an empty `allowUrls`,
   * `$network` keeps only method, URL without query, status and duration.
   * Secret headers are always removed and bodies are scrubbed and cut at
   * 16 KiB, but a body can still carry personal data: `redact` is where the
   * app removes the rest. See docs/SESSION-REPLAY.md section 5.
   */
  network?: SessionReplayNetworkOptions;
}

/** One side of a recorded request. */
export interface NetworkMessage {
  /** Lower-case names. */
  headers?: Record<string, string>;
  body?: string;
}

/** What `redact` gets, and returns (or null to record no headers and no bodies). */
export interface NetworkEntry {
  method: string;
  /** Absolute, without query or fragment. */
  url: string;
  /** 0 for a network error. */
  status: number;
  kind: "fetch" | "xhr";
  request: NetworkMessage;
  response?: NetworkMessage;
}

export interface SessionReplayNetworkOptions {
  /** Request and response headers. Default false. */
  headers?: boolean;
  /** Request and response bodies (text types, 16 KiB each). Default false. */
  bodies?: boolean;
  /**
   * URLs whose headers and bodies are recorded, tested against the absolute
   * URL without query or fragment: a string matches as a prefix, a RegExp by
   * `test`. Empty or absent: nothing beyond the basics.
   */
  allowUrls?: (string | RegExp)[];
  /** Last say on each recorded entry; throwing records it without headers and bodies. */
  redact?: (entry: NetworkEntry) => NetworkEntry | null;
}

export const SESSION_KEY = "chl_replay_session";
/** sessionStorage marker of the page that owns the tab's session (duplicate tab detection). */
export const TAB_KEY = "chl_replay_tab";
/** localStorage: session-mode recording is paused by the replay quota until this time (ms). */
export const QUOTA_PAUSE_KEY = "chl_replay_quota_until";
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
/** Activity is persisted at most this often (the in-memory value is exact, and pagehide writes it). */
const ACTIVITY_WRITE_MS = 5000;
/** SDK-internal events: stamped with the session id, but never count as activity. */
const INTERNAL_EVENTS = new Set(["$metric", "$feature_flag_called", "$exception"]);

/** What a session records: everything, the buffer sent on errors, or nothing. */
export type ReplayMode = "session" | "error" | "off";
/** A session's mode as stored: `pending` until the remote settings decide it (VEL-2185). */
export type SessionMode = ReplayMode | "pending";

export interface ReplaySession {
  id: string;
  startedAt: number;
  lastActivity: number;
  mode: SessionMode;
  /** The next chunk seq to use. */
  seq: number;
  /** Timestamp of the first rrweb event recorded in session mode (the minimum duration counts from it). */
  recStart?: number;
  /** Session mode holds its events until the recording is this long; decided with the mode, absent = 0. */
  minDurationMs?: number;
  /** Ids of the triggers already drawn in this session, hit or miss (VEL-2187); a record without it reads as []. */
  triggered: string[];
}

function isSession(value: unknown): value is ReplaySession {
  const v = value as Partial<ReplaySession> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(v.id) &&
    typeof v.startedAt === "number" &&
    typeof v.lastActivity === "number" &&
    (v.mode === "session" || v.mode === "error" || v.mode === "off" || v.mode === "pending") &&
    typeof v.seq === "number" &&
    Number.isInteger(v.seq) &&
    v.seq >= 0 &&
    (v.recStart === undefined || (typeof v.recStart === "number" && Number.isFinite(v.recStart))) &&
    (v.minDurationMs === undefined ||
      (typeof v.minDurationMs === "number" && Number.isFinite(v.minDurationMs) && v.minDurationMs >= 0)) &&
    (v.triggered === undefined ||
      (Array.isArray(v.triggered) && v.triggered.every((id) => typeof id === "string")))
  );
}

/** One token per page load: tells this page's own marker from one copied into a duplicated tab. */
const PAGE_TOKEN = uuid();

function currentNavigationType(): string {
  try {
    const entry = performance.getEntriesByType?.("navigation")?.[0] as
      | { type?: string }
      | undefined;
    if (typeof entry?.type === "string") return entry.type;
    const legacy = (performance as { navigation?: { type?: number } }).navigation?.type;
    if (legacy === 1) return "reload";
    if (legacy === 2) return "back_forward";
  } catch {
    // no Performance API: treat as a plain navigation
  }
  return "navigate";
}

export interface SessionStoreOptions {
  /** Per-tab storage (sessionStorage). */
  storage: CohorlyStorage;
  /** Decides the mode of a NEW session, once (`pending` leaves it to `setMode`). */
  decideMode: () => SessionMode;
  /** The minimum duration a NEW session decided now records with (read right after `decideMode`). Default 0. */
  minDurationMs?: () => number;
  /** Called after a rotation (activity after expiry, or reset()), with the new session. */
  onRotate?: (session: ReplaySession) => void;
  now?: () => number;
  /** This page load's token (tests). */
  pageToken?: string;
  /** performance navigation type of this page load (tests). */
  navigationType?: string;
}

export class ReplaySessionStore {
  private current: ReplaySession;
  private lastWrite = Number.NEGATIVE_INFINITY;
  /** Next seq of sessions rotated out on this page whose chunks may still be queued. */
  private readonly retired = new Map<string, number>();
  private readonly storage: CohorlyStorage;
  private readonly decideMode: () => SessionMode;
  private readonly minDurationMs?: () => number;
  private readonly onRotate?: (session: ReplaySession) => void;
  private readonly now: () => number;
  private readonly pageToken: string;
  private readonly onPageHide = () => {
    // The next page of this tab (navigation or reload) must not take it for a duplicate.
    this.storage.remove(TAB_KEY);
    this.write(this.current);
  };
  private readonly onPageShow = (event: Event) => {
    // Back from the bfcache: this page owns the tab again.
    if ((event as PageTransitionEvent).persisted) this.storage.set(TAB_KEY, this.pageToken);
  };

  constructor(options: SessionStoreOptions) {
    this.storage = options.storage;
    this.decideMode = options.decideMode;
    this.minDurationMs = options.minDurationMs;
    this.onRotate = options.onRotate;
    this.now = options.now ?? Date.now;
    this.pageToken = options.pageToken ?? PAGE_TOKEN;
    const stored = this.read();
    // A duplicated tab starts with a copy of the original's sessionStorage,
    // marker included (the original page is still open, so its pagehide never
    // removed it). A reload or a navigation in the same tab finds no marker
    // (pagehide removed it), and a later init() on this same page finds its own.
    const marker = this.storage.get(TAB_KEY);
    const navigationType = options.navigationType ?? currentNavigationType();
    const duplicate =
      stored !== null &&
      marker !== null &&
      marker !== this.pageToken &&
      navigationType !== "reload" &&
      navigationType !== "back_forward";
    this.storage.set(TAB_KEY, this.pageToken);
    if (stored && !duplicate) {
      this.current = stored;
    } else {
      this.current = this.mint(this.now());
      this.write(this.current);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
    }
  }

  /** The live session, or null when it expired (it rotates on the next activity). */
  active(): ReplaySession | null {
    return this.expired(this.current, this.now()) ? null : this.current;
  }

  /** The tab's session, expired or not (stamped on events that are not activity). */
  last(): ReplaySession {
    return this.current;
  }

  /** Activity now: rotates an expired session, else moves its last activity. */
  touch(): ReplaySession {
    const now = this.now();
    if (this.expired(this.current, now)) return this.rotate();
    this.current.lastActivity = now;
    if (now - this.lastWrite >= ACTIVITY_WRITE_MS) this.write(this.current);
    return this.current;
  }

  /** A new session with its own sampling decision (expiry with activity, or reset()). */
  rotate(): ReplaySession {
    const old = this.current;
    this.retired.set(old.id, old.seq);
    this.current = this.mint(this.now());
    this.write(this.current);
    this.onRotate?.(this.current);
    return this.current;
  }

  /**
   * Takes the next chunk seq of a session: the live one (persisted, so a
   * reload continues from there) or one rotated out on this page.
   */
  takeSeq(sessionId: string): number {
    if (sessionId === this.current.id) {
      const seq = this.current.seq;
      this.current.seq = seq + 1;
      this.write(this.current);
      return seq;
    }
    const seq = this.retired.get(sessionId) ?? 0;
    this.retired.set(sessionId, seq + 1);
    return seq;
  }

  /** Sets the live session's mode and minimum duration (a pending decision settling), persisted. */
  setMode(sessionId: string, mode: ReplayMode, minDurationMs = 0): void {
    if (sessionId !== this.current.id) return;
    this.current.mode = mode;
    if (minDurationMs > 0) this.current.minDurationMs = minDurationMs;
    else delete this.current.minDurationMs;
    this.write(this.current);
  }

  /** Marks a trigger drawn in the live session (hit or miss), persisted: it never fires again in it. */
  markTriggered(sessionId: string, triggerId: string): void {
    if (sessionId !== this.current.id || this.current.triggered.includes(triggerId)) return;
    this.current.triggered = [...this.current.triggered, triggerId];
    this.write(this.current);
  }

  /**
   * A trigger hit: the live session records whole from now on, persisted. Its
   * minimum duration stays the one decided with it, and counts from the new
   * recording's first event (no `recStart` yet).
   */
  promote(sessionId: string): void {
    if (sessionId !== this.current.id || this.current.mode === "session") return;
    this.current.mode = "session";
    delete this.current.recStart;
    this.write(this.current);
  }

  /** The live session's first session-mode rrweb event, once (later pages of the session keep it). */
  setRecStart(sessionId: string, at: number): void {
    if (sessionId !== this.current.id || this.current.recStart !== undefined) return;
    this.current.recStart = at;
    this.write(this.current);
  }

  /** Removes the page listeners (a later init() builds a new store). */
  dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("pageshow", this.onPageShow);
    }
  }

  private expired(session: ReplaySession, now: number): boolean {
    return (
      now - session.lastActivity > SESSION_IDLE_MS || now - session.startedAt > SESSION_MAX_MS
    );
  }

  private mint(now: number): ReplaySession {
    const mode = this.decideMode();
    const session: ReplaySession = { id: uuid(), startedAt: now, lastActivity: now, mode, seq: 0, triggered: [] };
    const minDurationMs = mode === "pending" ? 0 : (this.minDurationMs?.() ?? 0);
    if (minDurationMs > 0) session.minDurationMs = minDurationMs;
    return session;
  }

  private read(): ReplaySession | null {
    try {
      const raw = this.storage.get(SESSION_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isSession(parsed)) return null;
      parsed.triggered ??= [];
      return parsed;
    } catch {
      return null;
    }
  }

  private write(session: ReplaySession): void {
    this.lastWrite = this.now();
    try {
      this.storage.set(SESSION_KEY, JSON.stringify(session));
    } catch {
      // storage full or blocked: the in-memory session still works
    }
  }
}

export function rate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

export const CANVAS_DEFAULT_FPS = 2;
export const CANVAS_DEFAULT_QUALITY = 0.4;

function clamped(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** The canvas option, normalized: null (off) unless it is an object; fps 1..12, quality 0.1..1. */
export function canvasSettings(value: unknown): { fps: number; quality: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { fps, quality } = value as { fps?: unknown; quality?: unknown };
  return {
    fps: clamped(fps, CANVAS_DEFAULT_FPS, 1, 12),
    quality: clamped(quality, CANVAS_DEFAULT_QUALITY, 0.1, 1),
  };
}

/** Whether replay can do anything with these options (some rate above 0, or the remote settings may set one). */
export function replayWanted(options: SessionReplayOptions | undefined): boolean {
  return (
    !!options &&
    (options.remoteConfig === true || rate(options.sampleRate) > 0 || rate(options.onErrorSampleRate) > 0)
  );
}

/** The settings a session is decided and recorded with. */
export interface EffectiveReplayConfig {
  sampleRate: number;
  onErrorSampleRate: number;
  /** Session mode sends nothing until the recording is this long; remote only (0 from the code). Stored per session. */
  minDurationMs: number;
  /** Remote only (none from the code). */
  triggers: ReplayTrigger[];
}

/** The code's values with each field the project saved on top, those three fields only. */
export function effectiveConfig(
  options: SessionReplayOptions,
  remote: RemoteReplayConfig | null,
): EffectiveReplayConfig {
  return {
    sampleRate: remote?.sampleRate ?? rate(options.sampleRate),
    onErrorSampleRate: remote?.onErrorSampleRate ?? rate(options.onErrorSampleRate),
    minDurationMs: remote?.minDurationMs ?? 0,
    triggers: remote?.triggers ?? [],
  };
}

/** The sampling draw of a new session. */
export function decideMode(effective: EffectiveReplayConfig, random: () => number): ReplayMode {
  if (effective.sampleRate > 0 && random() < effective.sampleRate) return "session";
  if (effective.onErrorSampleRate > 0 && random() < effective.onErrorSampleRate) return "error";
  return "off";
}

export interface ReplayDeps {
  apiHost: string;
  token: string | undefined;
  /** localStorage: the quota pause (shared by every tab of the origin) and the remote settings copy. */
  localStorage: CohorlyStorage;
  /** sessionStorage: the tab's session record. */
  sessionStorage: CohorlyStorage;
  maxRetryDelayMs: number;
  getDistinctId: () => string;
  log: (...args: unknown[]) => void;
  /** Random source of the sampling decision, [0, 1). */
  random: () => number;
  /** Loads replay.ts (and with it the sender and rrweb). */
  loadReplay: () => Promise<ReplayModule>;
  /** The request for the remote settings (only with `remoteConfig`). */
  fetch: typeof fetch;
  /**
   * The client's flag listener (`client.onFeatureFlags`), for flag triggers;
   * absent with `loadFeatureFlags: false`, which never fires one.
   */
  onFeatureFlags?: (cb: (flags: Record<string, FlagResult>) => void) => () => void;
}

/** What replay.ts gets from this module. */
export interface RecordingContext
  extends Omit<ReplayDeps, "loadReplay" | "random" | "fetch" | "onFeatureFlags"> {
  store: ReplaySessionStore;
  /** The mode a session records in now (session mode buffers like error mode during a quota pause). */
  effectiveMode: (session: ReplaySession) => ReplayMode;
}

/** A running replay.ts instance. */
export interface Recording {
  onException(): void;
  /** The store rotated (reset(), or activity after expiry): restart for the new session. */
  onRotate(): void;
  /** The live session's mode was set after it began (a pending decision settled): restart if it differs. */
  onModeChange(): void;
  /**
   * A trigger promoted the live session to `session` mode (VEL-2187): an
   * error-mode buffer is queued at once, as on an error, and the recorder
   * restarts in session mode from a full snapshot on the next task (for that
   * session only). Nothing while the quota pause keeps it in error mode: the
   * switch, buffer first, comes when the pause ends.
   */
  promote(): void;
  /** reset() is about to rotate: queue what belongs to the outgoing session. */
  beforeReset(): void;
  optOut(): void;
  stop(): void;
}

export interface ReplayModule {
  startRecording(options: SessionReplayOptions, ctx: RecordingContext): Recording;
}

export interface ReplayController {
  /**
   * `$session_id` for an event being built now (activity unless SDK-internal).
   * `properties` are its final properties: event triggers are matched on them.
   */
  eventProperties(event: string, properties?: Record<string, unknown>): Record<string, unknown>;
  /** The SDK queued an `$exception`. */
  onException(): void;
  /** reset(): rotate the session. */
  reset(): void;
  /** optOutTracking(): stop, drop everything, never send again. */
  optOut(): void;
  /** A later init() replaces this controller. */
  stop(): void;
}

export function startSessionReplay(
  options: SessionReplayOptions,
  deps: ReplayDeps,
): ReplayController | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const remoteOn = options.remoteConfig === true && !!deps.token;
  const code = effectiveConfig(options, null);
  if (!remoteOn && code.sampleRate === 0 && code.onErrorSampleRate === 0) return null;

  let stopped = false;
  /** The settings new sessions are decided with; null while the remote ones are awaited. */
  let effective: EffectiveReplayConfig | null = remoteOn ? null : code;
  /** When `effective` was fetched (a stored copy) or resolved (an answer, or the fallback after one). */
  let resolvedAt = Number.NEGATIVE_INFINITY;
  /** Bumped by each load: an older load resolving late changes nothing. */
  let loads = 0;

  const loadRemote = () =>
    loadReplayConfig({
      apiHost: deps.apiHost,
      token: deps.token as string,
      storage: deps.localStorage,
      fetch: deps.fetch,
      now: Date.now,
    });
  /** Takes a load's settings: at once from a fresh copy, else new sessions wait (`pending`) for `ready`. */
  const adopt = (load: ReplayConfigLoad) => {
    const mine = ++loads;
    if (load.fresh) {
      effective = effectiveConfig(options, load.cached);
      resolvedAt = load.fetchedAt ?? Date.now();
      return;
    }
    effective = null;
    void load.ready.then((resolved) => {
      if (stopped || mine !== loads) return;
      effective = effectiveConfig(options, resolved);
      resolvedAt = Date.now();
      settle();
      onSettings();
    });
  };
  /** Before a new session is decided: reads the settings again when they are an hour old or a newer copy was stored. */
  const refreshIfStale = () => {
    if (!remoteOn || !effective) return;
    const now = Date.now();
    const copy = readReplayConfig(deps.localStorage, deps.token as string, now);
    if (now - resolvedAt >= REPLAY_CONFIG_TTL_MS || (copy !== null && copy.fetchedAt > resolvedAt)) {
      adopt(loadRemote());
    }
  };
  if (remoteOn) adopt(loadRemote());

  let recording: Recording | null = null;
  let loading = false;
  /** An exception captured while replay.ts was loading: handed over once it runs. */
  let exceptionWhileLoading = false;

  const quotaPausedUntil = (): number => {
    const raw = Number(deps.localStorage.get(QUOTA_PAUSE_KEY));
    return Number.isFinite(raw) ? raw : 0;
  };
  const effectiveMode = (session: ReplaySession): ReplayMode => {
    if (session.mode === "pending") return "off";
    return session.mode === "session" && Date.now() < quotaPausedUntil() ? "error" : session.mode;
  };
  /** Loads replay.ts the first time a session needs it. */
  const ensureRecording = () => {
    if (stopped || recording || loading) return;
    const session = store.active();
    if (!session || effectiveMode(session) === "off") return;
    loading = true;
    deps
      .loadReplay()
      .then((mod) => {
        loading = false;
        const missed = exceptionWhileLoading;
        exceptionWhileLoading = false;
        if (stopped || recording) return;
        const { loadReplay: _load, random: _random, fetch: _fetch, onFeatureFlags: _flags, ...rest } = deps;
        recording = mod.startRecording(options, { ...rest, store, effectiveMode });
        // Its recorder is starting: it sends for this error once it is up.
        if (missed) recording.onException();
      })
      .catch((err: unknown) => {
        loading = false;
        exceptionWhileLoading = false;
        deps.log("session replay could not load", err);
      });
  };

  const store = new ReplaySessionStore({
    storage: deps.sessionStorage,
    decideMode: () => {
      refreshIfStale();
      return effective ? decideMode(effective, deps.random) : "pending";
    },
    minDurationMs: () => effective?.minDurationMs ?? 0,
    onRotate: () => {
      if (recording) recording.onRotate();
      else ensureRecording();
      checkUrl();
    },
  });

  /** Decides the tab's session when it is still pending; the one place a pending mode is resolved. */
  const settle = () => {
    if (stopped || !effective) return;
    const session = store.last();
    if (session.mode !== "pending") return;
    store.setMode(session.id, decideMode(effective, deps.random), effective.minDurationMs);
    if (recording) recording.onModeChange();
    else ensureRecording();
  };

  /**
   * Draws a trigger that matched: once per session, hit or miss, and only in
   * a live session that is `off` or `error` (a pending one has no settings yet,
   * a recording one needs nothing).
   */
  const fire = (trigger: ReplayTrigger) => {
    if (stopped) return;
    const session = store.active();
    if (!session || (session.mode !== "off" && session.mode !== "error")) return;
    if (session.triggered.includes(trigger.id)) return;
    const hit = deps.random() < trigger.rate;
    store.markTriggered(session.id, trigger.id);
    if (!hit) return;
    deps.log("replay trigger fired", trigger.kind, trigger.id);
    store.promote(session.id);
    if (recording) recording.promote();
    else ensureRecording();
  };
  /** The triggers of the settings in use; none before they are adopted. */
  const triggers = (): ReplayTrigger[] => (remoteOn && effective ? effective.triggers : []);
  const checkEvent = (event: string, properties: Record<string, unknown>) => {
    for (const t of triggers()) if (t.kind === "event" && eventMatches(t, event, properties)) fire(t);
  };
  /** The path only: query and fragment never count. */
  const checkUrl = () => {
    if (stopped || typeof location === "undefined") return;
    const path = location.pathname;
    const matched = triggers().filter((t) => t.kind === "url" && matchesUrlPattern(t.pattern, path));
    if (matched.length === 0) return;
    if (!store.active()) {
      // Expired (before this load, or idle before a programmatic navigation):
      // the match opens the next session where a tracked event would, and
      // that rotation checks the URL again (onRotate) in the new session.
      store.touch();
      return;
    }
    for (const t of matched) fire(t);
  };
  /** The flags as last loaded (never read through getFeatureFlag(), which sends `$feature_flag_called`). */
  let flags: Record<string, FlagResult> | null = null;
  const checkFlags = () => {
    if (!flags) return;
    for (const t of triggers()) if (t.kind === "flag" && flagMatches(t, flags)) fire(t);
  };
  /** Settings adopted (load, or an answer that arrived): the page and the flags as they are now. */
  const onSettings = () => {
    checkUrl();
    checkFlags();
  };

  // A session left pending by a page that closed before deciding is decided here.
  settle();

  // The tab's session expired before this page load: recording starts at the
  // first interaction (or tracked event), which rotates it.
  const wakeEvents = ["pointerdown", "keydown", "scroll", "touchstart", "mousemove", "input"];
  let wakeArmed = false;
  const disarmWake = () => {
    if (!wakeArmed) return;
    wakeArmed = false;
    for (const type of wakeEvents) window.removeEventListener(type, onWake, { capture: true });
  };
  const onWake = () => {
    disarmWake();
    if (!stopped && !store.active()) store.touch();
  };
  if (store.active()) {
    ensureRecording();
  } else {
    wakeArmed = true;
    for (const type of wakeEvents) {
      window.addEventListener(type, onWake, { capture: true, passive: true });
    }
  }

  // Triggers exist only with the remote settings: without them, no navigation
  // observer and no flag listener.
  const unsubscribe: (() => void)[] = [];
  if (remoteOn) {
    unsubscribe.push(onNavigation(checkUrl));
    if (deps.onFeatureFlags) {
      unsubscribe.push(
        deps.onFeatureFlags((loaded) => {
          flags = loaded;
          checkFlags();
        }),
      );
    }
    onSettings();
  }
  const unsubscribeAll = () => {
    for (const off of unsubscribe.splice(0)) off();
  };

  return {
    eventProperties(event, properties) {
      if (stopped) return {};
      const session = INTERNAL_EVENTS.has(event) ? store.last() : store.touch();
      // After the session is known: a hit promotes it, the id stays the same.
      // Matched on the properties the event is queued with: the caller's
      // `$session_id` when it passed one, else the one returned here.
      if (properties && !NON_TRIGGER_EVENTS.has(event)) {
        checkEvent(
          event,
          properties.$session_id === undefined ? { ...properties, $session_id: session.id } : properties,
        );
      }
      return { $session_id: session.id };
    },
    onException() {
      if (stopped) return;
      if (recording) recording.onException();
      else if (loading) exceptionWhileLoading = true;
    },
    reset() {
      if (stopped) return;
      recording?.beforeReset();
      store.rotate();
    },
    optOut() {
      if (stopped) return;
      stopped = true;
      disarmWake();
      unsubscribeAll();
      recording?.optOut();
      recording = null;
      store.dispose();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      disarmWake();
      unsubscribeAll();
      recording?.stop();
      recording = null;
      store.dispose();
    },
  };
}
