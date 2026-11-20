/**
 * The React Native client keeps its own event pipeline; exceptions go through
 * an embedded @cohorly/core client used only as the exception engine: the
 * persisted `cohorly_exception_queue` (fatal first, never evicted by events),
 * breadcrumbs, `beforeSendException` and the retry contract. Identity stays
 * with the React Native client and is stamped on each exception when it is
 * captured.
 */
import type {
  BreadcrumbInput,
  CaptureExceptionOptions,
  CohorlyStorage,
  CohorlyTransport,
  ExceptionListEntry,
  TrackedEvent,
} from "@cohorly/core";
import { CohorlyClient as CoreClient } from "@cohorly/core";
import type { AsyncStorageLike, Properties } from "../types.js";

export const EXCEPTION_QUEUE_KEY = "cohorly_exception_queue";
/** Captures (and breadcrumbs) held in memory until the engine exists. */
export const MAX_PENDING_CAPTURES = 50;
const MAX_PENDING_BREADCRUMBS = 50;
const BACKOFF_BASE_MS = 2000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const BACKOFF_JITTER = 0.2;
/** A stalled exception request must not hold the analytics flush forever. */
export const EXCEPTION_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Synchronous storage for the core client: a memory cache, hydrated from
 * AsyncStorage before the core client is built. Only the exception queue is
 * written through to AsyncStorage (in order, one write at a time); the core
 * client's other keys (its own identity, event queue) stay in memory, since
 * the React Native client owns those.
 */
export class ExceptionStorage implements CohorlyStorage {
  private readonly cache = new Map<string, string>();
  private readonly written = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private frozen = false;

  constructor(private readonly backing: AsyncStorageLike) {}

  async hydrate(): Promise<void> {
    await takeRetiredWrites();
    let stored: string | null = null;
    try {
      stored = await this.backing.getItem(EXCEPTION_QUEUE_KEY);
    } catch {
      return;
    }
    // A write that landed while the read was in flight is newer.
    if (stored !== null && !this.written.has(EXCEPTION_QUEUE_KEY)) {
      this.cache.set(EXCEPTION_QUEUE_KEY, stored);
    }
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    this.written.add(key);
    if (key === EXCEPTION_QUEUE_KEY) this.enqueue(() => this.backing.setItem(key, value));
  }

  remove(key: string): void {
    this.cache.delete(key);
    this.written.add(key);
    if (key === EXCEPTION_QUEUE_KEY) this.enqueue(() => this.backing.removeItem(key));
  }

  /** Resolves once every write issued so far reached AsyncStorage (or failed). */
  persisted(): Promise<void> {
    return this.writes;
  }

  /** True when the exception queue holds anything. */
  hasQueuedExceptions(): boolean {
    const raw = this.cache.get(EXCEPTION_QUEUE_KEY);
    return raw !== undefined && raw !== "[]" && raw !== "";
  }

  /** Stops writing: a retired engine must not overwrite its successor's queue. */
  freeze(): void {
    this.frozen = true;
  }

  private enqueue(write: () => Promise<void>): void {
    if (this.frozen) return;
    this.writes = this.writes.then(write).catch(() => {
      // Best effort, like the core: the exception is still sent from memory.
    });
  }
}

/**
 * Writes of engines retired by a repeated `init()`. The successor hydrates
 * only after they landed, so an old write can never land after the
 * successor's own and bring the stale queue back.
 */
let retiredWrites: Promise<void> = Promise.resolve();
/** A write that never settles must not keep the successor from starting. */
const HANDOFF_TIMEOUT_MS = 2000;

async function takeRetiredWrites(): Promise<void> {
  const writes = retiredWrites;
  retiredWrites = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, HANDOFF_TIMEOUT_MS);
  });
  await Promise.race([writes, timeout]);
  if (timer !== undefined) clearTimeout(timer);
}

export interface Identity {
  distinctId: string;
  deviceId: string;
  /** Set only once identified, like `$user_id` on track(). */
  userId?: string;
}

