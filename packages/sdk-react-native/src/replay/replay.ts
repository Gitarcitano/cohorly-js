/**
 * Session replay in React Native (VEL-2153, docs/SESSION-REPLAY.md
 * "Mobile"). The native module captures; this controller owns the session
 * (`$session_id`, the sampling draw, rotation), pulls what native code
 * captured, and either uploads it (`session` draw) or keeps it in the error
 * buffer until the SDK captures an exception (`error` draw). A `none` draw
 * stamps `$session_id` and never starts the recorder.
 *
 * - Every native call runs on one promise chain, so a drain, a checkout and
 *   a start never interleave. A call that rejects turns recording off for
 *   this process; events and `$session_id` keep flowing.
 * - Drains: every 5 s while recording, when the app leaves the foreground,
 *   and on an exception.
 * - A rotation drains what the outgoing recording captured into its own
 *   session, under the distinct id it had when it rotated (reset() rotates
 *   before it replaces the identity), sends an error send it still owed,
 *   then the recorder continues from a full snapshot for the new session (or
 *   stops on a `none` draw). A new recording drops what it drains until a
 *   Meta + FullSnapshot.
 * - A snapshot too large to send (session upload or error send) drops it and
 *   every IncrementalSnapshot after it until a snapshot that fits.
 * - The replay quota pause (persisted) records a `session` draw like an
 *   `error` one until it ends, whatever `onErrorSampleRate` is; when it ends
 *   the buffer is sent first (mode `error`, no error marker), then session
 *   recording goes on from a new snapshot, like the web SDK.
 * - Error sends: at most one every 5 s per session; the window and the
 *   closing Custom `error` event take the exception's time.
 * - `optOut()` and `stop()` end it: the recorder stops, the outbox and the
 *   error buffer are dropped, and nothing is stamped or sent again. Opting
 *   back in does not restart it (the web SDK's rule); the next `init()` does.
 */
import type { AsyncStorageLike } from "../types.js";
import type { ChunkMode, Unit } from "./chunks.js";
import {
  admitUnits,
  batchUnits,
  CUSTOM,
  eventType,
  eventUnits,
  FULL_SNAPSHOT,
  headerBytes,
  MAX_CHUNK_BYTES,
  META,
  packUnits,
} from "./chunks.js";
import { CHECKOUT_EVERY_MS, ERROR_SEND_GAP_MS, ErrorBuffer } from "./error-buffer.js";
import type { NativeReplay } from "./native.js";
import { resolveNativeReplay, warnReplayUnavailable } from "./native.js";
import type { ReplayDraw, ReplaySettings, SessionReplayOptions } from "./options.js";
import { drawSession, replaySettings } from "./options.js";
import { ReplaySender } from "./sender.js";
import type { ReplaySessionState } from "./session.js";
import { ReplaySessionStore, replayStorageKey } from "./session.js";

export const DRAIN_INTERVAL_MS = 5000;
/**
 * SDK-internal events: stamped with the current session, never count as
 * activity, so they never rotate it (neither the 30 min nor the 24 h rule),
 * the web SDK's rule plus the mobile `$ae_session`.
 */
const INTERNAL_EVENTS = new Set(["$metric", "$feature_flag_called", "$exception", "$ae_session"]);
/** Distinct ids remembered for sessions rotated out (their late chunks). */
const RETIRED_IDENTITIES = 16;

/**
 * The native recorder is one per process, shared by every controller (a
 * repeated `init()` replaces the client while the old one may still be
 * starting). Each start takes the next number; a controller only stops the
 * recording when its own start is still the latest, so a late continuation
 * of a replaced client never stops its replacement's recording.
 */
let nativeStarts = 0;

export interface ReplayHost {
  apiHost: string;
  token: string | undefined;
  storage: AsyncStorageLike;
  /** The client's fetch, read on every send. */
  fetch: () => typeof fetch | undefined;
  maxRetryDelayMs: number;
  distinctId: () => string;
  /** After every rotation, so the native crash config carries the new `$session_id`. */
  onRotate: () => void;
  random?: () => number;
}

/** What the native recorder captures for now. */
interface Recording {
  sessionId: string;
  mode: ChunkMode;
  /** Started or switched: what it drains is dropped until a Meta + FullSnapshot. */
  awaitSnapshot: boolean;
  /** A snapshot too large was dropped: IncrementalSnapshots wait for one that fits. */
  suppress: boolean;
}

function unref(timer: unknown): void {
  (timer as { unref?: () => void } | null)?.unref?.();
}

