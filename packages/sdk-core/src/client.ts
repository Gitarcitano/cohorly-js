import { buildExceptionList } from "./exceptions/build.js";
import { METRIC_EVENT, MetricsAggregator } from "./metrics.js";
import { fetchFlagsFetcher, fetchTransport, TransportError } from "./transport.js";
import type {
  Breadcrumb,
  BreadcrumbInput,
  CaptureExceptionOptions,
  CohorlyClientOptions,
  CohorlyStorage,
  CohorlyTransport,
  ExceptionLevel,
  ExceptionListEntry,
  FlagDetails,
  FlagPersistenceMode,
  FlagResult,
  FlagsFetcher,
  FlushExceptionsOptions,
  PeopleProperties,
  TrackedEvent,
} from "./types.js";
import { uuid } from "./uuid.js";

const KEY_DISTINCT_ID = "cohorly_distinct_id";
const KEY_DEVICE_ID = "cohorly_device_id";
const KEY_ANONYMOUS = "cohorly_anonymous";
const KEY_SUPER_PROPS = "cohorly_super_props";
const KEY_QUEUE = "cohorly_queue";
const KEY_EXCEPTION_QUEUE = "cohorly_exception_queue";
const KEY_TIMED_EVENTS = "cohorly_timed_events";
const KEY_FLAGS = "chl_flags";
const KEY_OPT_OUT = "cohorly_opt_out";

/** Cohorly's hosted ingestion API. Used when no apiHost is supplied. */
const DEFAULT_API_HOST = "https://cohorly-service.velloalabs.com";
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_EXCEPTION_QUEUE_SIZE = 50;
/** Breadcrumbs kept in memory; the oldest is dropped first. */
export const MAX_BREADCRUMBS = 50;
/** Breadcrumb messages longer than this are cut. */
export const MAX_BREADCRUMB_MESSAGE_LENGTH = 1000;

const EXCEPTION_EVENT = "$exception";
const EXCEPTION_LEVELS: ReadonlySet<string> = new Set<ExceptionLevel>([
  "fatal",
  "error",
  "warning",
  "info",
]);
/** Keys `tags`/`extra` can never set on an exception (plus every `$exception_*`). */
const RESERVED_EXCEPTION_KEYS: ReadonlySet<string> = new Set([
  "error_title",
  "distinct_id",
  "time",
  "$insert_id",
  "$lib",
  "token",
  "$device_id",
  "$user_id",
]);

function isReservedExceptionKey(key: string): boolean {
  return key.startsWith("$exception_") || RESERVED_EXCEPTION_KEYS.has(key);
}

function withoutReservedKeys(
  props: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [key, value] of Object.entries(props)) {
    if (!isReservedExceptionKey(key)) out[key] = value;
  }
  return out;
}

function isFatal(event: TrackedEvent): boolean {
  return event.properties.$exception_level === "fatal";
}
const DEFAULT_MAX_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const BACKOFF_BASE_MS = 2000;
/**
 * Default flag-cache TTL: 24 hours, matching the Mixpanel flag-persistence
 * reference TTL for its persistent lookup policies.
 */
const DEFAULT_FLAG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard staleness bound for `persistenceUntilNetworkSuccess`: that policy
 * trades freshness for offline availability, so a cache past
 * `flagCacheTtlMs` is still served while it is within this window - the
 * served window is the wider of the configured TTL and 7 days.
 */
const FLAG_CACHE_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** A TTL must be a positive finite duration; anything else falls back to
 * the 24h default so a stray negative or NaN option cannot disable or
 * unbound the cache window. */
function normalizeFlagCacheTtlMs(ttl: number | undefined): number {
  return ttl !== undefined && Number.isFinite(ttl) && ttl > 0
    ? ttl
    : DEFAULT_FLAG_CACHE_TTL_MS;
}

/**
 * Persisted flag cache. `distinct_id` scopes the cache: on load it is
 * discarded when it does not match the current distinct id, so different
 * users never see each other's flags. `stored_at` bounds its age per the
 * active `flagPersistence` policy (see isFlagCacheUsable). Caches written
 * by pre-TTL SDK versions carry no `stored_at`; their age cannot be proven,
 * so they are served rather than expired - the graceful-upgrade path that
 * preserves the pre-feature behavior (the cache was served indefinitely).
 */
interface FlagsCache {
  distinct_id: string;
  flags: Record<string, FlagResult>;
  stored_at?: number;
}

/**
 * Transport/storage-agnostic analytics client. Platform SDKs (web, react-native, node)
 * inject a concrete CohorlyStorage + CohorlyTransport and layer platform defaults on top.
 */
export class CohorlyClient {
  private readonly apiHost: string;
  private readonly storage: CohorlyStorage;
  private readonly transport: CohorlyTransport;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly debug: boolean;
  private readonly lib: string;
  private readonly token: string | undefined;
  private readonly maxQueueSize: number;
  private readonly maxRetryDelayMs: number;
  private readonly release: string | undefined;
  private readonly dist: string | undefined;
  private readonly appVersion: string | undefined;
  private readonly eventProperties: ((event: string) => Record<string, unknown>) | undefined;
  private readonly beforeSendException:
    | ((event: TrackedEvent) => TrackedEvent | null)
    | undefined;
  private readonly maxExceptionQueueSize: number;
  private readonly captureExceptionsEnabled: boolean;
  /** Persisted opt-out flag; see optOutTracking(). */
  private optedOut: boolean;
  /**
   * Bumped by optOutTracking(). A send captures it before going on the wire
   * and, if it changed by the time the send settles, does not touch the retry
   * state: the batch it carried belongs to a queue that was discarded.
   */
  private optOutEpoch = 0;