/** What the engine needs from the React Native client. */
export interface ExceptionHost {
  apiHost: string;
  token: string | undefined;
  lib: string;
  storage: AsyncStorageLike;
  /** The client's own POST (same fetch, same error type). */
  send(path: string, body: unknown): Promise<void>;
  /** Converts the client's transport error for the core retry contract. */
  toCoreError(err: unknown): unknown;
  isDisabled(): boolean;
  identity(): Identity;
  /**
   * Called at capture time; the result gives the identity the capture belongs
   * to once the engine replays it. Before hydration the client cannot know it
   * yet (see CohorlyClient.identityAtCapture).
   */
  identityAtCapture(): () => Identity;
  /**
   * Device defaults and super properties, as track() merges them, with
   * `sessionId` as the session replay `$session_id` when it is given.
   */
  eventProperties(sessionId?: string): Properties;
  /**
   * Called at capture time, like identityAtCapture(): the result gives the
   * replay `$session_id` of that moment once the engine replays the capture,
   * so a reset() in between does not move it to the new session.
   */
  sessionAtCapture?(): () => string | undefined;
  /** An exception was recorded: `beforeSendException` kept it, and this is its final form. */
  onCaptured?(event: TrackedEvent): void;
}

export interface ExceptionEngineConfig {
  release?: string;
  dist?: string;
  appVersion?: string;
  beforeSendException?: (event: TrackedEvent) => TrackedEvent | null;
  maxExceptionQueueSize?: number;
  /** `false`: the core drops a queue restored from storage and sends no exception. */
  captureExceptions?: boolean;
  /** Stamped on every exception (`expo_*`). */
  properties: Properties;
}

type PendingOp =
  | {
      kind: "capture";
      list: ExceptionListEntry[];
      options: CaptureExceptionOptions;
      time: number;
      identity: () => Identity;
      session: (() => string | undefined) | undefined;
    }
  | { kind: "breadcrumb"; crumb: BreadcrumbInput };

interface CaptureContext {
  identity: Identity;
  time?: number;
  /** The replay `$session_id` of the capture's moment. */
  sessionId?: string;
}

export class ExceptionEngine {
  readonly storage: ExceptionStorage;
  private readonly hydration: Promise<void>;
  private core: CoreClient | undefined;
  private config: ExceptionEngineConfig | undefined;
  private pending: PendingOp[] = [];
  private context: CaptureContext | undefined;
  private resolveStarted!: () => void;
  /** Resolves once the core client exists and the pending captures were replayed. */
  readonly started: Promise<void>;

