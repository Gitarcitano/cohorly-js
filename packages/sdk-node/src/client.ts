import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  type Breadcrumb,
  type BreadcrumbInput,
  buildExceptionList,
  type ExceptionListEntry,
} from "@cohorly/core";
import { FlagDefinitionsPoller } from "./definitions.js";
import {
  EXCEPTION_EVENT,
  normalizeLevel,
  pushBreadcrumb,
  relativizeFrames,
  snapshotBreadcrumb,
  withoutReservedKeys,
} from "./exceptions.js";
import { createFlags } from "./flags.js";
import { evaluateFlagLocally } from "./local-eval.js";
import { createPeople } from "./people.js";
import {
  fetchDefinitionsFetcher,
  fetchJsonFetcher,
  fetchTransport,
  TransportError,
} from "./transport.js";
import type {
  BatchEventInput,
  Callback,
  CaptureExceptionOptions,
  CohorlyConfig,
  CohorlyFetcher,
  CohorlyFlags,
  CohorlyPeople,
  CohorlyTransport,
  EngagePayload,
  FlagResult,
  FlushExceptionsOptions,
  Properties,
  TrackEvent,
  WithCohorlyOptions,
} from "./types.js";
import {
  registerUncaught,
  type UncaughtClient,
  type UncaughtKind,
  unregisterUncaught,
} from "./uncaught.js";
import { uuid } from "./uuid.js";
import { LIB_VERSION } from "./version.js";

const DEFAULT_HOST = "https://cohorly-service.velloalabs.com";
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_FLAG_POLL_INTERVAL_MS = 30000;
/** Exposure event name, matching the other Cohorly SDKs. */
const EXPOSURE_EVENT = "$feature_flag_called";
const BACKOFF_BASE_MS = 2000;
const DEFAULT_MAX_EXCEPTION_QUEUE_SIZE = 50;
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
/** distinct_id of exceptions with no distinctId and no serverName: one fixed id, never one per error. */
const DEFAULT_SERVER_DISTINCT_ID = "server";
/** Server-side hard cap on events per /track request (400 above it). */
export const SERVER_MAX_BATCH = 500;