export class ReplayController {
  readonly store: ReplaySessionStore;
  private readonly sender: ReplaySender;
  private readonly buffer = new ErrorBuffer(() => Date.now());
  private started = false;
  /** optOut() or stop(): nothing is stamped, recorded or sent any more. */
  private closed = false;
  /** 404 on /replay, a native refusal or failure: no recording in this process. */
  private recordingOff = false;
  private nativeOn = false;
  /** `nativeStarts` of this controller's start (0: none). */
  private startTicket = 0;
  private recording: Recording | null = null;
  private chain: Promise<void> = Promise.resolve();
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private checkoutTimer: ReturnType<typeof setInterval> | null = null;
  /** An error send waiting out the 5 s gap of its session; `at` is its latest exception. */
  private errorSend: { sessionId: string; at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** When the last error send of a session was queued (the gap is per session). */
  private lastErrorSend: { sessionId: string; at: number } | null = null;
  /** An exception of a session whose buffer has no snapshot yet: sent with its first one. */
  private pendingError: { sessionId: string; at: number } | null = null;
  /** The distinct id of each session rotated out, as it was when it rotated. */
  private readonly retiredIdentity = new Map<string, string>();
  private foreground: boolean;
  private batches = 0;

  constructor(
    private readonly settings: ReplaySettings,
    private readonly native: NativeReplay,
    private readonly host: ReplayHost,
    appState?: string,
  ) {
    const random = host.random ?? Math.random;
    this.foreground = appState === undefined || appState === "active";
    this.store = new ReplaySessionStore({
      storage: host.storage,
      key: replayStorageKey(host.token),
      draw: (): ReplayDraw => drawSession(settings, random),
      now: () => Date.now(),
      onRotate: (_session, previous) => {
        // Before anything else: chunks of the outgoing session built later keep its identity.
        this.retiredIdentity.set(previous.id, host.distinctId());
        while (this.retiredIdentity.size > RETIRED_IDENTITIES) {
          this.retiredIdentity.delete(this.retiredIdentity.keys().next().value as string);
        }
        host.onRotate();
        if (this.active()) void this.run(() => this.apply());
      },
    });
    // Launched in the background: the session's idle clock runs from now.
    if (appState === "background") this.store.background();
    this.sender = new ReplaySender({
      apiHost: host.apiHost,
      token: host.token,
      fetch: host.fetch,
      maxRetryDelayMs: host.maxRetryDelayMs,
      random,
      nextSeq: (sessionId) => this.store.takeSeq(sessionId),
      beforeSend: () => this.store.persisted(),
      onQuotaExceeded: (retryAfterMs) => {
        this.store.pauseQuota(Date.now() + retryAfterMs);
        if (this.active()) void this.run(() => this.apply());
      },
      onGone: () => this.turnOff(),
      onDropped: (chunk) => {
        // Later session-mode chunks would replay against a screen the player never saw.
        if (chunk.mode === "session" && this.recording?.mode === "session" && this.nativeOn) {
          void this.run(() => this.native.checkout());
        }
      },
    });
  }

  /** Reads the persisted session; see ReplaySessionStore.load(). */
  load(): Promise<{ from: string; to: string } | null> {
    return this.store.load();
  }

  /** Starts recording per the session's draw (after the client knows it is not opted out). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    if (this.recordingOff) return;
    this.drainTimer = setInterval(() => void this.run(() => this.tick()), DRAIN_INTERVAL_MS);
    unref(this.drainTimer);
    this.checkoutTimer = setInterval(() => void this.run(() => this.checkoutIfDirty()), CHECKOUT_EVERY_MS);
    unref(this.checkoutTimer);
    void this.run(() => this.apply());
  }

  /** `$session_id` for an event built now; a tracked event in the foreground is activity. */
  eventProperties(event: string): Record<string, unknown> {
    if (this.closed) return {};
    const session = INTERNAL_EVENTS.has(event) ? this.store.last() : this.store.activity(this.foreground);
    return { $session_id: session.id };
  }

  /** The session stamped on an exception captured now. */
  sessionId(): string | undefined {
    return this.closed ? undefined : this.store.last().id;
  }

  /**
   * The SDK recorded an exception (accepted by `beforeSendException`) whose
   * final properties carry `sessionId`, captured at `at` (ms). Drains,
   * then: an `error` recording of that session sends its buffer (at most one
   * send every 5 s per session; `fatal` sends at once and past the backoff,
   * without waiting for anything); a `session` recording only sends what it
   * drained.
   */
  onException(sessionId: string | undefined, fatal = false, at: number = Date.now()): void {
    if (!this.active() || sessionId === undefined) return;
    void this.run(async () => {
      const rec = this.recording;
      if (!rec) return;
      await this.drainInto(rec);
      if (!this.active() || this.recording !== rec) return;
      if (rec.mode === "error") {
        if (fatal && sessionId === rec.sessionId) {
          const owed = this.takeErrorSend(rec.sessionId);
          await this.sendErrorBuffer(rec, Math.max(at, owed ?? at), true);
        } else {
          await this.handleError(sessionId, at);
        }
      }
      if (fatal) this.sender.flushNow();
    });
  }

  onAppState(state: string): void {
    if (this.closed) return;
    if (state === "active") {
      const was = this.foreground;
      this.foreground = true;
      // May rotate (more than 30 min in background, or 24 h of session).
      if (!was) this.store.foreground();
      return;
    }
    if (state !== "background" && state !== "inactive") return;
    this.foreground = false;
    if (state === "background") this.store.background();
    if (!this.active()) return;
    void this.run(async () => {
      if (this.recording) await this.drainInto(this.recording);
      this.sender.pump();
    });
  }

  /** reset(): a new session at once (call it while the outgoing identity is still current). */
  reset(): void {
    if (!this.closed) this.store.rotate();
  }

  /** optOutTracking(): stops the recorder, drops what is queued or buffered, sends nothing again. */
  optOut(): void {
    this.close();
  }

  /** The client is replaced (a later init()) or stopped. */
  stop(): void {
    this.close();
  }

  private active(): boolean {
    return this.started && !this.closed && !this.recordingOff;
  }

  /** Runs `op` after every earlier one; a native rejection turns recording off. */
  private run(op: () => Promise<void>): Promise<void> {
    const next = this.chain
      .then(async () => {
        if (this.active()) await op();
      })
      .catch(() => this.turnOff());
    this.chain = next;
    return next;
  }

  private effectiveMode(session: ReplaySessionState): ChunkMode | null {
    if (session.draw === "none") return null;
    if (session.draw === "session" && Date.now() < this.store.quotaPausedUntil()) return "error";
    return session.draw;
  }

  /** The distinct id chunks of `sessionId` carry: the one it rotated out with, else the current one. */
  private identityOf(sessionId: string): string {
    return this.retiredIdentity.get(sessionId) ?? this.host.distinctId();
  }

  /** Cancels the scheduled error send of `sessionId`; returns its exception time. */
  private takeErrorSend(sessionId: string): number | undefined {
    const pending = this.errorSend;
    if (!pending || pending.sessionId !== sessionId) return undefined;
    clearTimeout(pending.timer);
    this.errorSend = null;
    return pending.at;
  }

  /** Brings the native recorder in line with the current session and its mode. */
  private async apply(): Promise<void> {
    const session = this.store.last();
    const mode = this.effectiveMode(session);
    const rec = this.recording;
    if (rec && (rec.sessionId !== session.id || rec.mode !== mode)) {
      // What was captured so far belongs to the recording that ends here.
      await this.drainInto(rec);
      if (!this.active()) return;
      if (rec.mode === "error") {
        // An error send it owes goes now, under its own session; so does the
        // buffer when the same session moves on to session mode (the end of
        // a quota pause), as on the web.
        const owed = this.takeErrorSend(rec.sessionId);
        if (owed !== undefined || (rec.sessionId === session.id && mode === "session")) {
          await this.sendErrorBuffer(rec, owed, false, false);
          if (!this.active()) return;
        }
      }
      this.buffer.clear();
      if (this.pendingError?.sessionId !== session.id) this.pendingError = null;
    }
    if (mode === null) {
      this.recording = null;
      if (this.nativeOn) {
        this.nativeOn = false;
        if (this.startTicket === nativeStarts) await this.native.stop();
      }
      return;
    }
    if (!this.nativeOn) {
      this.startTicket = ++nativeStarts;
      const ok = await this.native.start(
        JSON.stringify({ mode: this.settings.mode, maskAllImages: this.settings.maskAllImages }),
      );
      if (!this.active()) {
        // Opted out (or stopped) while it was starting.
        if (ok) this.stopNative();
        return;
      }
      if (!ok) {
        this.turnOff();
        return;
      }
      this.nativeOn = true;
      this.recording = { sessionId: session.id, mode, awaitSnapshot: true, suppress: false };
      this.buffer.clear();
      return;
    }
    if (rec?.sessionId !== session.id || rec?.mode !== mode) {
      // The new recording starts from a full snapshot; anything drained before it is the old screen.
      this.recording = { sessionId: session.id, mode, awaitSnapshot: true, suppress: false };
      await this.native.checkout();
    }
  }

  private async tick(): Promise<void> {
    await this.apply();
    if (this.active() && this.recording) await this.drainInto(this.recording);
  }

  private async checkoutIfDirty(): Promise<void> {
    const rec = this.recording;
    if (rec?.mode !== "error") return;
    await this.drainInto(rec);
    if (this.active() && this.recording === rec && this.buffer.dirtySinceCheckout) {
      this.buffer.dirtySinceCheckout = false;
      await this.native.checkout();
    }
  }

  /** Pulls what native code captured and hands it to `rec`'s session and mode. */
  private async drainInto(rec: Recording): Promise<void> {
    const drained = await this.native.drain();
    if (!this.active() || drained.length === 0) return;
    if (this.foreground) this.store.noteActivity();
    const batches = this.fromSnapshot(rec, drained);
    if (batches.length === 0) return;
    if (rec.mode === "session") {
      // Paused by the quota: what it captured meanwhile would be refused too.
      if (Date.now() < this.store.quotaPausedUntil()) return;
      await this.enqueueSession(rec, batches);
    } else {
      await this.bufferBatches(rec, batches);
    }
  }

  /** A recording waiting for its first snapshot drops every event before a Meta + FullSnapshot. */
  private fromSnapshot(rec: Recording, batches: string[]): string[] {
    if (!rec.awaitSnapshot) return batches;
    for (let b = 0; b < batches.length; b += 1) {
      let events: unknown;
      try {
        events = JSON.parse(batches[b]);
      } catch {
        continue;
      }
      if (!Array.isArray(events)) continue;
      const at = events.findIndex((e, i) => eventType(e) === META && eventType(events[i + 1]) === FULL_SNAPSHOT);
      if (at < 0) continue;
      rec.awaitSnapshot = false;
      const first = at === 0 ? batches[b] : JSON.stringify(events.slice(at));
      return [first, ...batches.slice(b + 1)];
    }
    return [];
  }

  private async enqueueSession(rec: Recording, batches: string[]): Promise<void> {
    const { sessionId } = rec;
    const distinctId = this.identityOf(sessionId);
    const budget = MAX_CHUNK_BYTES - headerBytes(sessionId, distinctId, "session");
    const units: Unit[] = [];
    for (const batch of batches) {
      const parsed = batchUnits(batch, budget);
      if (parsed) units.push(...parsed.units);
    }
    const admitted = admitUnits(units, budget, rec.suppress);
    rec.suppress = admitted.suppress;
    const { parts } = packUnits(admitted.kept, budget);
    this.sender.enqueue(
      parts.map((eventsJson) => this.sender.chunk({ sessionId, distinctId, mode: "session", eventsJson })),
    );
    // A snapshot too large to ever send: the next one makes the rest playable again.
    if (admitted.droppedSnapshot && this.recording === rec) await this.native.checkout();
  }

  private async bufferBatches(rec: Recording, batches: string[]): Promise<void> {
    let needCheckout = false;
    for (const batch of batches) {
      let events: unknown;
      try {
        events = JSON.parse(batch);
      } catch {
        continue;
      }
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        if (typeof event !== "object" || event === null) continue;
        if (this.buffer.push(event as { type?: unknown; timestamp?: unknown }, JSON.stringify(event))) {
          needCheckout = true;
        }
      }
    }
    if (needCheckout) await this.native.checkout();
    const pending = this.pendingError;
    if (pending?.sessionId === rec.sessionId && this.buffer.hasSnapshot()) {
      this.pendingError = null;
      await this.handleError(rec.sessionId, pending.at);
    }
  }