  private distinctId: string;
  /**
   * Stable per-device/browser id (Mixpanel `$device_id`). Minted on first run,
   * persisted, and preserved across identify(); reset() mints a new one.
   */
  private deviceId: string;
  private anonymous: boolean;
  private superProps: Record<string, unknown>;
  /** Timed-event start timestamps (ms) keyed by event name. See timeEvent(). */
  private timedEvents: Record<string, number>;
  private queue: TrackedEvent[];
  /**
   * `$exception` events, persisted apart from `queue` so ordinary events can
   * never evict them, and always sent before it.
   */
  private exceptionQueue: TrackedEvent[];
  /** Exceptions currently being sent, so a concurrent flush does not send them twice. */
  private readonly exceptionsInFlight = new Set<TrackedEvent>();
  /** In memory only; see addBreadcrumb(). */
  private breadcrumbs: Breadcrumb[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  /** Consecutive flush failures, drives exponential backoff. Reset on success. */
  private consecutiveFailures = 0;
  /** Timestamp (ms) before which non-forced flushes are skipped. */
  private backoffUntil = 0;
  /** Current effective per-flush batch size; halved on 413 (floor 1). */
  private effectiveBatchSize: number;

  private readonly fetcher: FlagsFetcher;
  /** Flag persistence policy; see CohorlyClientOptions.flagPersistence. */
  private readonly flagPersistence: FlagPersistenceMode;
  /** TTL (ms) applied to the persisted flag cache. */
  private readonly flagCacheTtlMs: number;
  /** Last known flag results for the current distinct id (memory copy of the cache). */
  private flags: Record<string, FlagResult> = {};
  /** True once flags were loaded (from cache or a successful reload). */
  private flagsLoaded = false;
  /**
   * Where the currently served flags came from: "network" after a
   * successful reload this session, "persistence" while the persisted
   * cache is being served. Undefined until flags are loaded.
   */
  private flagsSource: "network" | "persistence" | undefined;
  /** Epoch ms the served persisted cache was written (persistence source only). */
  private flagsPersistedAt: number | undefined;
  /** TTL (ms) in effect for the served persisted cache (persistence source only). */
  private flagsTtlMs: number | undefined;
  private flagRequestSeq = 0;
  /** Flag evaluations on the wire; while one runs and no flags are loaded, `$metric` events wait in the queue. */
  private flagLoadsInFlight = 0;
  /** stop() ran: this client must not touch the persisted queue from late callbacks. */
  private stopped = false;
  private readonly flagListeners = new Set<
    (flags: Record<string, FlagResult>) => void
  >();
  private readonly sendExposureEvents: boolean;
  /**
   * Flag exposures already tracked this identity session, keyed
   * `${key}:${String(value)}`. In memory only, cleared on identify()/reset().
   */
  private readonly exposedFlags = new Set<string>();

  readonly people: PeopleProperties;
  /** Custom metrics: `count`, `gauge`, `distribution`, aggregated into `$metric` events. */
  readonly metrics: MetricsAggregator;

  constructor(options: CohorlyClientOptions) {
    this.apiHost = (options.apiHost ?? DEFAULT_API_HOST).replace(/\/$/, "");
    this.storage = options.storage;
    this.transport = options.transport ?? fetchTransport;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 20;
    this.debug = options.debug ?? false;
    this.lib = options.lib ?? "core";
    this.token = options.token;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.effectiveBatchSize = this.batchSize;
    this.release = options.release;
    this.dist = options.dist;
    this.appVersion = options.appVersion;
    this.eventProperties = options.eventProperties;
    this.beforeSendException = options.beforeSendException;
    this.maxExceptionQueueSize = Math.max(
      1,
      options.maxExceptionQueueSize ?? DEFAULT_MAX_EXCEPTION_QUEUE_SIZE,
    );
    this.captureExceptionsEnabled = options.captureExceptions !== false;
    this.optedOut = this.storage.get(KEY_OPT_OUT) === "1";

    const storedId = this.storage.get(KEY_DISTINCT_ID);
    if (storedId) {
      this.distinctId = storedId;
      this.anonymous = this.storage.get(KEY_ANONYMOUS) === "1";
    } else {
      this.distinctId = uuid();
      this.anonymous = true;
      this.storage.set(KEY_DISTINCT_ID, this.distinctId);
      this.storage.set(KEY_ANONYMOUS, "1");
    }

    // Device id: persisted separately so it survives identify(). For a fresh
    // install it equals the anon distinct id (Mixpanel's `$device:<uuid>`
    // convention); older installs migrating in mint a fresh one.
    const storedDevice = this.storage.get(KEY_DEVICE_ID);
    if (storedDevice) {
      this.deviceId = storedDevice;
    } else {
      this.deviceId = this.anonymous ? this.distinctId : uuid();
      this.storage.set(KEY_DEVICE_ID, this.deviceId);
    }

    this.fetcher = options.fetcher ?? fetchFlagsFetcher;
    this.sendExposureEvents = options.sendExposureEvents ?? true;
    this.flagPersistence =
      options.flagPersistence ?? "persistenceUntilNetworkSuccess";
    this.flagCacheTtlMs = normalizeFlagCacheTtlMs(options.flagCacheTtlMs);
    // Adopt the persisted flag cache when policy and freshness allow it, so
    // a restart serves the last known assignments immediately.
    this.adoptPersistedFlags();

    this.superProps = this.readJson(KEY_SUPER_PROPS, {});
    this.timedEvents = this.readJson(KEY_TIMED_EVENTS, {});
    this.queue = this.readJson(KEY_QUEUE, []);
    // Enforce the persisted cap on load in case an older/larger queue was stored.
    if (this.enforceQueueCap()) this.persistQueue();
    const storedExceptions = this.readJson<unknown>(KEY_EXCEPTION_QUEUE, []);
    this.exceptionQueue = Array.isArray(storedExceptions)
      ? (storedExceptions as TrackedEvent[])
      : [];
    if (this.enforceExceptionQueueCap()) this.persistExceptionQueue();
    // Opted out before a previous shutdown: whatever a crash left in storage
    // must not ship once this client is flushing again.
    if (this.optedOut) this.discardPending();
    // Exception capture off: a queue a previous session left must not ship.
    if (!this.captureExceptionsEnabled && this.exceptionQueue.length > 0) {
      this.exceptionQueue = [];
      this.persistExceptionQueue();
    }

    this.people = {
      set: (props) => this.sendEngage({ $set: props }),
      setOnce: (props) => this.sendEngage({ $set_once: props }),
      increment: (props) => this.sendEngage({ $add: props }),
      unset: (keys) => this.sendEngage({ $unset: keys }),
      delete: () => this.sendEngage({ $delete: true }),
    };

    // After the persisted flags and the queue are loaded: the aggregator reads
    // the kill switch flag immediately when a cached flag set was adopted.
    this.metrics = new MetricsAggregator(
      {
        trackAt: (event, props, time) => this.trackAt(event, props, time),
        onFeatureFlags: (cb) => this.onFeatureFlags(cb),
        areFeatureFlagsLoaded: () => this.areFeatureFlagsLoaded(),
        onDisabled: () => this.dropQueuedMetrics(),
        log: (...args) => this.log(...args),
      },
      options.metrics,
    );

    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.maybeFlush();
      }, this.flushIntervalMs);
      // Don't keep the Node process alive just for the flush timer.
      const timer = this.flushTimer as { unref?: () => void };
      timer.unref?.();
    }
  }

  getDistinctId(): string {
    return this.distinctId;
  }

  /** Stable per-device id stamped as `$device_id` on every event. */
  getDeviceId(): string {
    return this.deviceId;
  }

  isAnonymous(): boolean {
    return this.anonymous;
  }

  /**
   * Start a timer for `event`. The next `track(event)` of the same name attaches
   * `$duration` (seconds elapsed, 3 decimals) and clears the timer. Mirrors
   * Mixpanel's `time_event`. Timers are persisted so they survive a reload.
   */
  timeEvent(event: string): void {
    this.timedEvents[event] = Date.now();
    this.persistTimedEvents();
  }

  /** Cancel a pending timed event started via timeEvent(). */
  clearTimedEvent(event: string): void {
    if (event in this.timedEvents) {
      delete this.timedEvents[event];
      this.persistTimedEvents();
    }
  }

  /** Cancel all pending timed events. */
  clearTimedEvents(): void {
    this.timedEvents = {};
    this.persistTimedEvents();
  }

  /**
   * Stop collecting for this device: persisted (survives a restart), drops
   * every queued event, people operation and exception, and until
   * optInTracking() no track, people, alias or `$exception` is queued or sent.
   */
  optOutTracking(): void {
    this.optedOut = true;
    this.optOutEpoch += 1;
    this.storage.set(KEY_OPT_OUT, "1");
    this.discardPending();
    this.breadcrumbs = [];
    this.metrics.discard();
  }

  /** Resume collecting after optOutTracking(). Discarded data is not restored. */
  optInTracking(): void {
    this.optedOut = false;
    this.storage.remove(KEY_OPT_OUT);
    // Samples recorded while opted out are not sent after opting back in.
    this.metrics.discard();
  }

  hasOptedOutTracking(): boolean {
    return this.optedOut;
  }

  /**
   * Whether an exception captured now would be recorded: the app has not
   * opted out and `captureExceptions` is not `false`. Platform SDKs pass this
   * as `enabled` to native crash reporters.
   */
  isExceptionCaptureEnabled(): boolean {
    return !this.optedOut && this.captureExceptionsEnabled;
  }

  private discardPending(): void {
    this.queue = [];
    this.exceptionQueue = [];
    this.persistQueue();
    this.persistExceptionQueue();
  }

  track(event: string, properties: Record<string, unknown> = {}): TrackedEvent {
    // Timed events: if a timer was started for this name, attach $duration
    // (seconds, 3 decimals) and clear it.
    let duration: number | undefined;
    const startedAt = this.timedEvents[event];
    if (startedAt !== undefined) {
      duration = Math.round(((Date.now() - startedAt) / 1000) * 1000) / 1000;
      delete this.timedEvents[event];
      this.persistTimedEvents();
    }

    const evt = this.buildEvent(event, {
      ...properties,
      ...(duration !== undefined ? { $duration: duration } : {}),
    });
    if (this.optedOut) return evt;
    this.queue.push(evt);
    this.enforceQueueCap();
    this.persistQueue();
    if (this.queue.length >= this.batchSize) {
      this.maybeFlush();
    }
    return evt;
  }

  /**
   * Like track() but stamps `time` instead of Date.now(); track() never lets a
   * property override `time`. Used for aggregated events (`$metric`) that
   * describe a past window. No timed-event handling.
   */
  private trackAt(
    event: string,
    properties: Record<string, unknown>,
    time: number,
  ): TrackedEvent {
    const evt = this.buildEvent(event, properties, time);
    if (this.optedOut) return evt;
    // A super prop named like a field this event omitted (`metric_bucket` on a
    // counter) would otherwise leak into it and corrupt breakdowns.
    for (const key of Object.keys(evt.properties)) {
      if (key.startsWith("metric_") && !(key in properties)) {
        delete evt.properties[key];
      }
    }
    this.queue.push(evt);
    this.enforceQueueCap();
    this.persistQueue();
    // No size-triggered flush here: a window is queued by metrics.flush() on
    // teardown (pagehide, stop), where an immediate fetch would take the
    // `flushing` slot and keep the caller's beacon flush from sending.
    return evt;
  }

  /**
   * The one property pipeline every queued event goes through: super props,
   * then `properties`, then the SDK-owned fields. `$device_id`, `$user_id`
   * and `$app_version_string` are stamped last but never override a value
   * the caller passed explicitly (mirrors Mixpanel's $device_id/$user_id).
   */
  private buildEvent(
    event: string,
    properties: Record<string, unknown>,
    time: number = Date.now(),
  ): TrackedEvent {
    const props: TrackedEvent["properties"] = {
      ...this.superProps,
      ...properties,
      distinct_id: this.distinctId,
      time,
      $insert_id: uuid(),
      $lib: this.lib,
      ...(this.token !== undefined ? { token: this.token } : {}),
    };
    if (props.$device_id === undefined) props.$device_id = this.deviceId;
    if (!this.anonymous && props.$user_id === undefined) {
      props.$user_id = this.distinctId;
    }
    if (this.appVersion !== undefined && props.$app_version_string === undefined) {
      props.$app_version_string = this.appVersion;
    }
    if (this.eventProperties) {
      let extra: Record<string, unknown> = {};
      try {
        extra = this.eventProperties(event) ?? {};
      } catch (err) {
        this.log("eventProperties threw, ignored", err);
      }
      for (const [key, value] of Object.entries(extra)) {
        if (props[key] === undefined) props[key] = value;
      }
    }
    return { event, properties: props };
  }

  /**
   * Queue a `$exception` event for anything thrown. `$exception_list` holds
   * `error` and its `cause` chain (outermost first, at most 5 entries,
   * cycle-safe) with frames parsed from `error.stack`, oldest call first. A
   * non-Error becomes a synthetic exception. The event carries the current
   * breadcrumbs, `release`/`dist`, and the same properties as `track()`;
   * `tags` and `extra` become top-level properties but never override a
   * reserved key. Returns the queued event, or `null` when
   * `beforeSendException` dropped it. Never throws.
   */
  captureException(
    error: unknown,
    options: CaptureExceptionOptions = {},
  ): TrackedEvent | null {
    try {
      if (!this.isExceptionCaptureEnabled()) return null;
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
   * Lower-level captureException() for platform SDKs that build
   * `$exception_list` themselves (synthetic exceptions from a global
   * handler, a native crash report). `options.mechanism` is ignored: each
   * entry carries its own. Returns `null` for an empty list or when
   * `beforeSendException` dropped the event. Never throws.
   */
  captureExceptionList(
    list: ExceptionListEntry[],
    options: CaptureExceptionOptions = {},
  ): TrackedEvent | null {
    try {
      if (!this.isExceptionCaptureEnabled()) return null;
      if (!Array.isArray(list) || list.length === 0) return null;
      const level: ExceptionLevel =
        options.level !== undefined && EXCEPTION_LEVELS.has(options.level)
          ? options.level
          : "error";
      const exceptionProps: Record<string, unknown> = {
        $exception_list: list,
        $exception_level: level,
      };
      if (options.fingerprint) exceptionProps.$exception_fingerprint = options.fingerprint;
      if (options.title) exceptionProps.error_title = options.title;
      if (this.release !== undefined) exceptionProps.$exception_release = this.release;
      if (this.dist !== undefined) exceptionProps.$exception_dist = this.dist;
      if (this.breadcrumbs.length > 0) {
        exceptionProps.$exception_breadcrumbs = this.breadcrumbs.map(snapshotBreadcrumb);
      }

      const built = this.buildEvent(EXCEPTION_EVENT, {
        ...withoutReservedKeys(options.properties),
        ...withoutReservedKeys(options.extra),
        ...withoutReservedKeys(options.tags),
      });
      // Super properties are merged inside buildEvent; an `$exception_*` or
      // `error_title` key from them must not leak into an exception either.
      for (const key of Object.keys(built.properties)) {
        if (key.startsWith("$exception_") || key === "error_title") {
          delete built.properties[key];
        }
      }
      Object.assign(built.properties, exceptionProps);

      let evt: TrackedEvent | null = built;
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

      this.exceptionQueue.push(evt);
      this.enforceExceptionQueueCap();
      this.persistExceptionQueue();
      this.maybeFlush();
      return evt;
    } catch (err) {
      this.log("captureException failed", err);
      return null;
    }
  }

  /**
   * Record a breadcrumb: a step that led up to an exception. Kept in memory
   * only, the last {@link MAX_BREADCRUMBS}; every exception carries a copy as
   * `$exception_breadcrumbs`. `timestamp` defaults to now; `message` is cut
   * to {@link MAX_BREADCRUMB_MESSAGE_LENGTH} chars. Cleared by reset().
   */
  addBreadcrumb(crumb: BreadcrumbInput): void {
    if (this.optedOut) return;
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
    this.breadcrumbs.push(snapshotBreadcrumb(entry));
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - MAX_BREADCRUMBS);
    }
  }

  async identify(id: string): Promise<void> {
    if (id === this.distinctId) return;

    // Samples were taken as the outgoing identity.
    this.metrics.flush();

    // Switch identity first, synchronously, before any network call. An
    // offline or slow /alias POST must never block the switch: every
    // track() issued while identify() is still in flight has to stamp the
    // new id, not the stale anonymous one.
    const previousId = this.distinctId;
    const wasAnonymous = this.anonymous;
    this.distinctId = id;
    this.anonymous = false;
    this.storage.set(KEY_DISTINCT_ID, this.distinctId);
    this.storage.set(KEY_ANONYMOUS, "0");

    // Flags are per-identity: drop the previous identity's in-memory state
    // and remove its persisted cache before the refresh (a slow or failed
    // reload must not keep serving the old user's variants to the new id),
    // and let the new identity record its own exposures. The persisted entry
    // is removed under every policy - identity hygiene, not flag serving.
    this.clearFlagState();
    this.exposedFlags.clear();
    this.storage.remove(KEY_FLAGS);
    void this.reloadFeatureFlags();

    // Only link when the previous id was itself anonymous - an already
    // identified id is never re-aliased. This POST is now best-effort: it
    // stays awaited so callers/tests can observe completion, but a failure
    // is self-healing, since the server also links $device_id to $user_id
    // implicitly from any later event that carries both, so a dropped alias
    // call just delays the link rather than losing it.
    if (wasAnonymous && !this.optedOut) {
      try {
        await this.transport(`${this.apiHost}/alias`, {
          alias: previousId,
          distinct_id: id,
          ...(this.token !== undefined ? { token: this.token } : {}),
        });
      } catch (err) {
        this.log("alias request failed", err);
      }
    }
  }

  /**
   * Starts a new anonymous identity. Exceptions already captured stay queued
   * and still ship (they belong to the identity that hit them); breadcrumbs
   * are cleared, since they describe the outgoing identity's session.
   */
  reset(): void {
    this.metrics.flush();
    this.distinctId = uuid();
    this.deviceId = this.distinctId;
    this.anonymous = true;
    this.storage.set(KEY_DISTINCT_ID, this.distinctId);
    this.storage.set(KEY_DEVICE_ID, this.deviceId);
    this.storage.set(KEY_ANONYMOUS, "1");
    this.clearTimedEvents();
    this.breadcrumbs = [];
    // Flags are per-identity: the previous identity's flags must not be
    // served to the new anonymous id, so drop them and remove the persisted
    // cache (under every policy) before the refresh.
    this.clearFlagState();
    this.exposedFlags.clear();
    this.storage.remove(KEY_FLAGS);
    void this.reloadFeatureFlags();
  }

  /**
   * Re-evaluate feature flags for the current distinct id via
   * POST /flags/evaluate, caching the result in memory and - unless the
   * policy is `networkOnly` - in storage (key `chl_flags`, scoped by
   * distinct id, stamped with `stored_at`). Errors are swallowed - the
   * stale cache is kept and no rejection escapes.
   */
  async reloadFeatureFlags(): Promise<void> {
    // Opted out: no request at all (it would carry the distinct id). Whatever
    // is cached stays served.
    if (this.optedOut) return;
    this.flagLoadsInFlight += 1;
    try {
      const requestedId = this.distinctId;
      const seq = ++this.flagRequestSeq;
      const res = await this.fetcher(`${this.apiHost}/flags/evaluate`, {
        distinct_id: requestedId,
        ...(this.token !== undefined ? { token: this.token } : {}),
      });
      // Identity changed, or a newer reload was started, while this request was
      // in flight: these results are stale, discard them.
      if (requestedId !== this.distinctId || seq !== this.flagRequestSeq) return;
      const flags = (res as { flags?: unknown } | undefined)?.flags;
      if (!flags || typeof flags !== "object") {
        this.log("flag reload failed, keeping stale flags");
        return;
      }
      this.flags = flags as Record<string, FlagResult>;
      this.flagsLoaded = true;
      this.flagsSource = "network";
      this.flagsPersistedAt = undefined;
      this.flagsTtlMs = undefined;
      if (this.flagPersistence !== "networkOnly") {
        this.storage.set(
          KEY_FLAGS,
          JSON.stringify({
            distinct_id: requestedId,
            flags: this.flags,
            stored_at: Date.now(),
          } satisfies FlagsCache),
        );
      }
      this.emitFlags();
    } finally {
      this.flagLoadsInFlight -= 1;
    }
  }

  /** `$metric` events wait for the kill switch while flags are loading and none are loaded yet. */
  private metricsHeld(): boolean {
    return !this.flagsLoaded && this.flagLoadsInFlight > 0;
  }

  private dropQueuedMetrics(): void {
    // A stopped client no longer owns the persisted queue (a replacement
    // client may have written to it since).
    if (this.stopped) return;
    if (!this.queue.some((evt) => evt.event === METRIC_EVENT)) return;
    this.queue = this.queue.filter((evt) => evt.event !== METRIC_EVENT);
    this.persistQueue();
  }

  /**
   * Serves the persisted flag cache at construction when policy allows it:
   * the cache must belong to the CURRENT distinct id and be servable under
   * `flagPersistence` (see isFlagCacheUsable). A cache written for another
   * identity, or one too stale for the active policy, is removed and never
   * served. `networkOnly` never reads the persisted cache. Identity
   * switches do not adopt anything: the single-slot cache is removed on
   * identify()/reset(), so it can only ever hold the outgoing identity's
   * entry.
   */
  private adoptPersistedFlags(): void {
    if (this.flagPersistence === "networkOnly") return;
    const cache = this.readJson<FlagsCache | null>(KEY_FLAGS, null);
    if (!cache) return;
    if (cache.distinct_id !== this.distinctId || !this.isFlagCacheUsable(cache)) {
      this.storage.remove(KEY_FLAGS);
      return;
    }
    this.flags = cache.flags ?? {};
    this.flagsLoaded = true;
    this.flagsSource = "persistence";
    // Undefined for a legacy cache without `stored_at`: persistedAt stays
    // absent on FlagDetails and the exposure, while ttlMs is still reported.
    this.flagsPersistedAt = cache.stored_at;
    this.flagsTtlMs = this.flagCacheTtlMs;
    // A future `stored_at` (clock moved backwards after the write) would
    // stay fresh on every adoption until real time catches up, outliving
    // the TTL bound. Normalize the stamp to now and rewrite the entry so
    // subsequent launches age it honestly.
    if (typeof cache.stored_at === "number" && cache.stored_at > Date.now()) {
      this.flagsPersistedAt = Date.now();
      this.storage.set(
        KEY_FLAGS,
        JSON.stringify({
          distinct_id: this.distinctId,
          flags: this.flags,
          stored_at: this.flagsPersistedAt,
        } satisfies FlagsCache),
      );
    }
    // Served values changed: notify listeners (none exist at construction,
    // but the invariant mirrors emitFlags everywhere flags are adopted).
    this.emitFlags();
  }

  /** Notifies every onFeatureFlags listener; a throwing listener never
   * breaks the others (or the caller). */
  private emitFlags(): void {
    for (const cb of this.flagListeners) {
      try {
        cb(this.flags);
      } catch (err) {
        this.log("onFeatureFlags listener threw", err);
      }
    }
  }

  /**
   * True when a persisted cache may be served under `flagPersistence`.
   * `networkFirst` is strict: only while `stored_at` is within
   * `flagCacheTtlMs`. `persistenceUntilNetworkSuccess` trades freshness for
   * offline availability and serves until the wider of `flagCacheTtlMs` and
   * `FLAG_CACHE_MAX_STALE_MS` (a cache inside the TTL always serves; an
   * expired one still serves up to 7 days stale). A legacy cache without
   * `stored_at` has no provable age: it is served indefinitely, matching
   * the pre-TTL behavior it was written under, until a successful reload
   * replaces it with the stamped format.
   */
  private isFlagCacheUsable(cache: FlagsCache): boolean {
    if (typeof cache.stored_at !== "number") return true;
    // A future `stored_at` (clock moved backwards after the write) yields a
    // negative age that would bypass every bound below; clamp it to fresh.
    // The stamp itself is normalized to now on adoption so later launches
    // age it honestly instead of staying fresh until the clock catches up.
    const age = Math.max(0, Date.now() - cache.stored_at);
    if (this.flagPersistence === "networkFirst") {
      return age <= this.flagCacheTtlMs;
    }
    return age <= Math.max(this.flagCacheTtlMs, FLAG_CACHE_MAX_STALE_MS);
  }

  /** Drops all in-memory flag state of the outgoing identity, then notifies
   * listeners: the served set changed to empty, so subscribers (React hooks
   * included) stop serving the old values immediately instead of holding
   * them until the next reload lands. */
  private clearFlagState(): void {
    this.flags = {};
    this.flagsLoaded = false;
    this.flagsSource = undefined;
    this.flagsPersistedAt = undefined;
    this.flagsTtlMs = undefined;
    this.emitFlags();
  }

  /**
   * The flag's variant key when it has one, else its enabled boolean.
   * `fallback` (default `false`) is returned for unknown flags or before
   * flags are loaded; a read that resolves to the fallback is a default,
   * not an exposure - it emits no `$feature_flag_called`.
   */
  getFeatureFlag(
    key: string,
    fallback: boolean | string = false,
  ): boolean | string {
    const flag = this.flags[key];
    if (!flag) return fallback;
    const value = flag.variant ?? flag.enabled;
    this.trackExposure(key, value);
    return value;
  }

  /**
   * The flag's enabled boolean. `fallback` (default `false`) is returned for
   * unknown flags or before flags are loaded; a fallback read is not an
   * exposure.
   */
  isFeatureEnabled(key: string, fallback = false): boolean {
    const flag = this.flags[key];
    if (!flag) return fallback;
    this.trackExposure(key, flag.variant ?? flag.enabled);
    return flag.enabled;
  }

  /**
   * The full result for one flag, including where the value was served from.
   * `source` is "network" for a successful evaluation this session,
   * "persistence" for the identity-scoped persisted cache (within the
   * policy's staleness window; the cache's real age stays observable via
   * `persistedAt`, and `persistedAt` is absent for a legacy cache without
   * `stored_at`), or "fallback" when the flag is unknown - in which case
   * `value` is `fallback` (default
   * `false`) and `enabled` is `Boolean(fallback)`. A read of a known flag
   * counts as an exposure, like the other getters; a fallback result never
   * does.
   */
  getFeatureFlagDetails(
    key: string,
    fallback: boolean | string = false,
  ): FlagDetails {
    const flag = this.flags[key];
    if (!flag) {
      return {
        key,
        value: fallback,
        enabled: Boolean(fallback),
        payload: null,
        source: "fallback",
      };
    }
    const value = flag.variant ?? flag.enabled;
    this.trackExposure(key, value);
    const details: FlagDetails = {
      key,
      value,
      enabled: flag.enabled,
      payload: flag.payload ?? null,
      source: this.flagsSource ?? "network",
    };
    if (details.source === "persistence") {
      // Absent for a legacy cache without `stored_at` (unprovable age);
      // ttlMs is still reported either way.
      if (this.flagsPersistedAt !== undefined) {
        details.persistedAt = this.flagsPersistedAt;
      }
      details.ttlMs = this.flagsTtlMs;
    }
    return details;
  }

  /**
   * Emit `$feature_flag_called` once per (key, value) per identity session.
   * Only real reads of a loaded, known flag count as an exposure - the
   * fallback returned for an unknown key or before load is a default, not
   * an exposure. The event always carries `$feature_flag_source` (the same
   * "network"/"persistence" provenance as getFeatureFlagDetails), and for
   * persistence-sourced values also `$feature_flag_ttl_ms` and - when the
   * served cache carries `stored_at` - `$feature_flag_persisted_at`. Dedup
   * is by (key, value): the same value served first from persistence and
   * later from network is not re-emitted.
   */
  private trackExposure(key: string, value: boolean | string): void {
    if (!this.sendExposureEvents || !this.flagsLoaded) return;
    const dedupKey = `${key}:${String(value)}`;
    if (this.exposedFlags.has(dedupKey)) return;
    this.exposedFlags.add(dedupKey);
    this.track("$feature_flag_called", {
      $feature_flag: key,
      $feature_flag_response: value,
      $feature_flag_source: this.flagsSource ?? "network",
      ...(this.flagsSource === "persistence"
        ? {
            // Absent for a legacy cache without `stored_at`.
            ...(this.flagsPersistedAt !== undefined
              ? { $feature_flag_persisted_at: this.flagsPersistedAt }
              : {}),
            $feature_flag_ttl_ms: this.flagsTtlMs,
          }
        : {}),
    });
  }

  getFeatureFlagPayload(key: string): unknown | null {
    return this.flags[key]?.payload ?? null;
  }

  /**
   * Whether a flag set is currently being served (a successful network
   * evaluation or an adopted persisted cache). Goes back to false on
   * identify()/reset() until the new identity's flags land - subscribers
   * use it to keep serving "unloaded" instead of getter fallbacks while
   * the next set is still loading.
   */
  areFeatureFlagsLoaded(): boolean {
    return this.flagsLoaded;
  }

  /**
   * Subscribe to flag updates. `cb` fires whenever the served flag set
   * changes: after a successful reload, when a persisted cache is adopted,
   * and when identify()/reset() clears the outgoing identity's flags (with
   * an empty map) - plus immediately when flags are already loaded.
   * Returns an unsubscribe function.
   */
  onFeatureFlags(cb: (flags: Record<string, FlagResult>) => void): () => void {
    this.flagListeners.add(cb);
    if (this.flagsLoaded) {
      try {
        cb(this.flags);
      } catch (err) {
        this.log("onFeatureFlags listener threw", err);
      }
    }
    return () => {
      this.flagListeners.delete(cb);
    };
  }

  register(props: Record<string, unknown>): void {
    this.superProps = { ...this.superProps, ...props };
    this.storage.set(KEY_SUPER_PROPS, JSON.stringify(this.superProps));
  }

  unregister(key: string): void {
    if (!(key in this.superProps)) return;
    const next = { ...this.superProps };
    delete next[key];
    this.superProps = next;
    this.storage.set(KEY_SUPER_PROPS, JSON.stringify(this.superProps));
  }

  /**
   * Manually flush the queue. This always attempts a send, even while in
   * backoff (a manual flush is treated as an explicit "try now" request).
   * Auto-flush (timer) and size-triggered flushes go through the internal
   * backoff-aware path and are skipped until the backoff deadline passes.
   * Every flush first sends the queued exceptions (fatal first, in batches),
   * then one batch of the event queue; when an exception batch fails, the
   * event queue waits for the next flush.
   */
  async flush(transportOverride?: CohorlyTransport): Promise<void> {
    return this.doFlush(transportOverride, true);
  }

  /**
   * Send queued exceptions now through `transport`, without the event
   * queue, ignoring backoff and any flush already in flight. Meant for
   * page/app teardown, e.g. `flushExceptions(beaconTransport, { fatalOnly:
   * true })` on `pagehide`: a crash must not wait behind a pending fetch.
   * An exception also still in flight on another flush may be sent twice;
   * the server dedups it by `$insert_id`. Same retry contract as flush().
   */
  async flushExceptions(
    transport: CohorlyTransport,
    options: FlushExceptionsOptions = {},
  ): Promise<void> {
    await this.sendExceptions(transport, options.fatalOnly ?? false, true);
  }

  /** Backoff-aware flush used by the auto-flush timer and size triggers. */
  private maybeFlush(): void {
    this.doFlush(undefined, false).catch((err) =>
      this.log("auto-flush failed", err),
    );
  }

  private async doFlush(
    transportOverride: CohorlyTransport | undefined,
    force: boolean,
  ): Promise<void> {
    if (this.flushing || this.optedOut) return;
    if (this.queue.length === 0 && this.exceptionQueue.length === 0) return;
    if (!force && Date.now() < this.backoffUntil) return;
    this.flushing = true;
    try {
      const send = transportOverride ?? this.transport;
      const exceptionsSent = await this.sendExceptions(send, false, false);
      if (!exceptionsSent || this.queue.length === 0) return;
      const size = Math.max(1, this.effectiveBatchSize);
      const held = this.metricsHeld();
      const batch = (
        held ? this.queue.filter((evt) => evt.event !== METRIC_EVENT) : this.queue
      ).slice(0, size);
      if (batch.length === 0) return;
      const epoch = this.optOutEpoch;
      // By identity, not by count: an opt-out/opt-in while this send was on
      // the wire replaced the queue, and what was tracked since must stay.
      const removeBatch = () => {
        const sent = new Set(batch);
        this.queue = this.queue.filter((evt) => !sent.has(evt));
        this.persistQueue();
      };
      try {
        await send(`${this.apiHost}/track`, batch);
        removeBatch();
        if (epoch === this.optOutEpoch) this.onFlushSuccess();
      } catch (err) {
        if (epoch === this.optOutEpoch) this.handleFlushError(err, removeBatch);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Exceptions in send order: fatal first, stable inside each group. */
  private orderedExceptions(fatalOnly: boolean): TrackedEvent[] {
    const fatal = this.exceptionQueue.filter(isFatal);
    if (fatalOnly) return fatal;
    return [...fatal, ...this.exceptionQueue.filter((evt) => !isFatal(evt))];
  }

  /**
   * Sends queued exceptions in batches of the effective batch size, fatal
   * first. Returns false when a batch failed (the failure already went
   * through the retry contract). Exceptions in flight on another flush are
   * skipped unless `includeInFlight` (teardown sends must not wait on them).
   */
  private async sendExceptions(
    send: CohorlyTransport,
    fatalOnly: boolean,
    includeInFlight: boolean,
  ): Promise<boolean> {
    if (this.optedOut || !this.captureExceptionsEnabled) return true;
    const pending = () =>
      this.orderedExceptions(fatalOnly).filter(
        (evt) => includeInFlight || !this.exceptionsInFlight.has(evt),
      );
    let budget = pending().length;
    while (budget > 0) {
      const batch = pending().slice(0, Math.max(1, this.effectiveBatchSize));
      if (batch.length === 0) break;
      budget -= batch.length;
      const epoch = this.optOutEpoch;
      for (const evt of batch) this.exceptionsInFlight.add(evt);
      const removeBatch = () => {
        const sent = new Set(batch);
        this.exceptionQueue = this.exceptionQueue.filter((evt) => !sent.has(evt));
        this.persistExceptionQueue();
      };
      try {
        await send(`${this.apiHost}/track`, batch);
        removeBatch();
        if (epoch === this.optOutEpoch) this.onFlushSuccess();
        // Opted out during the send: the rest of the queue was discarded.
        if (this.optedOut) return true;
      } catch (err) {
        // Opted out during the send: the queue it belonged to is gone, so no
        // failure state (backoff, batch halving) is carried over.
        if (epoch !== this.optOutEpoch) return true;
        this.handleFlushError(err, removeBatch);
        return false;
      } finally {
        for (const evt of batch) this.exceptionsInFlight.delete(evt);
      }
    }
    return true;
  }

  private onFlushSuccess(): void {
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
  }

  /**
   * Applies the retry contract to a failed flush, for the event queue and
   * the exception queue alike (one shared backoff state). `dropBatch`
   * removes the just-attempted batch from its queue.
   *
   * - 400: payload permanently rejected - drop that batch, do not retry it.
   * - 413: payload too big - halve the effective batch size (floor 1), keep
   *   the queue, retry smaller next time (no backoff).
   * - 401: invalid token - keep queue, warn, backoff at max delay.
   * - 429 / 5xx / network: keep queue, exponential backoff (Retry-After, when
   *   present on a 429, overrides the computed delay, still capped).
   */
  private handleFlushError(err: unknown, dropBatch: () => void): void {
    const status = err instanceof TransportError ? err.status : undefined;

    if (status === 400) {
      this.log("dropping batch permanently rejected with 400", err);
      dropBatch();
      return;
    }

    if (status === 413) {
      this.effectiveBatchSize = Math.max(1, Math.floor(this.effectiveBatchSize / 2));
      this.log(
        "payload too large (413), halving batch size to",
        this.effectiveBatchSize,
      );
      // Keep queue intact; next flush retries with the smaller batch.
      return;
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
   * Trims the queue to `maxQueueSize`, dropping the OLDEST events on overflow.
   * Returns true if anything was dropped.
   */
  private enforceQueueCap(): boolean {
    if (this.queue.length <= this.maxQueueSize) return false;
    const overflow = this.queue.length - this.maxQueueSize;
    // Aggregated `$metric` events are the cheapest to lose (up to 200 per
    // window while offline): they go first, so they can never push product
    // events out of the queue.
    const drop = new Set<number>();
    for (let i = 0; i < this.queue.length && drop.size < overflow; i++) {
      if (this.queue[i].event === METRIC_EVENT) drop.add(i);
    }
    for (let i = 0; drop.size < overflow; i++) drop.add(i);
    this.queue = this.queue.filter((_, i) => !drop.has(i));
    this.log("queue cap exceeded, dropped events", overflow);
    return true;
  }

  /**
   * Trims the exception queue to `maxExceptionQueueSize`: the OLDEST
   * NON-FATAL exception goes first, the oldest fatal one only when every
   * queued exception is fatal. Returns true if anything was dropped.
   */
  private enforceExceptionQueueCap(): boolean {
    let dropped = 0;
    while (this.exceptionQueue.length > this.maxExceptionQueueSize) {
      // An exception being sent stays: if that send fails, it must still be
      // there to retry. Only when everything queued is in flight does it go.
      const idle = (evt: TrackedEvent) => !this.exceptionsInFlight.has(evt);
      const victim = [
        (evt: TrackedEvent) => idle(evt) && !isFatal(evt),
        idle,
        (evt: TrackedEvent) => !isFatal(evt),
      ]
        .map((match) => this.exceptionQueue.findIndex(match))
        .find((index) => index !== -1);
      this.exceptionQueue.splice(victim ?? 0, 1);
      dropped += 1;
    }
    if (dropped > 0) {
      this.log("exception queue cap exceeded, dropped exceptions", dropped);
    }
    return dropped > 0;
  }

  /** Base URL events are sent to, e.g. for building a sendBeacon URL. */
  getApiHost(): string {
    return this.apiHost;
  }

  /** Stop the auto-flush timer. Useful in tests / on app teardown. */
  stop(): void {
    this.metrics.flush();
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  private async sendEngage(op: Record<string, unknown>): Promise<void> {
    if (this.optedOut) return;
    try {
      await this.transport(`${this.apiHost}/engage`, {
        distinct_id: this.distinctId,
        ...op,
        ...(this.token !== undefined ? { token: this.token } : {}),
      });
    } catch (err) {
      this.log("engage request failed", err);
    }
  }

  private persistQueue(): void {
    this.storage.set(KEY_QUEUE, JSON.stringify(this.queue));
  }

  /**
   * Best effort: a full or throwing storage must never stop an exception
   * from being sent from memory.
   */
  private persistExceptionQueue(): void {
    try {
      this.storage.set(KEY_EXCEPTION_QUEUE, JSON.stringify(this.exceptionQueue));
    } catch (err) {
      this.log("could not persist the exception queue, keeping it in memory", err);
    }
  }

  private persistTimedEvents(): void {
    this.storage.set(KEY_TIMED_EVENTS, JSON.stringify(this.timedEvents));
  }

  private readJson<T>(key: string, fallback: T): T {
    const raw = this.storage.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.warn("[cohorly]", ...args);
  }
}

/** JSON round-trip copy; `undefined` when the value cannot be serialized. */
function cloneJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** An independent copy, so neither the buffer nor a captured event can mutate the other. */
function snapshotBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const copy: Breadcrumb = { ...crumb };
  if (crumb.data !== undefined) copy.data = cloneJson(crumb.data) as Record<string, unknown>;
  return copy;
}