/** Resolves `promise` into `callback` (if given) without losing the promise. */
function nodeify(promise: Promise<void>, callback?: Callback): Promise<void> {
  if (callback) {
    promise.then(
      () => callback(),
      (err) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  }
  return promise;
}

function isFatal(event: TrackEvent): boolean {
  return event.properties.$exception_level === "fatal";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Per-invocation state of withCohorly(), carried by AsyncLocalStorage. */
interface InvocationScope {
  breadcrumbs: Breadcrumb[];
}

/**
 * Server-side Cohorly client, mirroring the mixpanel-node API: stateless
 * (distinct_id passed on every call, no persistent identity or storage),
 * with an in-memory batching queue for /track and immediate sends for
 * /engage and /alias. Create via `Cohorly.init(token, config)` or
 * `new CohorlyNode(token, config)`.
 */
export class CohorlyNode {
  readonly people: CohorlyPeople;
  readonly flags: CohorlyFlags;

  private readonly token: string;
  private readonly host: string;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly debug: boolean;
  private readonly maxQueueSize: number;
  private readonly maxRetryDelayMs: number;
  private readonly transport: CohorlyTransport;
  private readonly fetcher: CohorlyFetcher;
  /** Definitions poller, only when a flagSecret was configured (ADR-0011). */
  private readonly definitions: FlagDefinitionsPoller | undefined;

  private readonly release: string | undefined;
  private readonly dist: string | undefined;
  /** `appVersion ?? release`: what every event gets as `$app_version_string`. */
  private readonly appVersionString: string | undefined;
  private readonly beforeSendException: CohorlyConfig["beforeSendException"];
  private readonly maxExceptionQueueSize: number;
  private readonly serverName: string | undefined;
  private readonly projectRoot: string;
  private readonly flushTimeoutMs: number;
  private readonly scope = new AsyncLocalStorage<InvocationScope>();
  /** Set while captureUncaught listeners are registered for this client. */
  private uncaughtClient: UncaughtClient | undefined;
  /** `captureExceptions: false`: nothing is captured, manually or by the uncaught handlers. */
  private readonly captureExceptionsDisabled: boolean;

  private queue: TrackEvent[] = [];
  /**
   * `$exception` events, apart from `queue` so ordinary events can never
   * push one out. In memory only, like the event queue.
   */
  private exceptionQueue: TrackEvent[] = [];
  /** Exceptions currently being sent, so a concurrent send does not repeat them. */
  private readonly exceptionsInFlight = new Set<TrackEvent>();
  /** Breadcrumbs recorded outside any withCohorly() invocation. */
  private breadcrumbs: Breadcrumb[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  /** Serializes flushes so concurrent flush()/timer ticks never interleave. */
  private flushChain: Promise<void> = Promise.resolve();
  /**
   * Aborts the flush running right now (its transport calls get the signal).
   * flushWithTimeout() fires it at its deadline, so a hung request never
   * outlives the deadline nor holds every later flush behind it.
   */
  private runningFlushAbort: AbortController | undefined;

  /** Consecutive flush failures, drives exponential backoff. Reset on success. */
  private consecutiveFailures = 0;
  /** Timestamp (ms) before which non-forced flushes are skipped. */
  private backoffUntil = 0;
  /** Current effective per-flush batch size; halved on 413 (floor 1). */
  private effectiveBatchSize: number;

  constructor(token: string, config: CohorlyConfig = {}) {
    if (!token || typeof token !== "string") {
      throw new TypeError("cohorly: a project token is required");
    }
    this.token = token;
    this.host = (config.host ?? DEFAULT_HOST).replace(/\/$/, "");
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.batchSize = Math.max(
      1,
      Math.min(config.batchSize ?? DEFAULT_BATCH_SIZE, SERVER_MAX_BATCH),
    );
    this.debug = config.debug ?? false;
    this.maxQueueSize = config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxRetryDelayMs = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.transport = config.transport ?? fetchTransport;
    this.fetcher = config.fetcher ?? fetchJsonFetcher;
    this.effectiveBatchSize = this.batchSize;
    this.release = config.release;
    this.dist = config.dist;
    this.appVersionString = config.appVersion ?? config.release;
    this.beforeSendException = config.beforeSendException;
    this.maxExceptionQueueSize = Math.max(
      1,
      config.maxExceptionQueueSize ?? DEFAULT_MAX_EXCEPTION_QUEUE_SIZE,
    );
    // An empty value (a blank env var) means "not set", not an empty distinct_id.
    this.serverName = config.serverName || undefined;
    this.projectRoot = path.resolve(config.projectRoot ?? process.cwd());
    this.flushTimeoutMs = config.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;

    this.people = createPeople((payload, callback) =>
      this.sendEngage(payload, callback),
    );
    if (config.flagSecret) {
      this.definitions = new FlagDefinitionsPoller({
        url: `${this.host}/flags/local-evaluation`,
        secret: config.flagSecret,
        intervalMs: config.flagPollIntervalMs ?? DEFAULT_FLAG_POLL_INTERVAL_MS,
        fetcher: config.definitionsFetcher ?? fetchDefinitionsFetcher,
        log: (...args) => this.log(...args),
      });
    }

    this.flags = createFlags(
      (distinctId, flagKeys) => this.resolveFlags(distinctId, flagKeys),
      (distinctId, key, response) => this.trackExposure(distinctId, key, response),
    );

    this.captureExceptionsDisabled = config.captureExceptions === false;

    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.enqueueFlush(false).catch((err) =>
          this.log("auto-flush failed", err),
        );
      }, this.flushIntervalMs);
      // Don't keep the Node process alive just for the flush timer.
      const timer = this.flushTimer as { unref?: () => void };
      timer.unref?.();
    }

    if (config.captureUncaught && config.captureExceptions !== false) {
      this.uncaughtClient = {
        captureUncaughtError: (error, kind) => this.captureUncaughtError(error, kind),
        flushWithTimeout: () => this.flushWithTimeout(),
      };
      registerUncaught(this.uncaughtClient);
    }
  }

  /**
   * Queue an event for delivery. `properties.distinct_id` is required
   * (server-side style, like mixpanel-node). Default properties are stamped:
   * `time` (unix ms, now) and `$insert_id` (uuid) unless supplied by the
   * caller, plus `$lib` = "node" and `$lib_version`.
   *
   * The callback/promise settles when the event is accepted into the queue;
   * delivery happens asynchronously in batches (size trigger + interval).
   */
  track(
    event: string,
    properties: Properties & { distinct_id: string },
    callback?: Callback,
  ): Promise<void> {
    return nodeify(
      Promise.resolve().then(() => this.enqueue([this.buildEvent(event, properties)])),
      callback,
    );
  }

  /** Queue multiple events at once (mixpanel-node `track_batch`). */
  trackBatch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return nodeify(
      Promise.resolve().then(() =>
        this.enqueue(events.map((e) => this.buildEvent(e.event, e.properties))),
      ),
      callback,
    );
  }

  /** mixpanel-node-style alias for {@link trackBatch}. */
  track_batch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.trackBatch(events, callback);
  }

  /**
   * Track a historical event with an explicit timestamp (mixpanel-node
   * `import`). `time` is a Date or unix ms. Cohorly's /track accepts any
   * `time`, so this queues through the same pipeline as {@link track}.
   */
  import(
    event: string,
    time: Date | number,
    properties: Properties & { distinct_id: string },
    callback?: Callback,
  ): Promise<void> {
    const ms = time instanceof Date ? time.getTime() : time;
    return this.track(event, { ...properties, time: ms }, callback);
  }

  /** Batch form of {@link import}: events must carry `properties.time`. */
  importBatch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.trackBatch(events, callback);
  }

  /** mixpanel-node-style alias for {@link importBatch}. */
  import_batch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.importBatch(events, callback);
  }

  /**
   * Create an alias for a distinct id (POST /alias). Sent immediately, not
   * queued; the promise/callback settles with the server response.
   */
  alias(distinctId: string, alias: string, callback?: Callback): Promise<void> {
    return nodeify(
      this.transport(
        `${this.host}/alias`,
        { alias, distinct_id: distinctId },
        this.headers(),
      ),
      callback,
    );
  }

  /**
   * Force-flush the queue now, draining it in <=500-event requests. Runs even
   * during retry backoff (an explicit "try now"). Rejects with the transport
   * error if the queue could not be fully drained (events are kept for retry
   * per the retry contract).
   */
  flush(callback?: Callback): Promise<void> {
    return nodeify(this.enqueueFlush(true), callback);
  }

  /**
   * Stop the auto-flush timer and the flag-definitions poller, and attempt a
   * final flush. Never rejects -
   * a failed final flush is logged (debug) and remaining events are dropped
   * with the process. Call this on graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.definitions?.stop();
    if (this.uncaughtClient) {
      unregisterUncaught(this.uncaughtClient);
      this.uncaughtClient = undefined;
    }
    try {
      await this.enqueueFlush(true);
    } catch (err) {
      this.log("final flush on shutdown failed", err);
    }
  }

  /**
   * Resolves once the first flag-definitions fetch has settled (successfully
   * or not). Resolves immediately when no `flagSecret` is configured. Useful
   * at boot to avoid the first few reads falling back to the network.
   */
  get flagDefinitionsReady(): Promise<void> {
    return this.definitions?.ready ?? Promise.resolve();
  }

  /** Number of events currently queued (mainly for tests/monitoring). */
  get queueSize(): number {
    return this.queue.length;
  }

  /** Number of exceptions currently queued (mainly for tests/monitoring). */
  get exceptionQueueSize(): number {
    return this.exceptionQueue.length;
  }

  /**
   * Queue a `$exception` event for anything thrown. `$exception_list` holds
   * `error` and its `cause` chain (outermost first, at most 5, cycle-safe)
   * with frames parsed from `error.stack`, oldest call first, paths relative
   * to `projectRoot`. A non-Error becomes a synthetic exception. `tags` and
   * `extra` become top-level properties (`tags` wins) but never override a
   * reserved key. A flush starts right away (it respects retry backoff), so
   * an exception never waits for `batchSize`.
   *
   * Returns the queued event, or `null` when `beforeSendException` dropped
   * it. Never throws.
   */
  captureException(
    error: unknown,
    options: CaptureExceptionOptions = {},
  ): TrackEvent | null {
    try {
      const list = buildExceptionList(error, {
        handled: options.mechanism?.handled ?? true,
        type: options.mechanism?.type ?? "generic",
      });
      return this.captureExceptionList(list, options);
    } catch (err) {
      this.log("captureException failed", err);
      return null;
    }
  }

  /**
   * Lower-level captureException() for callers that build `$exception_list`
   * themselves. `options.mechanism` is ignored (each entry carries its own).
   * Returns `null` for an empty list or when `beforeSendException` dropped
   * the event. Never throws.
   */
  captureExceptionList(
    list: ExceptionListEntry[],
    options: CaptureExceptionOptions = {},
  ): TrackEvent | null {
    try {
      if (this.captureExceptionsDisabled) return null;
      if (!Array.isArray(list) || list.length === 0) return null;
      const exceptionProps: Properties = {
        $exception_list: relativizeFrames(list, this.projectRoot),
        $exception_level: normalizeLevel(options.level),
      };
      if (options.fingerprint) exceptionProps.$exception_fingerprint = options.fingerprint;
      if (options.title) exceptionProps.error_title = options.title;
      if (this.release !== undefined) exceptionProps.$exception_release = this.release;
      if (this.dist !== undefined) exceptionProps.$exception_dist = this.dist;
      const breadcrumbs = this.currentBreadcrumbs();
      if (breadcrumbs.length > 0) {
        exceptionProps.$exception_breadcrumbs = breadcrumbs.map(snapshotBreadcrumb);
      }

      const distinctId =
        typeof options.distinctId === "string" && options.distinctId.length > 0
          ? options.distinctId
          : (this.serverName ?? DEFAULT_SERVER_DISTINCT_ID);
      const built = this.buildEvent(EXCEPTION_EVENT, {
        ...withoutReservedKeys(options.extra),
        ...withoutReservedKeys(options.tags),
        // Runtime context describes this process; a tag must not contradict it.
        ...(this.serverName !== undefined ? { server_name: this.serverName } : {}),
        runtime: "node",
        node_version: process.version,
        distinct_id: distinctId,
      });
      Object.assign(built.properties, exceptionProps);

      let evt: TrackEvent | null = built;
      if (this.beforeSendException) {
        try {
          evt = this.beforeSendException(built);
        } catch (err) {
          this.log("beforeSendException threw, dropping the exception", err);
          return null;
        }
        if (!evt || typeof evt !== "object" || !evt.properties) {
          this.log("beforeSendException dropped the exception");
          return null;
        }
      }

      try {
        JSON.stringify(evt);
      } catch (err) {
        // A hook that adds a circular value must not wedge the queue: the transport would throw on every retry.
        this.log("exception is not JSON serializable, dropping it", err);
        return null;
      }

      this.exceptionQueue.push(evt);
      this.enforceExceptionQueueCap();
      this.enqueueFlush(false).catch((err) =>
        this.log("exception-triggered flush failed", err),
      );
      return evt;
    } catch (err) {
      this.log("captureException failed", err);
      return null;
    }
  }

  /**
   * Record a breadcrumb: a step that led up to an exception. The last 50
   * travel with every exception as `$exception_breadcrumbs`; `message` is
   * cut to 1000 chars. Inside withCohorly() the trail belongs to that
   * invocation only, so concurrent invocations never see each other's.
   */
  addBreadcrumb(crumb: BreadcrumbInput): void {
    try {
      pushBreadcrumb(this.scope.getStore()?.breadcrumbs ?? this.breadcrumbs, crumb);
    } catch (err) {
      this.log("addBreadcrumb failed", err);
    }
  }

  /**
   * Wraps a serverless handler (sync or async). If it throws or rejects, the
   * error is captured (`mechanism: serverless`, unhandled), the queues are
   * flushed with a timeout, and the SAME error is rethrown - even when the
   * flush times out or fails. The wrapper is always async: a sync throw
   * comes back as a rejection, because the flush has to finish first. A
   * handler that returns normally gets no capture and no forced flush. Each
   * call has its own breadcrumb trail.
   */
  withCohorly<A extends unknown[], R>(
    handler: (...args: A) => R,
    options: WithCohorlyOptions<A> = {},
  ): (...args: A) => Promise<Awaited<R>> {
    const client = this;
    return function wrapped(this: unknown, ...args: A): Promise<Awaited<R>> {
      const fail = async (error: unknown): Promise<never> => {
        let distinctId: string | undefined;
        try {
          distinctId = options.distinctId?.(...args);
        } catch (err) {
          client.log("withCohorly distinctId callback threw", err);
        }
        client.captureException(error, {
          distinctId,
          level: "error",
          mechanism: { type: "serverless", handled: false },
        });
        await client.flushWithTimeout(options.flushTimeoutMs);
        throw error;
      };
      return client.scope.run({ breadcrumbs: [] }, () => {
        let result: R;
        try {
          result = handler.apply(this, args);
        } catch (error) {
          return fail(error);
        }
        if (isPromiseLike(result)) {
          return Promise.resolve(result).then(
            (value) => value as Awaited<R>,
            fail,
          );
        }
        return Promise.resolve(result as Awaited<R>);
      });
    };
  }

  /**
   * Force-flush exceptions, then events, giving up after `timeoutMs`
   * (default `flushTimeoutMs`). Resolves true when both queues drained,
   * false on timeout or failure (nothing is lost: queued items stay for the
   * next flush). Never rejects; its timer never keeps the process alive.
   *
   * At the deadline the flush in progress (this one, or the one ahead of it
   * in the queue) is aborted through the transport's `signal`: the request
   * fails like a network error (batch kept, backoff), and this flush, if it
   * had not started yet, never starts.
   */
  async flushWithTimeout(timeoutMs: number = this.flushTimeoutMs): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new AbortController();
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        const reason = new Error("cohorly: flush timed out");
        deadline.abort(reason);
        this.runningFlushAbort?.abort(reason);
        resolve(false);
      }, Math.max(0, timeoutMs));
      (timer as { unref?: () => void }).unref?.();
    });
    const work = this.enqueueFlush(true, deadline.signal).then(
      () => this.queue.length === 0 && this.exceptionQueue.length === 0,
      () => false,
    );
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send queued exceptions now, without the event queue, ignoring backoff
   * and any flush already in flight (an exception in flight elsewhere may go
   * twice; the server dedups by `$insert_id`). Same retry contract as
   * flush(). Never rejects: a failed batch stays queued.
   */
  async flushExceptions(options: FlushExceptionsOptions = {}): Promise<void> {
    await this.sendExceptions(options.fatalOnly ?? false, true);
  }

  private buildEvent(
    event: string,
    properties: Properties & { distinct_id: string },
  ): TrackEvent {
    if (!event || typeof event !== "string") {
      throw new TypeError("cohorly: event name is required");
    }
    const distinctId = properties?.distinct_id;
    if (typeof distinctId !== "string" || distinctId.length === 0) {
      throw new TypeError(
        `cohorly: properties.distinct_id is required to track "${event}"`,
      );
    }
    return {
      event,
      properties: {
        ...properties,
        distinct_id: distinctId,
        time: typeof properties.time === "number" ? properties.time : Date.now(),
        $insert_id:
          typeof properties.$insert_id === "string"
            ? properties.$insert_id
            : uuid(),
        $lib: "node",
        $lib_version: LIB_VERSION,
        ...(this.appVersionString !== undefined &&
        properties.$app_version_string === undefined
          ? { $app_version_string: this.appVersionString }
          : {}),
      },
    };
  }

  /** The trail of the current withCohorly() invocation, else the client's. */
  private currentBreadcrumbs(): Breadcrumb[] {
    return this.scope.getStore()?.breadcrumbs ?? this.breadcrumbs;
  }

  private captureUncaughtError(error: unknown, kind: UncaughtKind): void {
    if (kind === "uncaughtException") {
      this.captureException(error, {
        level: "fatal",
        mechanism: { type: "onuncaughtexception", handled: false },
      });
    } else {
      this.captureException(error, {
        level: "error",
        mechanism: { type: "onunhandledrejection", handled: false },
      });
    }
  }

  /**
   * Trims the exception queue to `maxExceptionQueueSize`: the OLDEST
   * NON-FATAL exception goes first, the oldest fatal one only when every
   * queued exception is fatal. Among equals, one that is not being sent goes
   * first, but being in flight never saves a non-fatal exception from a
   * fatal one: a crash report survives queue pressure.
   */
  private enforceExceptionQueueCap(): void {
    let dropped = 0;
    while (this.exceptionQueue.length > this.maxExceptionQueueSize) {
      const idle = (evt: TrackEvent) => !this.exceptionsInFlight.has(evt);
      const victim = [
        (evt: TrackEvent) => idle(evt) && !isFatal(evt),
        (evt: TrackEvent) => !isFatal(evt),
        idle,
        () => true,
      ]
        .map((match) => this.exceptionQueue.findIndex(match))
        .find((index) => index !== -1);
      this.exceptionQueue.splice(victim ?? 0, 1);
      dropped += 1;
    }
    if (dropped > 0) this.log("exception queue cap exceeded, dropped exceptions", dropped);
  }

  /** Exceptions in send order: fatal first, stable inside each group. */
  private orderedExceptions(fatalOnly: boolean): TrackEvent[] {
    const fatal = this.exceptionQueue.filter(isFatal);
    if (fatalOnly) return fatal;
    return [...fatal, ...this.exceptionQueue.filter((evt) => !isFatal(evt))];
  }

  /**
   * Sends queued exceptions in batches, fatal first, through the retry
   * contract. Returns the error of the batch that stopped it, if any.
   * Exceptions in flight on another send are skipped unless
   * `includeInFlight` (flushExceptions() must not wait on them).
   */
  private async sendExceptions(
    fatalOnly: boolean,
    includeInFlight: boolean,
    signal?: AbortSignal,
  ): Promise<{ error: unknown } | undefined> {
    for (;;) {
      // Checked even with nothing queued, so an aborted flush stops here.
      if (signal?.aborted) return { error: signal.reason };
      const size = Math.max(1, Math.min(this.effectiveBatchSize, SERVER_MAX_BATCH));
      const batch = this.orderedExceptions(fatalOnly)
        .filter((evt) => includeInFlight || !this.exceptionsInFlight.has(evt))
        .slice(0, size);
      if (batch.length === 0) return undefined;
      const removeBatch = () => {
        const sent = new Set(batch);
        this.exceptionQueue = this.exceptionQueue.filter((evt) => !sent.has(evt));
      };
      for (const evt of batch) this.exceptionsInFlight.add(evt);
      try {
        await this.transport(`${this.host}/track`, batch, this.headers(), signal);
        removeBatch();
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
      } catch (err) {
        const disposition = this.handleFlushError(err, removeBatch);
        if (disposition === "dropped") continue;
        if (disposition === "halved" && batch.length > 1) continue;
        return { error: err };
      } finally {
        for (const evt of batch) this.exceptionsInFlight.delete(evt);
      }
    }
  }

  private enqueue(events: TrackEvent[]): void {
    this.queue.push(...events);
    if (this.queue.length > this.maxQueueSize) {
      const overflow = this.queue.length - this.maxQueueSize;
      this.queue.splice(0, overflow);
      this.log("queue cap exceeded, dropped oldest events", overflow);
    }
    if (this.queue.length >= this.batchSize) {
      this.enqueueFlush(false).catch((err) =>
        this.log("size-triggered flush failed", err),
      );
    }
  }

  /**
   * Chains a flush behind any in-flight one so flushes never interleave.
   * `signal` (flushWithTimeout's deadline) cancels it before it starts and
   * aborts its requests once it runs.
   */
  private enqueueFlush(force: boolean, signal?: AbortSignal): Promise<void> {
    const run = this.flushChain
      .catch(() => undefined)
      .then(() => this.runFlush(force, signal));
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private async runFlush(force: boolean, deadline?: AbortSignal): Promise<void> {
    if (deadline?.aborted) return;
    if (!force && Date.now() < this.backoffUntil) return;
    const controller = new AbortController();
    const onDeadline = () => controller.abort(deadline?.reason);
    deadline?.addEventListener("abort", onDeadline, { once: true });
    this.runningFlushAbort = controller;
    try {
      await this.drainQueues(force, controller.signal);
    } finally {
      deadline?.removeEventListener("abort", onDeadline);
      if (this.runningFlushAbort === controller) this.runningFlushAbort = undefined;
    }
  }

  /**
   * Sends the queues in batches. The exception queue is looked at again
   * before EVERY event batch (fatal first, then the rest), so an exception
   * captured while an event batch is in flight goes next, not after the
   * remaining event batches. A failed exception batch holds the event
   * batches back in this flush.
   */
  private async drainQueues(force: boolean, signal: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (;;) {
      // An aborted signal stops the flush here too: sendExceptions reports it.
      const failed = await this.sendExceptions(false, false, signal);
      if (failed) {
        if (force) throw failed.error;
        return;
      }
      if (this.queue.length === 0) break;
      if (!force && Date.now() < this.backoffUntil) return;
      const size = Math.max(
        1,
        Math.min(this.effectiveBatchSize, SERVER_MAX_BATCH),
      );
      const batch = this.queue.slice(0, size);
      try {
        await this.transport(`${this.host}/track`, batch, this.headers(), signal);
        this.queue = this.queue.slice(batch.length);
        // Success: clear failure state and backoff.
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
      } catch (err) {
        const disposition = this.handleFlushError(err, () => {
          this.queue = this.queue.slice(batch.length);
        });
        if (disposition === "dropped") continue; // 400: batch removed, keep draining
        if (disposition === "halved" && batch.length > 1) continue; // retry smaller now
        lastError = err;
        break;
      }
    }
    if (force && lastError !== undefined) throw lastError;
  }

  /**
   * Applies the retry contract to a failed flush, for the event queue and
   * the exception queue alike (one shared backoff state). `dropBatch`
   * removes the just-attempted batch from its queue.
   *
   * - 400: payload permanently rejected - drop that batch, do not retry it.
   * - 413: payload too big - halve the effective batch size (floor 1), keep
   *   the queue, retry smaller (no backoff).
   * - 401: invalid token - keep queue, warn, backoff at max delay.
   * - 429 / 5xx / network: keep queue, exponential backoff (Retry-After, when
   *   present on a 429, overrides the computed delay, still capped).
   */
  private handleFlushError(
    err: unknown,
    dropBatch: () => void,
  ): "dropped" | "halved" | "backoff" {
    const status = err instanceof TransportError ? err.status : undefined;

    if (status === 400) {
      this.log("dropping batch permanently rejected with 400", err);
      dropBatch();
      return "dropped";
    }

    if (status === 413) {
      this.effectiveBatchSize = Math.max(
        1,
        Math.floor(this.effectiveBatchSize / 2),
      );
      this.log(
        "payload too large (413), halving batch size to",
        this.effectiveBatchSize,
      );
      // Keep queue intact; retry with the smaller batch.
      return "halved";
    }

    this.consecutiveFailures += 1;
    let delay = this.computeBackoffMs();
    if (status === 401) {
      delay = this.maxRetryDelayMs;
      this.log("invalid token (401), keeping queue and backing off at max delay");
    } else if (
      status === 429 &&
      err instanceof TransportError &&
      err.retryAfterMs !== undefined
    ) {
      delay = Math.min(err.retryAfterMs, this.maxRetryDelayMs);
    }
    this.backoffUntil = Date.now() + delay;
    this.log("flush failed, keeping queue and backing off", {
      status,
      delayMs: delay,
      consecutiveFailures: this.consecutiveFailures,
    });
    return "backoff";
  }

  /**
   * Exponential backoff with base 2000ms, doubling per consecutive failure,
   * capped at maxRetryDelayMs, with +/-20% jitter.
   */
  private computeBackoffMs(): number {
    const exp = BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1);
    const capped = Math.min(exp, this.maxRetryDelayMs);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  /**
   * Send a profile op to /engage immediately (not queued). The promise or
   * callback settles with the server response; failed engage ops are NOT
   * retried (matching the other Cohorly SDKs).
   */
  private sendEngage(payload: EngagePayload, callback?: Callback): Promise<void> {
    return nodeify(
      Promise.resolve().then(() => {
        if (!payload.distinct_id || typeof payload.distinct_id !== "string") {
          throw new TypeError(
            "cohorly: distinct_id is required for profile updates",
          );
        }
        return this.transport(`${this.host}/engage`, payload, this.headers());
      }),
      callback,
    );
  }

  /**
   * Resolve flags for a distinct id, preferring local evaluation (ADR-0011).
   *
   * With definitions loaded, every flag that is present and `localEvaluable`
   * is computed in-process with no network at all. Everything else - no flag
   * secret, definitions not fetched yet, unknown key, or a cohort-targeted
   * flag - goes down the unchanged /flags/evaluate path.
   *
   * `getAllFlags` (no `flagKeys`) tolerates a failed remote leg: the local
   * results still return and the non-local keys are simply absent. They are
   * never computed locally - a cohort rule must not silently fail to match.
   * Explicit-key calls keep the old semantics and surface the error.
   */
  private async resolveFlags(
    distinctId: string,
    flagKeys?: string[],
  ): Promise<Record<string, FlagResult>> {
    const defs = this.definitions?.get();
    if (!defs) return this.evaluateFlags(distinctId, flagKeys);
    if (!distinctId || typeof distinctId !== "string") {
      throw new TypeError("cohorly: distinct_id is required to evaluate flags");
    }

    const out: Record<string, FlagResult> = {};
    const remoteKeys: string[] = [];
    const keys = flagKeys ?? defs.map((d) => d.key);
    for (const key of keys) {
      const def = defs.find((d) => d.key === key);
      if (def?.localEvaluable) out[key] = evaluateFlagLocally(def, distinctId);
      else remoteKeys.push(key);
    }

    if (remoteKeys.length > 0) {
      if (flagKeys) {
        Object.assign(out, await this.evaluateFlags(distinctId, remoteKeys));
      } else {
        try {
          Object.assign(out, await this.evaluateFlags(distinctId, remoteKeys));
        } catch (err) {
          this.log("remote leg of getAllFlags failed, omitting those keys", err);
        }
      }
    }
    return out;
  }

  /**
   * Queue the opt-in `$feature_flag_called` exposure event. Fire-and-forget:
   * a flag read must never fail because its exposure event could not queue.
   */
  private trackExposure(
    distinctId: string,
    key: string,
    response: boolean | string,
  ): void {
    try {
      this.enqueue([
        this.buildEvent(EXPOSURE_EVENT, {
          distinct_id: distinctId,
          $feature_flag: key,
          $feature_flag_response: response,
        }),
      ]);
    } catch (err) {
      this.log("could not queue exposure event", err);
    }
  }

  /**
   * Evaluate feature flags for a distinct id via POST /flags/evaluate (sent
   * immediately, not queued). Failures surface to the caller like /engage
   * ops - they are NOT retried.
   */
  private async evaluateFlags(
    distinctId: string,
    flagKeys?: string[],
  ): Promise<Record<string, FlagResult>> {
    if (!distinctId || typeof distinctId !== "string") {
      throw new TypeError("cohorly: distinct_id is required to evaluate flags");
    }
    const res = await this.fetcher(
      `${this.host}/flags/evaluate`,
      {
        distinct_id: distinctId,
        ...(flagKeys !== undefined ? { flag_keys: flagKeys } : {}),
      },
      this.headers(),
    );
    const flags = (res as { flags?: unknown } | null | undefined)?.flags;
    if (!flags || typeof flags !== "object") return {};
    return flags as Record<string, FlagResult>;
  }

  private headers(): Record<string, string> {
    return { "X-Cohorly-Token": this.token };
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.warn("[cohorly]", ...args);
  }
}