  private async handleError(sessionId: string, at: number): Promise<void> {
    const rec = this.recording;
    if (rec?.mode !== "error") return;
    if (sessionId !== rec.sessionId) {
      // The live session, whose recording has not switched yet: sent with its first snapshot.
      const live = this.store.last();
      if (live.id === sessionId && this.effectiveMode(live) === "error") this.pendingError = { sessionId, at };
      return;
    }
    if (this.errorSend?.sessionId === sessionId) {
      // A send is scheduled and will include this error.
      this.errorSend.at = Math.max(this.errorSend.at, at);
      return;
    }
    const last = this.lastErrorSend?.sessionId === sessionId ? this.lastErrorSend.at : Number.NEGATIVE_INFINITY;
    const wait = last + ERROR_SEND_GAP_MS - Date.now();
    if (wait > 0) {
      const timer = setTimeout(() => void this.run(() => this.sendScheduledError(sessionId)), wait);
      this.errorSend = { sessionId, at, timer };
      return;
    }
    await this.sendErrorBuffer(rec, at, false);
  }

  private async sendScheduledError(sessionId: string): Promise<void> {
    const at = this.takeErrorSend(sessionId);
    const rec = this.recording;
    // Rotated meanwhile: apply() already sent it under its session.
    if (at === undefined || !rec || rec.mode !== "error" || rec.sessionId !== sessionId) return;
    await this.drainInto(rec);
    if (this.active() && this.recording === rec) await this.sendErrorBuffer(rec, at, false);
  }