  constructor(private readonly host: ExceptionHost) {
    this.storage = new ExceptionStorage(host.storage);
    this.hydration = this.storage.hydrate();
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  private retired = false;
  private optedOut = false;
  /** An opt-out happened before the core existed: the persisted queue it will read is stale. */
  private discardBeforeStart = false;

  /**
   * Opt-out of the app (see CohorlyClient.optOutTracking): drops what is held
   * in memory and in the persisted queue, and blocks new captures. Before the
   * core exists the flag is applied when it is built.
   */
  setOptedOut(value: boolean): void {
    this.optedOut = value;
    if (!value) {
      this.core?.optInTracking();
      return;
    }
    // Captures and breadcrumbs held until the core exists are discarded too.
    this.pending = [];
    if (!this.core) this.discardBeforeStart = true;
    this.core?.optOutTracking();
  }

  /**
   * Ends this engine: it stops capturing, sending and writing the shared
   * `cohorly_exception_queue`, so a client created after it (a repeated
   * `init()`) owns the queue alone. A send already on the wire may still land;
   * the server dedups a retry by `$insert_id`.
   */
  retire(): void {
    this.retired = true;
    this.storage.freeze();
    this.pending = [];
    retiredWrites = Promise.all([retiredWrites, this.storage.persisted()]).then(() => {});
  }

  get isStarted(): boolean {
    return this.core !== undefined;
  }

  /** Sends in progress, so a manual flush can wait for them (see flush()). */
  private readonly inFlight = new Set<Promise<void>>();
  private consecutiveFailures = 0;
  private lastSendFailed = false;
  private retryNotBefore = 0;

  readonly transport: CohorlyTransport = (url, body) => {
    const sent = this.sendOnce(url, body);
    const done = () => {
      this.inFlight.delete(sent);
    };
    this.inFlight.add(sent);
    sent.then(done, done);
    return sent;
  };

  /** The core retry contract, for the timer and app-state flushes the core
   * backoff cannot gate: 400 and 413 retry at once (dropped, or a smaller
   * batch), 401 waits the maximum, the rest back off exponentially with
   * jitter, 429 honoring Retry-After. */
  private scheduleRetry(status: number | undefined, retryAfterMs: number | undefined): void {
    if (status === 400 || status === 413) return;
    this.consecutiveFailures += 1;
    let delay =
      status === 401
        ? MAX_BACKOFF_MS
        : Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), MAX_BACKOFF_MS);
    if (retryAfterMs !== undefined) delay = Math.min(retryAfterMs, MAX_BACKOFF_MS);
    const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER;
    this.retryNotBefore = Date.now() + Math.min(delay * jitter, MAX_BACKOFF_MS);
  }

  private async sendOnce(url: string, body: unknown): Promise<void> {
    if (this.host.isDisabled()) throw new Error("Cohorly: disabled, exception kept");
    const path = url.startsWith(this.host.apiHost) ? url.slice(this.host.apiHost.length) : url;
    try {
      await this.host.send(path, body);
      this.consecutiveFailures = 0;
      this.retryNotBefore = 0;
    } catch (err) {
      this.lastSendFailed = true;
      const coreError = this.host.toCoreError(err) as { status?: number; retryAfterMs?: number };
      this.scheduleRetry(coreError.status, coreError.retryAfterMs);
      throw coreError;
    }
  }

  /**
   * Builds the core client once AsyncStorage was read, replays what was
   * captured before, then sends what is persisted (a fatal from the previous
   * launch goes out here, with the release it crashed in).
   */
  async start(config: ExceptionEngineConfig): Promise<void> {
    if (this.config) return this.started;
    this.config = config;
    await this.hydration;
    const appHook = config.beforeSendException;
    this.core = new CoreClient({
      apiHost: this.host.apiHost,
      token: this.host.token,
      lib: this.host.lib,
      storage: this.storage,
      transport: this.transport,
      flushIntervalMs: 0,
      fetcher: async () => undefined,
      sendExposureEvents: false,
      flagPersistence: "networkOnly",
      release: config.release,
      dist: config.dist,
      appVersion: config.appVersion,
      maxExceptionQueueSize: config.maxExceptionQueueSize,
      captureExceptions: config.captureExceptions,
      beforeSendException: (event) => {
        this.stampIdentity(event);
        // A throw or a non-object return drops the exception (core semantics).
        return appHook ? appHook(event) : event;
      },
    });
    // Opted out (even if back in since) before the core existed: its
    // constructor read a queue that opt-out discarded. Drop it before the
    // captures made since are replayed.
    if (this.discardBeforeStart) {
      this.core.optOutTracking();
      if (!this.optedOut) this.core.optInTracking();
    }
    const pending = this.pending;
    this.pending = [];
    for (const op of pending) {
      if (op.kind === "breadcrumb") this.core.addBreadcrumb(op.crumb);
      // Stamped with the identity of the moment it was captured, which may
      // only be known now that the stored identity was read.
      else this.captureNow(op.list, op.options, { identity: op.identity(), time: op.time, sessionId: op.session?.() });
    }
    // Opted out before the core existed: its constructor read the queue a
    // previous launch persisted, which must be discarded, not sent.
    if (this.optedOut) this.core.optOutTracking();
    this.resolveStarted();
    if (!this.host.isDisabled() && this.storage.hasQueuedExceptions()) void this.flush(false);
  }

  capture(list: ExceptionListEntry[], options: CaptureExceptionOptions): void {
    if (this.retired || this.optedOut) return;
    if (this.core) {
      this.captureNow(list, options, { identity: this.host.identity(), sessionId: this.host.sessionAtCapture?.()() });
      return;
    }
    this.pending.push({
      kind: "capture",
      list,
      options,
      time: Date.now(),
      identity: this.host.identityAtCapture(),
      session: this.host.sessionAtCapture?.(),
    });
    this.trimPending("capture", MAX_PENDING_CAPTURES);
  }

  addBreadcrumb(crumb: BreadcrumbInput): void {
    if (this.retired || this.optedOut) return;
    if (this.core) {
      this.core.addBreadcrumb(crumb);
      return;
    }
    if (!crumb || typeof crumb.category !== "string") return;
    this.pending.push({
      kind: "breadcrumb",
      crumb: { ...crumb, timestamp: crumb.timestamp ?? new Date().toISOString() },
    });
    this.trimPending("breadcrumb", MAX_PENDING_BREADCRUMBS);
  }

  /** Drops breadcrumbs; queued exceptions stay (they belong to who hit them). */
  clearBreadcrumbs(): void {
    // The core reset() also only re-mints its in-memory identity, which is
    // never sent: every exception gets the React Native identity stamped.
    this.core?.reset();
    this.pending = this.pending.filter((op) => op.kind !== "breadcrumb");
  }

  /**
   * Sends the queued exceptions now, fatal first, ignoring backoff. The core
   * client's event queue is always empty here, so its flush() sends only
   * exceptions, and it skips the ones already in flight (flushExceptions()
   * would send those twice); when a send is already running it returns at
   * once, that send being earlier than anything queued after it.
   */
  async flush(force = true): Promise<boolean> {
    const core = this.core;
    if (!core || this.retired || this.host.isDisabled()) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), EXCEPTION_FLUSH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.deliver(core, force), stalled]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** False when queued exceptions could not be delivered (or are waiting out a retry delay). */
  private async deliver(core: CoreClient, force: boolean): Promise<boolean> {
    // The core flush() returns at once while another send runs, which would
    // make `captureException(e); await flush()` send nothing. Wait for the
    // sends in progress (the core has already settled their batch by then),
    // then send what is left, ignoring the core's own in-flight guard.
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    // Timer and app-state flushes follow the retry delay; a manual one is
    // an explicit "try now".
    if (!force && Date.now() < this.retryNotBefore) return false;
    this.lastSendFailed = false;
    await core.flushExceptions(this.transport).catch(() => {});
    return !this.lastSendFailed;
  }

  /** Best-effort immediate send of fatal exceptions, not awaited by the caller. */
  flushFatal(): void {
    if (!this.core || this.retired || this.host.isDisabled()) return;
    void this.core.flushExceptions(this.transport, { fatalOnly: true }).catch(() => {});
  }

  private captureNow(
    list: ExceptionListEntry[],
    options: CaptureExceptionOptions,
    context: CaptureContext,
  ): void {
    const core = this.core;
    if (!core) return;
    this.context = context;
    let recorded: TrackedEvent | null = null;
    try {
      recorded = core.captureExceptionList(list, {
        ...options,
        properties: {
          ...this.host.eventProperties(context.sessionId),
          ...this.config?.properties,
          ...options.properties,
        },
      });
    } finally {
      this.context = undefined;
    }
    // Only an exception that is really queued (not dropped by the hook) sends its replay.
    if (recorded) {
      try {
        this.host.onCaptured?.(recorded);
      } catch {
        // The replay hook must never undo the capture.
      }
    }
  }

  private stampIdentity(event: TrackedEvent): void {
    const context = this.context ?? { identity: this.host.identity() };
    const props = event.properties;
    props.distinct_id = context.identity.distinctId;
    props.$device_id = context.identity.deviceId;
    delete props.$user_id;
    if (context.identity.userId !== undefined) props.$user_id = context.identity.userId;
    if (context.time !== undefined) props.time = context.time;
  }

  /** Drops the oldest op of `kind` over `max`; a fatal capture goes last. */
  private trimPending(kind: PendingOp["kind"], max: number): void {
    const isOfKind = (op: PendingOp) => op.kind === kind;
    const isFatalCapture = (op: PendingOp) => op.kind === "capture" && op.options.level === "fatal";
    while (this.pending.filter(isOfKind).length > max) {
      const lessSevere = this.pending.findIndex((op) => isOfKind(op) && !isFatalCapture(op));
      this.pending.splice(lessSevere >= 0 ? lessSevere : this.pending.findIndex(isOfKind), 1);
    }
  }
}