  /**
   * Queues `rec`'s buffered window as `mode: "error"` chunks. With `errorAt`
   * (an exception's time) the window is cut there and closed by a Custom
   * `error` event at that time; without it (leaving a quota pause) it is cut
   * now, with no marker. Nothing goes without a FullSnapshot that fits.
   * `keepBuffering`: a checkout follows, for the next error.
   */
  private async sendErrorBuffer(
    rec: Recording,
    errorAt: number | undefined,
    fatal: boolean,
    keepBuffering = true,
  ): Promise<void> {
    if (rec.mode !== "error") return;
    const cut = this.buffer.cut(errorAt ?? Date.now());
    if (cut.kind === "nothing") return;
    if (cut.kind === "need-snapshot") {
      if (errorAt !== undefined && keepBuffering) {
        this.pendingError = { sessionId: rec.sessionId, at: errorAt };
        await this.native.checkout();
      }
      return;
    }
    const { sessionId } = rec;
    const distinctId = this.identityOf(sessionId);
    const budget = MAX_CHUNK_BYTES - headerBytes(sessionId, distinctId, "error");
    const { kept } = admitUnits(
      eventUnits(
        cut.events.map((e) => e.json),
        cut.events.map((e) => e.type),
      ),
      budget,
      false,
    );
    if (!kept.some((u) => u.hasSnapshot)) {
      // Every snapshot was too large: a marker alone would replay nothing.
      if (keepBuffering) await this.native.checkout();
      return;
    }
    this.lastErrorSend = { sessionId, at: Date.now() };
    const marker =
      errorAt === undefined
        ? []
        : eventUnits([JSON.stringify({ type: CUSTOM, timestamp: errorAt, data: { tag: "error", payload: {} } })], [CUSTOM]);
    const { parts } = packUnits([...kept, ...marker], budget);
    this.batches += 1;
    const batch = this.batches;
    this.sender.enqueue(
      parts.map((eventsJson) => this.sender.chunk({ sessionId, distinctId, mode: "error", eventsJson, batch })),
    );
    if (fatal) this.sender.flushNow();
    // Keep buffering for the next error, from a new snapshot.
    if (keepBuffering) await this.native.checkout();
  }

  private clearTimers(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.checkoutTimer) clearInterval(this.checkoutTimer);
    if (this.errorSend) clearTimeout(this.errorSend.timer);
    this.drainTimer = null;
    this.checkoutTimer = null;
    this.errorSend = null;
  }

  /** No recording in this process; queued chunks still go (unless the sender itself stopped). */
  private turnOff(): void {
    if (this.recordingOff) return;
    this.recordingOff = true;
    this.clearTimers();
    this.recording = null;
    this.pendingError = null;
    this.buffer.clear();
    if (this.nativeOn) {
      this.nativeOn = false;
      this.stopNative();
    }
  }

  /** Stops the native recording unless a later controller has started its own since. */
  private stopNative(): void {
    if (this.startTicket === nativeStarts) void this.native.stop().catch(() => {});
  }

  private close(): void {
    if (this.closed) return;
    const wasOn = this.nativeOn;
    this.closed = true;
    this.clearTimers();
    this.recording = null;
    this.pendingError = null;
    this.nativeOn = false;
    this.buffer.clear();
    this.sender.shutdown();
    if (wasOn) this.stopNative();
  }
}

/**
 * The controller for these options, or null when replay is off: no option,
 * both rates 0, or the native module missing (one development warning).
 * `NativeModules.CohorlyReactNativeReplay` is read only when replay is on.
 */
export function createReplay(
  options: SessionReplayOptions | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: untyped `react-native` module.
  rn: any,
  host: ReplayHost,
  appState?: string,
): ReplayController | null {
  const settings = replaySettings(options);
  if (!settings) return null;
  const native = resolveNativeReplay(rn);
  if (!native) {
    warnReplayUnavailable();
    return null;
  }
  return new ReplayController(settings, native, host, appState);
}
