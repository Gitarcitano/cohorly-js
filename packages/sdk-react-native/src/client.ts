import type {
  BreadcrumbInput,
  CaptureExceptionOptions,
  ExceptionListEntry,
  TrackedEvent,
} from "@cohorly/core";
import {
  TransportError as CoreTransportError,
  ExceptionRateLimiter,
  METRIC_EVENT,
  MetricsAggregator,
} from "@cohorly/core";
import {
  deriveDeviceInfo,
  fetchNativeDeviceInfo,
  loadNativeModules,
  mergePlatformInfo,
  resolveAppState,
  watchWifi,
} from "./deviceInfo.js";
import { ExceptionEngine, type Identity } from "./exceptions/engine.js";
import { setupExceptionCapture, teardownExceptionCapture } from "./exceptions/handlers.js";
import {
  buildReactNativeExceptionList,
  buildReactNativeRejectionList,
} from "./exceptions/hermes-stack.js";
import { buildNativeCrashConfig, writeNativeCrashConfig } from "./exceptions/native-crashes.js";
import { readExpoUpdates, resolveRelease } from "./exceptions/release.js";
import { createReplay, type ReplayController } from "./replay/replay.js";
import { InMemoryStorage } from "./storage.js";
import type {
  AppStateLike,
  AsyncStorageLike,
  CohorlyOptions,
  EngagePayload,
  FlagDetails,
  FlagPersistenceMode,
  FlagResult,
  NativeCrashReportingOptions,
  PlatformInfo,
  Properties,
  TrackEvent,
} from "./types.js";
import { uuid } from "./uuid.js";
import { LIB_VERSION } from "./version.js";

const KEYS = {
  distinctId: "cohorly:distinct_id",
  deviceId: "cohorly:device_id",
  anonymous: "cohorly:anonymous",
  superProps: "cohorly:super_properties",
  queue: "cohorly:queue",
  engageQueue: "cohorly:engage_queue",
  aeFirstOpen: "cohorly:ae_first_open",
  aeLastVersion: "cohorly:ae_last_version",
  flags: "cohorly:flags",
  optOut: "cohorly:opt_out",
  nativeCrash: "cohorly:native_crash",
} as const;

/**
 * Persisted flag cache. Scoped by distinct id so a cache written for one user
 * is never served to another after an identify()/reset() on the same device,
 * and bounded by `stored_at` per the active `flagPersistence` policy (see
 * isFlagCacheUsable). Caches written by pre-TTL SDK versions carry no
 * `stored_at`; their age cannot be proven, so they are served rather than
 * expired - the graceful-upgrade path that preserves the pre-feature
 * behavior (the cache was served indefinitely).
 */
interface FlagsCache {
  distinct_id: string;
  flags: Record<string, FlagResult>;
  stored_at?: number;
}

const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_FLUSH_AT = 20;
const LIB_NAME = "react-native";
/** Cohorly's hosted ingestion API. Used when no apiHost is supplied. */
const DEFAULT_API_HOST = "https://cohorly-service.velloalabs.com";

const DEFAULT_MAX_QUEUE_SIZE = 1000;
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

/** Minimum foreground duration (seconds) before an `$ae_session` event fires. */
const MIN_SESSION_LENGTH_SEC = 10;

/**
 * Error thrown by `send()` on a non-OK HTTP response, carrying the HTTP status
 * and (when the server sent one) the parsed `Retry-After` in ms. Copied here
 * to keep this package standalone (see repo CLAUDE.md "Ownership" convention).
 * Network failures reject with the underlying fetch error, not a TransportError.
 */
export class TransportError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, retryAfterMs?: number) {
    super(`Cohorly: request failed with status ${status}`);
    this.name = "TransportError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/** Subscribes a single `change` listener on the given AppState-like object.
 * Guarded so a missing/broken AppState never throws. */
function watchAppState(appState: AppStateLike | undefined, onChange: (state: string) => void): void {
  try {
    appState?.addEventListener?.("change", onChange);
  } catch {
    // Broken/incompatible AppState implementation - no-op, fully optional.
  }
}

export class CohorlyClient {
  private apiHost: string;
  private storage: AsyncStorageLike;
  private fetchImpl: typeof fetch;
  private flushInterval: number;
  private flushAt: number;
  private disabled: boolean;
  private token: string | undefined;
  private maxQueueSize: number;
  private maxRetryDelayMs: number;
  private appVersion: string | undefined;
  private appBuild: string | undefined;
  private trackAutomaticEvents: boolean;
  private platformInfo: PlatformInfo;
  private wifi: boolean | undefined;
  private appStateModule: AppStateLike | undefined;
  /** Prefix of the default release; see resolveRelease(). */
  private bundleId: string | undefined;
  /** Exception queue, breadcrumbs and capture (see exceptions/engine.ts). */
  private readonly exceptions: ExceptionEngine;
  /** At most 10 exceptions per local fingerprint per minute, like the web SDK; per client, so init() starts it afresh. */
  private readonly exceptionRateLimiter = new ExceptionRateLimiter();
  /** Undoes the global handlers installed by `captureExceptions`. */
  private teardownCapture: (() => void) | undefined;
  /** `captureExceptions !== false`; see isExceptionCaptureEnabled(). */
  private readonly captureExceptionsEnabled: boolean;
  /** Persisted opt-out flag; see optOutTracking(). */
  private optedOut = false;
  /** optOutTracking()/optInTracking() ran, so hydrate() must not restore the stored flag over it. */
  private optOutTouched = false;
  /**
   * Bumped by optOutTracking(). A flush or engage send captures it before it
   * goes on the wire; if it changed when the send fails, the batch belongs to
   * a queue that was discarded and is NOT put back.
   */
  private optOutEpoch = 0;
  /** The persisted opt-out flag was read (end of the hydration reads). */
  private optOutResolved = false;
  private readonly captureListeners = new Set<(enabled: boolean) => void>();
  /** Last value passed to the listeners; false until hydration resolves. */
  private lastCaptureEnabled = false;

  private distinctId: string;
  /**
   * Stable per-device id stamped as `$device_id` on every event (Mixpanel
   * parity). Persisted separately from the distinct id so it survives
   * identify(); reset() mints a new one. On a fresh (anonymous) install it
   * equals the anon distinct id; an older identified install migrating in
   * mints a fresh uuid.
   */
  private deviceId: string;
  /** True until identify() is called (or after reset()). Drives `$user_id`
   * stamping - the reserved `$user_id` is only attached once identified. */
  private anonymous = true;
  private superProps: Properties = {};
  private queue: TrackEvent[] = [];
  private engageQueue: EngagePayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** In-memory start timestamps (ms) for timed events, keyed by event name.
   * The next `track()` of the same name attaches `$duration` (seconds) and
   * clears the entry. Not persisted - mirrors Mixpanel's `time_event`. */
  private timedEvents = new Map<string, number>();

  /** Consecutive flush failures, drives exponential backoff. Reset on success. */
  private consecutiveFailures = 0;
  /** Timestamp (ms) before which non-forced flushes are skipped. */
  private backoffUntil = 0;
  /** Current effective per-flush batch size; halved on 413 (floor 1). */
  private effectiveBatchSize: number;

  /** Last-seen AppState status, used to detect active<->background edges. */
  private appStateStatus = "active";
  /** Timestamp (ms) the app most recently became active/foregrounded. */
  private sessionStartedAt = Date.now();

  /** Flag persistence policy; see CohorlyOptions.flagPersistence. */
  private readonly flagPersistence: FlagPersistenceMode;
  /** TTL (ms) applied to the persisted flag cache. */
  private readonly flagCacheTtlMs: number;
  /** Last known flag results for the current distinct id (memory copy of the
   * persisted cache). */
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
  /**
   * The distinct id the in-memory flags were evaluated for: `requestedId`
   * on a successful reload, `cache.distinct_id` on a persisted adoption.
   * hydrate() compares it against the resolved identity so flags evaluated
   * for the transient constructor id are never served to the real user.
   */
  private flagsIdentity: string | undefined;
  /** Monotonic request counter, guards against a stale reload overwriting a
   * newer one that resolved first. */
  private flagRequestSeq = 0;
  /** Flag evaluations on the wire; while one runs and no flags are loaded, `$metric` events wait in the queue. */
  private flagLoadsInFlight = 0;
  /** stop() ran: this client must not touch the persisted queue from late callbacks. */
  private stopped = false;
  /** Bumped by identify() and reset(); a deferred `$metric` replay uses it to notice an identity change. */
  private identityEpoch = 0;
  /** The evaluation scheduled by the constructor has not finished yet (only when `loadFeatureFlags` is not false). */
  private initialFlagsPending = false;
  private readonly flagListeners = new Set<
    (flags: Record<string, FlagResult>) => void
  >();
  /** Whether flag reads emit `$feature_flag_called` exposure events. */
  private readonly sendExposureEvents: boolean;
  /** Exposures already tracked this identity session, keyed
   * `${key}:${String(value)}`. In memory only, cleared on identify()/reset(). */
  private readonly exposedFlags = new Set<string>();

  /** Resolves once persisted state (distinct id, super props, queued events)
   * has been loaded from storage. Tests can await this for determinism. */
  readonly ready: Promise<void>;
  /** Custom metrics: `count`, `gauge`, `distribution`, aggregated into `$metric` events. */
  readonly metrics: MetricsAggregator;
  /** Resolves once the exception engine exists (after `ready`): captures
   * made before it are replayed into it, and persisted exceptions from a
   * previous launch have started sending. Tests can await this. */
  readonly exceptionsReady: Promise<void>;
  /** True once hydrate() has loaded the persisted distinct_id/queues. */
  private hydrated = false;
  /**
   * Identity switch performed while hydrate() was still reading storage:
   * the snapshot it resolves with is then already stale. Set by
   * identify()/reset(); an identify() never overwrites an earlier "reset".
   * hydrate() consults it to skip restoring values the switch already
   * replaced (identity for both; device id, super props and queues for
   * reset(), which cleared and persisted them itself).
   */
  private preReadyIdentityOp: "identify" | "reset" | null = null;
  /** The constructor's distinct id: the anonymous id of a fresh install until hydrate() persists it. */
  private readonly transientId: string;
  /**
   * Identity of each epoch an identify()/reset() opened before hydrate()
   * finished, for exceptions captured in it (see identityAtCapture()).
   * `deviceId` undefined: the device of the epoch before (identify keeps it).
   */
  private readonly preReadyEpochs = new Map<
    number,
    { distinctId: string; anonymous: boolean; deviceId?: string }
  >();
  /** Identity of epoch 0 (before any identify()/reset()), resolved by hydrate() from storage. */
  private epochZero: Identity | undefined;
  /**
   * /alias source deferred by a pre-ready identify(): the outgoing distinct
   * id captured at call time may still be the transient constructor uuid,
   * so hydrate() swaps in the persisted anonymous predecessor when the
   * stored snapshot resolves with one.
   */
  private pendingAliasFrom: string | undefined;
  /** `CohorlyReactNative` native module, for `configureNativeCrashes`. */
  // biome-ignore lint/suspicious/noExplicitAny: untyped native bridge module.
  private nativeModule: any;
  /**
   * The native crash choice comes from three layers, first defined wins:
   * setNativeCrashReporting() in this launch, the init options, then the
   * last setNativeCrashReporting() of an earlier launch (persisted under
   * KEYS.nativeCrash, loaded once `ready` resolved). The persisted layer
   * keeps a launch that dies before its feature flags arrive from writing
   * the init default over the choice the previous launch made.
   */
  private readonly nativeCrashInit: NativeCrashReportingOptions;
  private nativeCrashSet: NativeCrashReportingOptions = {};
  /** Undefined until read from storage. */
  private nativeCrashStored: NativeCrashReportingOptions | undefined;
  /** Release/dist for the native crash config, known once `ready` resolved. */
  private nativeCrashRelease: { release?: string; dist?: string } | undefined;
  /**
   * The one release/dist this client runs (resolveRelease() + options.dist ??
   * downloaded update id), computed once after `ready`. Stamped as
   * `$release`/`$release_dist` on every event and handed to the exception
   * engine and the native crash config, so the shared release key and
   * `$exception_release` can never disagree. Undefined before `ready`: events
   * go out without the key rather than with a guess.
   */
  private releaseDefaults: { release?: string; dist?: string } | undefined;
  /**
   * Session replay (`sessionReplay`), null when it is off: no option, both
   * rates 0, or no native recorder. Owns `$session_id`.
   */
  private readonly replay: ReplayController | null;
  /**
   * Resolves once the stored replay session was read and the events queued
   * before it re-stamped with the session it resolved to; null without
   * replay. A flush waits for it, so no event leaves with the provisional
   * `$session_id`.
   */
  private readonly replayLoaded: Promise<void> | null;
  /** The provisional replay session id and the stored one adopted in its place. */
  private adoptedSession: { from: string; to: string } | null = null;

  constructor(options: CohorlyOptions) {
    // Before reading globalThis.fetch: a previous client's fetch wrapper
    // must not become this client's transport.
    if (options.captureExceptions) teardownExceptionCapture();
    this.apiHost = (options.apiHost ?? DEFAULT_API_HOST).replace(/\/$/, "");
    this.storage = options.storage ?? new InMemoryStorage();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.flushAt = options.flushAt ?? DEFAULT_FLUSH_AT;
    this.disabled = options.disabled ?? false;
    this.captureExceptionsEnabled = options.captureExceptions !== false;
    this.token = options.token;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.trackAutomaticEvents = options.trackAutomaticEvents ?? false;
    this.sendExposureEvents = options.sendExposureEvents ?? true;
    this.flagPersistence =
      options.flagPersistence ?? "persistenceUntilNetworkSuccess";
    this.flagCacheTtlMs = normalizeFlagCacheTtlMs(options.flagCacheTtlMs);
    this.effectiveBatchSize = this.flushAt;
    this.distinctId = uuid();
    this.transientId = this.distinctId;
    // Transient until hydrate() resolves the persisted/derived value.
    this.deviceId = this.distinctId;

    const mods = loadNativeModules();
    try {
      this.nativeModule = mods.rn?.NativeModules?.CohorlyReactNative;
    } catch {
      this.nativeModule = undefined;
    }
    this.nativeCrashInit = {
      nativeCrashReporting: options.nativeCrashReporting,
      metricKitDiagnostics: options.metricKitDiagnostics,
    };
    // The native config follows isExceptionCaptureEnabled(): re-sent on
    // every change (hydration turning it on, optOutTracking/optInTracking).
    this.captureListeners.add(() => this.syncNativeCrashConfig());
    const derived = deriveDeviceInfo(mods);
    this.appVersion = options.appVersion ?? derived.appVersion;
    this.appBuild = options.appBuild ?? derived.appBuild;
    this.bundleId = derived.bundleId;
    this.platformInfo = mergePlatformInfo(derived.platformInfo, options.platformInfo);
    this.wifi = this.platformInfo.wifi;
    if (this.wifi === undefined) {
      watchWifi(mods.netInfo, (w) => {
        this.wifi = w;
      });
    }
    this.appStateModule = resolveAppState(options.appState, mods.rn);

    // Read only when `sessionReplay` asks for it: without it the native
    // replay module is never touched and no event carries `$session_id`.
    this.replay = createReplay(
      options.sessionReplay,
      mods.rn,
      {
        apiHost: this.apiHost,
        token: this.token,
        storage: this.storage,
        fetch: () => this.fetchImpl,
        maxRetryDelayMs: this.maxRetryDelayMs,
        distinctId: () => this.distinctId,
        onRotate: () => this.syncNativeCrashConfig(),
      },
      this.currentAppState(),
    );
    // The persisted replay session is part of `ready`: the crash config and
    // exceptions replayed after it carry the session it resolves to. Events
    // tracked before it was read carry the provisional id: they belong to
    // the session it resolved to.
    this.replayLoaded = this.replay
      ? this.replay
          .load()
          .catch(() => null)
          .then((adopted) => {
            this.adoptedSession = adopted;
            if (adopted) this.restampSession(adopted.from, adopted.to);
          })
      : null;

    // Highest-precedence auto-derived tier: this package's own autolinked
    // native module (when the host app has rebuilt with it linked). Resolves
    // async, so it's folded into `ready` - explicit options still win over it,
    // and it wins over the react-native-device-info/expo sync tiers above.
    const nativeReady = fetchNativeDeviceInfo(mods.rn).then((native) => {
      this.appVersion = options.appVersion ?? native.appVersion ?? derived.appVersion;
      this.appBuild = options.appBuild ?? native.appBuild ?? derived.appBuild;
      this.bundleId = derived.bundleId ?? native.bundleId;
      const withNative = mergePlatformInfo(derived.platformInfo, native.platformInfo);
      this.platformInfo = mergePlatformInfo(withNative, options.platformInfo);
      if (this.platformInfo.wifi !== undefined) this.wifi = this.platformInfo.wifi;
    });

    // Feature flags: the first evaluation is deferred until hydration has
    // resolved the persisted distinct id, so it is never evaluated for the
    // transient constructor uuid. Fire and forget - reloadFeatureFlags()
    // never rejects. `ready` deliberately does NOT await it: callers must be
    // able to track immediately, offline, without waiting on a flags request.
    const loadFlags = options.loadFeatureFlags !== false;
    this.initialFlagsPending = loadFlags;
    const expoUpdates = readExpoUpdates(mods.expoUpdates);
    this.ready = Promise.all([this.hydrate(), nativeReady, this.replayLoaded]).then(() => {
      // The release is fixed here, before `ready` resolves, so every event
      // tracked after `await ready` carries it.
      this.resolveReleaseDefaults(options, expoUpdates.dist);
      // Recording starts once the persisted opt-out is known; `disabled`
      // (no network) never records.
      if (this.replay && !this.stopped && !this.optedOut && !this.disabled) this.replay.start();
      if (loadFlags) {
        void this.reloadFeatureFlags().finally(() => {
          this.initialFlagsPending = false;
        });
      }
    });
    // A failed hydration never schedules the evaluation: nothing to wait for.
    this.ready.catch(() => {
      this.initialFlagsPending = false;
    });

    this.metrics = new MetricsAggregator(
      {
        trackAt: (event, props, time) => this.trackAt(event, props, time),
        onFeatureFlags: (cb) => this.onFeatureFlags(cb),
        areFeatureFlagsLoaded: () => this.areFeatureFlagsLoaded(),
        onDisabled: () => this.dropQueuedMetrics(),
        log: () => {},
      },
      options.metrics,
    );

    this.exceptions = new ExceptionEngine({
      apiHost: this.apiHost,
      token: this.token,
      lib: LIB_NAME,
      storage: this.storage,
      send: (path, body) => this.send(path, body),
      toCoreError: (err) =>
        err instanceof TransportError ? new CoreTransportError(err.status, err.retryAfterMs) : err,
      isDisabled: () => this.disabled,
      identity: () => this.currentIdentity(),
      identityAtCapture: () => this.identityAtCapture(),
      eventProperties: (sessionId) => ({
        ...(sessionId !== undefined ? { $session_id: sessionId } : {}),
        ...this.getDeviceDefaultProperties(),
        ...this.superProps,
      }),
      sessionAtCapture: () => this.sessionAtCapture(),
      onCaptured: (event) => this.onExceptionRecorded(event),
    });
    // release/dist are construction options of the engine, so it is built
    // once the version from the native module is known.
    this.exceptionsReady = this.ready
      .catch(() => {})
      .then(() =>
        this.exceptions.start({
          ...this.resolveReleaseDefaults(options, expoUpdates.dist),
          appVersion: this.appVersion,
          beforeSendException: options.beforeSendException,
          maxExceptionQueueSize: options.maxExceptionQueueSize,
          captureExceptions: this.captureExceptionsEnabled,
          properties: expoUpdates.properties,
        }),
      );
    // Native crash config for the next launch, once identity and release are known.
    void this.ready
      .catch(() => {})
      .then(async () => {
        this.nativeCrashStored = await this.loadNativeCrashChoice();
        // A setter call made before the stored choice was read is persisted now.
        if (Object.keys(this.nativeCrashSet).length > 0) this.persistNativeCrashChoice();
        this.nativeCrashRelease = { ...this.resolveReleaseDefaults(options, expoUpdates.dist) };
        this.syncNativeCrashConfig();
      });
    if (options.captureExceptions) {
      this.teardownCapture = setupExceptionCapture({
        apiHost: this.apiHost,
        appState: this.appStateModule,
        addBreadcrumb: (crumb) => this.addBreadcrumb(crumb),
        onUnhandledRejection: (reason) =>
          this.captureList(() => buildReactNativeRejectionList(reason, this.platformInfo.os), {
            level: "error",
          }),
        onGlobalError: async (error, isFatal) => {
          this.captureException(error, {
            level: isFatal ? "fatal" : "error",
            mechanism: { type: "onerror", handled: false },
          });
          await this.exceptions.started;
          // The persisted copy is the guarantee; this send is a bonus that
          // may not finish before the app dies (the server dedups retries).
          if (isFatal) this.exceptions.flushFatal();
          await this.exceptions.storage.persisted();
        },
      });
    }

    this.startTimer();
    watchAppState(this.appStateModule, (state) => this.handleAppStateChange(state));
  }

  /**
   * Queues a `$exception` event for anything thrown: the error and its
   * `cause` chain with frames parsed from the Hermes/JSC stack, the current
   * breadcrumbs, the release, and the same default and super properties as
   * track(). Before the client is ready it is held in memory and queued
   * once it is. Never throws.
   */
  captureException(error: unknown, options: CaptureExceptionOptions = {}): void {
    this.captureList(
      () =>
        buildReactNativeExceptionList(
          error,
          {
            handled: options.mechanism?.handled ?? true,
            type: options.mechanism?.type ?? "generic",
          },
          this.platformInfo.os,
        ),
      options,
    );
  }

  /** The single path of every exception: opt-out, the local rate limit, then the engine. */
  private captureList(
    build: () => ExceptionListEntry[],
    options: CaptureExceptionOptions,
  ): void {
    try {
      // Not isExceptionCaptureEnabled(): that is false until hydration, and a
      // capture made before it must still be held (the engine drops it if the
      // persisted flag then says opted out).
      if (this.optedOut || !this.captureExceptionsEnabled) return;
      const list = build();
      // A render loop or a timer throwing every frame must not fill the queue.
      if (!this.exceptionRateLimiter.allow(list)) return;
      // The engine reports it back once it is recorded (onExceptionRecorded).
      this.exceptions.capture(list, options);
    } catch {
      // Capturing must never become a second error.
    }
  }

  /**
   * The replay session of an exception captured now, resolved when the
   * engine records it: the id of this moment, or the stored session adopted
   * in place of the provisional one, never a session started since.
   */
  private sessionAtCapture(): () => string | undefined {
    const id = this.replay?.sessionId();
    return () => {
      const adopted = this.adoptedSession;
      return id !== undefined && adopted?.from === id ? adopted.to : id;
    };
  }

  /**
   * An exception was recorded (it passed `beforeSendException`): the error
   * buffer of the session its final properties carry goes out, a fatal one
   * at once (the app is about to die), never awaited.
   */
  private onExceptionRecorded(event: TrackedEvent): void {
    if (!this.replay) return;
    const props = event.properties as Record<string, unknown>;
    const sessionId = typeof props.$session_id === "string" ? props.$session_id : undefined;
    const time = typeof props.time === "number" ? props.time : Date.now();
    this.replay.onException(sessionId, props.$exception_level === "fatal", time);
  }

  /** `$session_id` from session replay, unless the event already has one (the caller's wins, as on the web). */
  private stampSession(event: string, props: Properties): void {
    if (!this.replay) return;
    const sessionId = this.replay.eventProperties(event).$session_id;
    if (props.$session_id === undefined && sessionId !== undefined) props.$session_id = sessionId;
  }

  /** Queued events stamped with the provisional replay session move to the one adopted from storage. */
  private restampSession(from: string, to: string): void {
    let changed = false;
    for (const evt of this.queue) {
      if (evt.properties.$session_id === from) {
        evt.properties.$session_id = to;
        changed = true;
      }
    }
    if (changed && !this.stopped) this.persistQueue();
  }

  /** AppState's state at construction, when it has one. */
  private currentAppState(): string | undefined {
    try {
      const state = this.appStateModule?.currentState;
      return typeof state === "string" ? state : undefined;
    } catch {
      return undefined;
    }
  }

  private currentIdentity(): Identity {
    return {
      distinctId: this.distinctId,
      deviceId: this.deviceId,
      ...(this.anonymous ? {} : { userId: this.distinctId }),
    };
  }

  /**
   * The identity an exception captured now belongs to, resolved when the
   * engine replays it. Before hydration the current fields are not the
   * persisted identity yet, so the capture keeps its identity epoch instead:
   * an identify() made during the hydration must not claim an error captured
   * before it.
   */
  private identityAtCapture(): () => Identity {
    if (this.hydrated) {
      const identity = this.currentIdentity();
      return () => identity;
    }
    const epoch = this.identityEpoch;
    return () => this.identityOfEpoch(epoch);
  }

  private identityOfEpoch(epoch: number): Identity {
    const zero = this.epochZero;
    // The hydration failed: nothing better than the identity in memory.
    if (!zero) return this.currentIdentity();
    if (epoch === 0) return zero;
    const record = this.preReadyEpochs.get(epoch);
    if (!record) return this.currentIdentity();
    let deviceId: string | undefined;
    for (let e = epoch; e > 0 && deviceId === undefined; e--) {
      deviceId = this.preReadyEpochs.get(e)?.deviceId;
    }
    return {
      distinctId: record.distinctId,
      deviceId: deviceId ?? zero.deviceId,
      ...(record.anonymous ? {} : { userId: record.distinctId }),
    };
  }

  /** Records a breadcrumb; the last 50 travel with every exception. Never throws. */
  addBreadcrumb(crumb: BreadcrumbInput): void {
    try {
      if (this.optedOut) return;
      this.exceptions.addBreadcrumb(crumb);
    } catch {
      // Same contract as captureException().
    }
  }

  /** Memoized: the first caller after `ready` fixes the release for the
   * client's lifetime (see `releaseDefaults`). */
  private resolveReleaseDefaults(
    options: Pick<CohorlyOptions, "release" | "dist">,
    updateDist: string | undefined,
  ): { release?: string; dist?: string } {
    if (!this.releaseDefaults) {
      this.releaseDefaults = {
        release: resolveRelease({
          explicit: options.release,
          bundleId: this.bundleId,
          version: this.appVersion,
          build: this.appBuild,
          os: this.platformInfo.os,
        }),
        dist: options.dist ?? updateDist,
      };
    }
    return this.releaseDefaults;
  }

  /** Merges device/app default properties into every tracked event, on top
   * of super props and below explicit per-call properties (see `track()`). */
  private getDeviceDefaultProperties(): Properties {
    const props: Properties = { $lib_version: LIB_VERSION };
    const p = this.platformInfo;
    if (p.os !== undefined) props.$os = p.os;
    if (p.osVersion !== undefined) props.$os_version = p.osVersion;
    if (p.screenHeight !== undefined) props.$screen_height = p.screenHeight;
    if (p.screenWidth !== undefined) props.$screen_width = p.screenWidth;
    if (p.model !== undefined) props.$model = p.model;
    if (p.manufacturer !== undefined) props.$manufacturer = p.manufacturer;
    if (p.brand !== undefined) props.$brand = p.brand;
    if (p.carrier !== undefined) props.$carrier = p.carrier;
    if (this.wifi !== undefined) props.$wifi = this.wifi;
    if (this.appVersion !== undefined) props.$app_version_string = this.appVersion;
    if (this.appBuild !== undefined) props.$app_build_number = this.appBuild;
    // Shared release key (ADR-0019 Limits, amendment 2026-11-14): absent
    // until `ready`, `$release_dist` absent for the embedded bundle.
    const rel = this.releaseDefaults;
    if (rel?.release !== undefined) props.$release = rel.release;
    if (rel?.dist !== undefined) props.$release_dist = rel.dist;
    return props;
  }

  /** Default profile properties merged into every `people.set`/`people.setOnce`
   * call (Mixpanel Native Mode parity). Platform-scoped by `Platform.OS`: the
   * `$android_*` set on Android, the `$ios_*` set on iOS. User-supplied keys
   * always win (never overridden). Keys whose source value can't be derived in
   * the current environment are simply omitted. */
  private getProfileDefaultProperties(): Properties {
    const p = this.platformInfo;
    const props: Properties = {};
    if (p.os === "Android") {
      props.$android_lib_version = LIB_VERSION;
      props.$android_os = "Android";
      if (p.osVersion !== undefined) props.$android_os_version = String(p.osVersion);
      if (this.appVersion !== undefined) props.$android_app_version = this.appVersion;
      if (p.model !== undefined) props.$android_model = p.model;
      if (p.manufacturer !== undefined) props.$android_manufacturer = p.manufacturer;
      if (p.brand !== undefined) props.$android_brand = p.brand;
    } else if (p.os === "iOS") {
      props.$ios_lib_version = LIB_VERSION;
      if (p.osVersion !== undefined) props.$ios_version = String(p.osVersion);
      if (this.appVersion !== undefined) props.$ios_app_release = this.appVersion;
      if (this.appBuild !== undefined) props.$ios_app_version = this.appBuild;
      if (p.model !== undefined) props.$ios_device_model = p.model;
    }
    return props;
  }

  /** Single AppState "change" handler: keeps the existing flush-on-background
   * behavior and, when `trackAutomaticEvents` is on, tracks `$ae_session` on
   * the active -> background/inactive edge. Never adds a second listener. */
  private handleAppStateChange(state: string): void {
    const wasActive = this.appStateStatus === "active";
    const isBackground = state === "background" || state === "inactive";

    if (isBackground) {
      // Queue the session event (if any) before flushing, so a single
      // background-triggered flush delivers it in the same batch. If storage
      // hydration is still pending (cold-launch background), defer so the
      // persisted distinct_id, not the transient constructor uuid, is attached.
      const shouldTrack = this.trackAutomaticEvents && wasActive;
      const lengthSec = shouldTrack
        ? Math.round((Date.now() - this.sessionStartedAt) / 1000)
        : 0;
      const finish = () => {
        if (shouldTrack && lengthSec >= MIN_SESSION_LENGTH_SEC) {
          this.track("$ae_session", { $ae_session_length: lengthSec });
          this.people.increment({
            $ae_total_app_sessions: 1,
            $ae_total_app_session_length: lengthSec,
          });
        }
        this.metrics.flush();
        this.maybeFlush();
      };
      if (this.hydrated) finish();
      else void this.ready.then(finish);
    } else if (state === "active" && !wasActive) {
      this.sessionStartedAt = Date.now();
    }

    this.replay?.onAppState(state);
    this.appStateStatus = state;
  }

  /** Fires `$ae_first_open` (once ever) and `$ae_updated` (on appVersion
   * change) when `trackAutomaticEvents` is enabled. Called once storage is
   * hydrated so the persisted flags/last-seen version are available. */
  private async trackAutomaticLifecycleEvents(): Promise<void> {
    if (!this.trackAutomaticEvents) return;

    const firstOpenFlag = await this.storage.getItem(KEYS.aeFirstOpen);
    if (!firstOpenFlag) {
      await this.storage.setItem(KEYS.aeFirstOpen, "1");
      this.track("$ae_first_open");
      this.people.setOnce({ $ae_first_app_open_date: new Date().toISOString() });
    }

    if (this.appVersion !== undefined) {
      const lastVersion = await this.storage.getItem(KEYS.aeLastVersion);
      if (lastVersion !== null && lastVersion !== this.appVersion) {
        this.track("$ae_updated", { $ae_updated_version: this.appVersion });
      }
      if (lastVersion !== this.appVersion) {
        await this.storage.setItem(KEYS.aeLastVersion, this.appVersion);
      }
    }
  }

  private async hydrate(): Promise<void> {
    const epochAtRead = this.optOutEpoch;
    const [
      storedId,
      storedAnon,
      storedDevice,
      storedSuper,
      storedQueue,
      storedEngageQueue,
      storedFlags,
      storedOptOut,
    ] = await Promise.all([
      this.storage.getItem(KEYS.distinctId),
      this.storage.getItem(KEYS.anonymous),
      this.storage.getItem(KEYS.deviceId),
      this.storage.getItem(KEYS.superProps),
      this.storage.getItem(KEYS.queue),
      this.storage.getItem(KEYS.engageQueue),
      this.storage.getItem(KEYS.flags),
      this.storage.getItem(KEYS.optOut),
    ]);

    // The identity before any identify()/reset(), for exceptions captured
    // before hydration in that epoch. A fresh install keeps the constructor's
    // anonymous id, and so does its device id even when an identify() came
    // first (identify() keeps the device).
    const epochZeroId = storedId || this.transientId;
    const epochZeroAnonymous = storedId ? storedAnon !== "0" : true;
    const resolvedDevice =
      storedDevice || (epochZeroAnonymous ? epochZeroId : uuid());
    this.epochZero = {
      distinctId: epochZeroId,
      deviceId: resolvedDevice,
      ...(epochZeroAnonymous ? {} : { userId: epochZeroId }),
    };

    // Opt-out first, before any decision to send (deferred alias, flush,
    // flags). A call made while the reads above were in flight wins.
    if (!this.optOutTouched) this.optedOut = storedOptOut === "1";
    this.optOutResolved = true;
    if (this.optedOut) this.exceptions.setOptedOut(true);
    this.emitCaptureChange();

    // An identity switch that ran while the reads above were in flight wins
    // over this snapshot: identify()/reset() already applied and persisted
    // the new identity, so restoring stored identity values here would
    // silently undo it. A pre-ready reset() additionally cleared and
    // persisted the device id, super props and queues - its snapshot values
    // are stale deletions that would resurrect cleared data, so they are
    // not restored either.
    const identityOp = this.preReadyIdentityOp;
    if (!identityOp) {
      if (storedId) {
        this.distinctId = storedId;
        // Installs predating the anonymous flag have no stored value; treat
        // them as anonymous rather than stamping a possibly-false $user_id.
        // Identified users self-heal on their next identify() call.
        this.anonymous = storedAnon !== "0";
      } else {
        this.anonymous = true;
        await this.storage.setItem(KEYS.distinctId, this.distinctId);
        await this.storage.setItem(KEYS.anonymous, "1");
      }
    }

    // A pre-ready identify() deferred its /alias because the outgoing id at
    // call time was the transient constructor uuid. Resolve the real
    // predecessor now: under a plain identify() the persisted anonymous id
    // is the true alias source (an already-identified predecessor gets no
    // alias, matching identify()'s contract); under a pre-ready reset() the
    // stored snapshot is irrelevant - reset() already discarded it - so the
    // fresh anonymous id captured by identify() is the source. A stored id
    // equal to the new one needs no link.
    if (this.pendingAliasFrom !== undefined) {
      const pending = this.pendingAliasFrom;
      this.pendingAliasFrom = undefined;
      const aliasFrom =
        identityOp === "identify" &&
        storedId !== null &&
        storedId !== this.distinctId
          ? storedAnon !== "0"
            ? storedId
            : null
          : pending;
      if (aliasFrom !== null && !this.disabled && !this.optedOut) {
        this.sendIdentifyAlias(aliasFrom, this.distinctId);
      }
    }

    if (identityOp !== "reset") {
      // Device id: persisted separately so it survives identify(). A fresh
      // or migrating anonymous install reuses the anon distinct id
      // (Mixpanel's `$device:<uuid>` convention); an identified install
      // (anonymous flag "0") mints a fresh one. Resolved from the stored
      // snapshot above, not from the current identity: a pre-ready
      // identify() keeps the device of the identity it replaced.
      this.deviceId = resolvedDevice;
      if (!storedDevice) await this.storage.setItem(KEYS.deviceId, this.deviceId);
      if (storedSuper) {
        try {
          this.superProps = JSON.parse(storedSuper);
        } catch {
          this.superProps = {};
        }
      }
      // An opt-out while the reads were in flight discarded these queues:
      // the snapshot is stale even if an opt-in followed.
      const discarded = this.optOutEpoch !== epochAtRead;
      if (storedQueue && !discarded) {
        let stored: TrackEvent[] = [];
        try {
          const parsed: unknown = JSON.parse(storedQueue);
          if (Array.isArray(parsed)) stored = parsed as TrackEvent[];
        } catch {
          stored = [];
        }
        // Events tracked while the reads were in flight stay, after the
        // stored ones (older); one that is already stored is not doubled.
        const early = this.queue;
        const storedIds = new Set(stored.map((evt) => evt?.properties?.$insert_id));
        this.queue = [...stored, ...early.filter((evt) => !storedIds.has(evt.properties.$insert_id))];
        // Enforce the persisted cap on load in case a larger queue was stored.
        const trimmed = this.enforceQueueCap();
        if (trimmed || early.length > 0) this.persistQueue();
      }
      if (storedEngageQueue && !discarded) {
        let stored: EngagePayload[] = [];
        try {
          const parsed: unknown = JSON.parse(storedEngageQueue);
          if (Array.isArray(parsed)) stored = parsed as EngagePayload[];
        } catch {
          stored = [];
        }
        const early = this.engageQueue;
        this.engageQueue = [...stored, ...early];
        if (early.length > 0) this.persistEngageQueue();
      }
    }

    // Opted out (flag applied above): whatever a crash left in the queues
    // was just restored from storage and must not ship.
    if (this.optedOut) this.discardPendingData();

    // Flags evaluated for an identity other than the one resolved above
    // (e.g. a reload that completed against the transient constructor id
    // before the persisted distinct id was read) belong to that identity:
    // drop them rather than serve them.
    if (
      this.flagsIdentity !== undefined &&
      this.flagsIdentity !== this.distinctId
    ) {
      this.clearFlagState();
    }

    // Flags are per-identity and bounded per the active policy: only adopt
    // the persisted cache when it belongs to the distinct id resolved above
    // and is servable under `flagPersistence` (see isFlagCacheUsable), else
    // drop it. `networkOnly` never reads nor writes the persisted cache, so
    // a stored entry is left untouched under it. A network result that
    // already landed this session (a reload kicked off before hydration
    // finished) always wins over the persisted snapshot - adopting here
    // would overwrite fresh network flags and misreport them as
    // persistence-sourced. After a pre-ready identity switch the snapshot
    // is the outgoing identity's cache anyway, and the new identity already
    // has its own reload in flight.
    if (
      !identityOp &&
      this.flagPersistence !== "networkOnly" &&
      this.flagsSource !== "network"
    ) {
      let cache: FlagsCache | null = null;
      if (storedFlags) {
        try {
          cache = JSON.parse(storedFlags) as FlagsCache;
        } catch {
          cache = null;
        }
      }
      const usable =
        cache !== null &&
        cache.distinct_id === this.distinctId &&
        this.isFlagCacheUsable(cache);
      if (storedFlags && !usable) {
        void this.storage.removeItem(KEYS.flags);
      }
      if (usable && cache) {
        this.flags = cache.flags ?? {};
        this.flagsLoaded = true;
        this.flagsSource = "persistence";
        // Undefined for a legacy cache without `stored_at`: persistedAt
        // stays absent on FlagDetails and the exposure, while ttlMs is
        // still reported.
        this.flagsPersistedAt = cache.stored_at;
        this.flagsTtlMs = this.flagCacheTtlMs;
        this.flagsIdentity = cache.distinct_id;
        // A future `stored_at` (clock moved backwards after the write)
        // would stay fresh on every adoption until real time catches up,
        // outliving the TTL bound. Normalize the stamp to now and rewrite
        // the entry so subsequent launches age it honestly.
        if (
          typeof cache.stored_at === "number" &&
          cache.stored_at > Date.now()
        ) {
          this.flagsPersistedAt = Date.now();
          void this.storage.setItem(
            KEYS.flags,
            JSON.stringify({
              distinct_id: this.distinctId,
              flags: this.flags,
              stored_at: this.flagsPersistedAt,
            } satisfies FlagsCache),
          );
        }
        this.emitFlags();
      }
    }

    await this.trackAutomaticLifecycleEvents();
    this.hydrated = true;
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.maybeFlush();
    }, this.flushInterval);
    // Don't keep the Node/Hermes process alive purely for this timer.
    const t = this.timer as unknown as { unref?: () => void };
    t.unref?.();
  }

  /**
   * Writes the native crash reporter's config (read on the NEXT launch, see
   * `nativeCrashReporting`): `enabled` is `nativeCrashReporting` and
   * isExceptionCaptureEnabled(), `metricKit` is `metricKitDiagnostics`
   * (default: `nativeCrashReporting`) and the same, with the current
   * identity. Runs once the client is ready, on setNativeCrashReporting(), after identify()/reset(), and on every
   * onExceptionCaptureChange. Never before the persisted opt-out was read, so
   * the transient `false` of isExceptionCaptureEnabled() at startup is never
   * written. A no-op without the native module.
   * @internal
   */
  syncNativeCrashConfig(): void {
    if (!this.nativeCrashRelease || !this.optOutResolved) return;
    writeNativeCrashConfig(
      this.nativeModule,
      buildNativeCrashConfig({
        // `disabled` means no network at all, and the native reporter sends
        // on its own: it stays off.
        nativeCrashReporting: this.nativeCrashChoice("nativeCrashReporting") && !this.disabled,
        metricKitDiagnostics: this.disabled ? false : this.nativeCrashChoice("metricKitDiagnostics"),
        captureEnabled: this.isExceptionCaptureEnabled(),
        release: this.nativeCrashRelease.release,
        dist: this.nativeCrashRelease.dist,
        distinctId: this.distinctId,
        deviceId: this.deviceId,
        build: this.appBuild,
        sessionId: this.replay?.sessionId(),
      }),
    );
  }

  /**
   * Changes `nativeCrashReporting` and/or `metricKitDiagnostics` after init,
   * e.g. once feature flags are loaded. An omitted (or `undefined`) key keeps
   * its current value; `metricKitDiagnostics` keeps following
   * `nativeCrashReporting` while it was never set.
   *
   * Takes effect on the NEXT launch: the config native code reads at startup
   * is rewritten, but nothing is installed or removed in this process.
   *
   * The choice is persisted: on the next launch it is the starting value of
   * each key the init options leave out, so a launch that ends before its
   * feature flags arrive never rewrites the config with the init default.
   * Leave the option out of `init()` for a key you drive with this setter
   * (an explicit init value wins over the persisted one until the setter
   * runs again). A value set here in this launch wins over both.
   * Before `ready` it only records the values, and the first write already
   * carries them. `disabled`, opt-out and `captureExceptions: false` still
   * keep both off.
   */
  setNativeCrashReporting(options: NativeCrashReportingOptions): void {
    if (typeof options.nativeCrashReporting === "boolean") {
      this.nativeCrashSet.nativeCrashReporting = options.nativeCrashReporting;
    }
    if (typeof options.metricKitDiagnostics === "boolean") {
      this.nativeCrashSet.metricKitDiagnostics = options.metricKitDiagnostics;
    }
    if (this.nativeCrashStored) this.persistNativeCrashChoice();
    this.syncNativeCrashConfig();
  }

  private nativeCrashChoice(key: keyof NativeCrashReportingOptions): boolean | undefined {
    return this.nativeCrashSet[key] ?? this.nativeCrashInit[key] ?? this.nativeCrashStored?.[key];
  }

  /** The persisted choice of earlier setNativeCrashReporting() calls; `{}` when none or unreadable. */
  private async loadNativeCrashChoice(): Promise<NativeCrashReportingOptions> {
    try {
      const raw = await this.storage.getItem(KEYS.nativeCrash);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return {};
      const choice: NativeCrashReportingOptions = {};
      const { nativeCrashReporting, metricKitDiagnostics } = parsed as Record<string, unknown>;
      if (typeof nativeCrashReporting === "boolean") choice.nativeCrashReporting = nativeCrashReporting;
      if (typeof metricKitDiagnostics === "boolean") choice.metricKitDiagnostics = metricKitDiagnostics;
      return choice;
    } catch {
      return {};
    }
  }

  private persistNativeCrashChoice(): void {
    this.nativeCrashStored = { ...this.nativeCrashStored, ...this.nativeCrashSet };
    void Promise.resolve()
      .then(() => this.storage.setItem(KEYS.nativeCrash, JSON.stringify(this.nativeCrashStored)))
      .catch(() => {});
  }

  /** Stops the auto-flush timer and removes the `captureExceptions`
   * handlers (restoring the previous ones while ours are still installed).
   * Useful for tests and clean shutdown. */
  stop(): void {
    this.metrics.flush();
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.teardownCapture?.();
    this.teardownCapture = undefined;
    this.exceptions.retire();
    this.replay?.stop();
  }

  private persistQueue(): void {
    void this.storage.setItem(KEYS.queue, JSON.stringify(this.queue));
  }

  private persistEngageQueue(): void {
    void this.storage.setItem(KEYS.engageQueue, JSON.stringify(this.engageQueue));
  }

  private persistSuperProps(): void {
    void this.storage.setItem(KEYS.superProps, JSON.stringify(this.superProps));
  }

  getDistinctId(): string {
    return this.distinctId;
  }

  /** Stable per-device id stamped as `$device_id` on every event. Survives
   * identify(); reset() mints a new one. */
  getDeviceId(): string {
    return this.deviceId;
  }

  register(properties: Properties): void {
    this.superProps = { ...this.superProps, ...properties };
    this.persistSuperProps();
  }

  unregister(key: string): void {
    delete this.superProps[key];
    this.persistSuperProps();
  }

  /** Starts an in-memory timer for `event`. The next `track(event)` of the same
   * name attaches `$duration` (seconds, 3 decimals) and clears the timer.
   * Mirrors Mixpanel's `time_event`. */
  timeEvent(event: string): void {
    this.timedEvents.set(event, Date.now());
  }

  /** Cancels a pending timer started by `timeEvent(event)` without tracking. */
  clearTimedEvent(event: string): void {
    this.timedEvents.delete(event);
  }

  /** Cancels all pending timed-event timers. */
  clearTimedEvents(): void {
    this.timedEvents.clear();
  }

  /** Computes `$duration` (seconds, 3 decimals) for a timed event and clears
   * its timer, returning `{}` when the event was not timed. */
  private consumeTimedEvent(event: string): Properties {
    const startedAt = this.timedEvents.get(event);
    if (startedAt === undefined) return {};
    this.timedEvents.delete(event);
    const durationSec = Math.round(((Date.now() - startedAt) / 1000) * 1000) / 1000;
    return { $duration: durationSec };
  }

  /**
   * Stop collecting on this device: persisted (survives a restart), drops
   * every queued event, people operation and exception, and until
   * optInTracking() no track, people, alias or `$exception` is queued or sent.
   */
  optOutTracking(): void {
    this.optedOut = true;
    this.optOutTouched = true;
    this.optOutEpoch += 1;
    void this.storage.setItem(KEYS.optOut, "1");
    this.discardPendingData();
    this.metrics.discard();
    this.exceptions.setOptedOut(true);
    // Recording stops and what it held is dropped; optInTracking() does not
    // restart it (the next init() does), like the web SDK.
    this.replay?.optOut();
    this.emitCaptureChange();
  }

  /**
   * Resume collecting after optOutTracking(). Discarded data is not restored,
   * and session replay stays off until the next init().
   */
  optInTracking(): void {
    this.optedOut = false;
    this.optOutTouched = true;
    void this.storage.removeItem(KEYS.optOut);
    // Samples recorded while opted out are not sent after opting back in.
    this.metrics.discard();
    this.exceptions.setOptedOut(false);
    this.emitCaptureChange();
  }

  hasOptedOutTracking(): boolean {
    return this.optedOut;
  }

  /**
   * Whether an exception captured now would be recorded: the persisted
   * opt-out was read and says "in", and `captureExceptions` is not `false`.
   * `false` until the hydration of the persisted state finishes, so a device
   * with a saved opt-out never reads `true` at startup. Pass it as `enabled`
   * to a native crash reporter, and re-send that configuration whenever it
   * changes (see onExceptionCaptureChange()).
   */
  isExceptionCaptureEnabled(): boolean {
    return this.optOutResolved && !this.optedOut && this.captureExceptionsEnabled;
  }

  /**
   * Calls `listener(enabled)` whenever the value of
   * isExceptionCaptureEnabled() changes: when the hydration finishes (only if
   * it turns `true`), and on optOutTracking() / optInTracking() (only if they
   * flip it). It is not called with the current value on subscribe. A native
   * crash reporter configured from isExceptionCaptureEnabled() must be
   * reconfigured (enabled or disabled) from this listener, or a crash after
   * an opt-out would still be reported by the native side. A throwing
   * listener is contained. Returns the unsubscribe.
   */
  onExceptionCaptureChange(listener: (enabled: boolean) => void): () => void {
    this.captureListeners.add(listener);
    return () => {
      this.captureListeners.delete(listener);
    };
  }

  private emitCaptureChange(): void {
    const enabled = this.isExceptionCaptureEnabled();
    if (enabled === this.lastCaptureEnabled) return;
    this.lastCaptureEnabled = enabled;
    for (const listener of [...this.captureListeners]) {
      try {
        listener(enabled);
      } catch {
        // A throwing listener must not break the opt-out.
      }
    }
  }

  private discardPendingData(): void {
    this.queue = [];
    this.engageQueue = [];
    this.persistQueue();
    this.persistEngageQueue();
  }

  track(event: string, properties: Properties = {}): void {
    if (this.optedOut) return;
    const props: TrackEvent["properties"] = {
      ...this.getDeviceDefaultProperties(),
      ...this.consumeTimedEvent(event),
      ...this.superProps,
      ...properties,
      distinct_id: this.distinctId,
      time: Date.now(),
      $insert_id: uuid(),
      $lib: LIB_NAME,
      ...(this.token !== undefined ? { token: this.token } : {}),
    };
    // Reserved identity fields, stamped last but never overriding a value the
    // caller passed explicitly (mirrors Mixpanel's $device_id/$user_id).
    if (props.$device_id === undefined) props.$device_id = this.deviceId;
    if (!this.anonymous && props.$user_id === undefined) {
      props.$user_id = this.distinctId;
    }
    this.stampSession(event, props);
    const payload: TrackEvent = { event, properties: props };
    this.queue.push(payload);
    this.enforceQueueCap();
    this.persistQueue();
    if (this.queue.length >= this.flushAt) {
      this.maybeFlush();
    }
  }

  /**
   * Like track() but stamps `time` instead of Date.now(), never consumes a
   * timed event, and drops `metric_*` super props the event did not set. Used
   * for aggregated events (`$metric`) that describe a past window.
   */
  private trackAt(event: string, properties: Properties, time: number): void {
    // Before the hydration the identity is the constructor's transient one and
    // the persisted queue has not been merged in: build the event afterwards.
    if (!this.hydrated) {
      const epoch = this.identityEpoch;
      void this.ready.then(
        () => {
          // The window was taken before this client knew its own state: it is
          // dropped when the kill switch loaded off, the client stopped, or the
          // identity changed meanwhile (the samples cannot be attributed).
          if (this.stopped || !this.metrics.isEnabled() || this.identityEpoch !== epoch) return;
          this.trackAt(event, properties, time);
        },
        () => {},
      );
      return;
    }
    if (this.optedOut) return;
    const props: TrackEvent["properties"] = {
      ...this.getDeviceDefaultProperties(),
      ...this.superProps,
      ...properties,
      distinct_id: this.distinctId,
      time,
      $insert_id: uuid(),
      $lib: LIB_NAME,
      ...(this.token !== undefined ? { token: this.token } : {}),
    };
    for (const key of Object.keys(props)) {
      if (key.startsWith("metric_") && !(key in properties)) delete props[key];
    }
    if (props.$device_id === undefined) props.$device_id = this.deviceId;
    if (!this.anonymous && props.$user_id === undefined) {
      props.$user_id = this.distinctId;
    }
    this.stampSession(event, props);
    this.queue.push({ event, properties: props });
    this.enforceQueueCap();
    this.persistQueue();
    // No size-triggered flush: a window is queued by metrics.flush() right
    // before the caller's own flush (background, stop), and an auto flush
    // here would take the in-flight slot with only part of the window.
  }

  /** `$metric` events wait for the kill switch while flags are loading and none are loaded yet. */
  private metricsHeld(): boolean {
    return !this.flagsLoaded && (this.flagLoadsInFlight > 0 || this.initialFlagsPending);
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
   * Switches identity to `distinctId`. No-op when it already is the current
   * id. The switch is applied synchronously, before any network call.
   *
   * When the previous id was still anonymous, this also links the two by
   * POSTing `/alias`, so the server folds pre-login history into the same
   * person. Best effort: it is fired without awaiting and a failure is
   * swallowed, because the server also links `$device_id` to `$user_id`
   * implicitly from the next event that carries both (which every event
   * from an identified user does), so a dropped call delays the link
   * rather than losing it. Mirrors @cohorly/core and the iOS SDK.
   */
  identify(distinctId: string): void {
    if (distinctId === this.distinctId) return;
    // Samples were taken as the outgoing identity.
    this.metrics.flush();
    this.identityEpoch += 1;
    const previousId = this.distinctId;
    const wasAnonymous = this.anonymous;
    this.distinctId = distinctId;
    this.anonymous = false;
    if (!this.hydrated) {
      this.preReadyEpochs.set(this.identityEpoch, { distinctId, anonymous: false });
    }
    // Marker for hydrate(): if its storage reads are still in flight, the
    // snapshot they resolve with is stale and must not restore identity.
    // An earlier reset() wins - it cleared more than an identify() does.
    this.preReadyIdentityOp ??= "identify";
    void this.storage.setItem(KEYS.distinctId, distinctId);
    void this.storage.setItem(KEYS.anonymous, "0");
    // Flags are per-identity: drop the previous identity's in-memory state
    // and remove its persisted cache before the refresh (a slow or failed
    // reload must not keep serving the old user's variants to the new id),
    // and let the new identity record its own exposures. The persisted entry
    // is removed under every policy - identity hygiene, not flag serving.
    this.clearFlagState();
    this.exposedFlags.clear();
    void this.storage.removeItem(KEYS.flags);
    void this.reloadFeatureFlags();
    this.syncNativeCrashConfig();
    // `disabled` is enforced in doFlush() for the queued paths; this post
    // does not go through the queue, so it has to check for itself.
    if (!wasAnonymous || this.disabled || this.optedOut) return;
    if (!this.hydrated) {
      // The outgoing id may still be the transient constructor uuid while
      // hydrate() reads storage: the real anonymous predecessor is only
      // known once the persisted snapshot resolves, so the /alias decision
      // is deferred to hydrate().
      this.pendingAliasFrom = previousId;
      return;
    }
    this.sendIdentifyAlias(previousId, distinctId);
  }

  /** Best-effort /alias linking an anonymous predecessor to its identified
   * user; a failure is not retried and never surfaces to the caller. */
  private sendIdentifyAlias(previousId: string, distinctId: string): void {
    void this.send("/alias", {
      alias: previousId,
      distinct_id: distinctId,
      ...(this.token !== undefined ? { token: this.token } : {}),
    }).catch(() => {
      // Best effort, like the other client SDKs: an alias failure is not
      // retried and never surfaces to the caller.
    });
  }

  /** Clears identity, super properties, queued-but-unsent events, and any
   * pending timed events, then assigns a fresh anonymous distinct id (and a
   * matching new device id). Mirrors mixpanel's `reset()`. */
  reset(): void {
    // A new replay session (new id, draw and seq) first, while the outgoing
    // identity is still current: what the old session captured is uploaded
    // under that identity. Its rotation re-sends the crash config too.
    this.replay?.reset();
    // The queue is cleared below, so the pending window is dropped with it
    // instead of being queued and erased, or attributed to the new identity.
    this.metrics.discard();
    this.identityEpoch += 1;
    this.distinctId = uuid();
    // New anon identity: the device id follows the fresh anon distinct id.
    this.deviceId = this.distinctId;
    this.anonymous = true;
    if (!this.hydrated) {
      this.preReadyEpochs.set(this.identityEpoch, {
        distinctId: this.distinctId,
        anonymous: true,
        deviceId: this.deviceId,
      });
    }
    // Marker for hydrate(): everything it could restore from a stale
    // snapshot was just cleared and re-persisted, so it must skip all
    // identity-scoped restores.
    this.preReadyIdentityOp = "reset";
    // Any alias deferred by a pre-ready identify() is void: the identity it
    // would have linked was just discarded along with everything else.
    this.pendingAliasFrom = undefined;
    this.superProps = {};
    this.queue = [];
    this.engageQueue = [];
    this.timedEvents.clear();
    // Breadcrumbs describe the outgoing identity's session; queued
    // exceptions stay and still ship.
    this.exceptions.clearBreadcrumbs();
    void this.storage.setItem(KEYS.distinctId, this.distinctId);
    void this.storage.setItem(KEYS.deviceId, this.deviceId);
    void this.storage.setItem(KEYS.anonymous, "1");
    this.persistSuperProps();
    this.persistQueue();
    this.persistEngageQueue();
    // Flags are per-identity: the previous identity's flags must not be served
    // to the new anonymous id, so drop them and remove the persisted cache
    // (under every policy) before the refresh.
    this.clearFlagState();
    this.exposedFlags.clear();
    void this.storage.removeItem(KEYS.flags);
    void this.reloadFeatureFlags();
    this.syncNativeCrashConfig();
  }

  /**
   * Re-evaluate feature flags for the current distinct id via
   * POST /flags/evaluate, caching the result in memory and - unless the
   * policy is `networkOnly` - in storage (key `cohorly:flags`, scoped by
   * distinct id, stamped with `stored_at`). Never rejects: on any error
   * (network, non-2xx, bad JSON) the stale cache is kept.
   */
  async reloadFeatureFlags(): Promise<void> {
    this.flagLoadsInFlight += 1;
    try {
      // Opted out: no request (it would carry the distinct id); whatever is
      // cached stays served.
      // Before the hydration the in-memory opt-out is provisional: a saved
      // opt-out must be read before a request carries the distinct id.
      if (!this.optOutResolved) await this.ready.catch(() => {});
      if (this.disabled || !this.fetchImpl || this.optedOut) return;
      const requestedId = this.distinctId;
      const seq = ++this.flagRequestSeq;

      let parsed: unknown;
      try {
        const res = await this.fetchImpl(`${this.apiHost}/flags/evaluate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            distinct_id: requestedId,
            ...(this.token !== undefined ? { token: this.token } : {}),
          }),
        });
        if (!res.ok) return;
        parsed = await res.json();
      } catch {
        // Swallowed by contract: a failed reload keeps the stale flag cache.
        return;
      }

      // Identity changed, or a newer reload started, while this request was in
      // flight: these results are stale, discard them.
      if (requestedId !== this.distinctId || seq !== this.flagRequestSeq) return;
      const flags = (parsed as { flags?: unknown } | null | undefined)?.flags;
      if (!flags || typeof flags !== "object") return;

      this.flags = flags as Record<string, FlagResult>;
      this.flagsLoaded = true;
      this.flagsSource = "network";
      this.flagsPersistedAt = undefined;
      this.flagsTtlMs = undefined;
      this.flagsIdentity = requestedId;
      if (this.flagPersistence !== "networkOnly") {
        void this.storage.setItem(
          KEYS.flags,
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
    this.flagsIdentity = undefined;
    this.emitFlags();
  }

  /** Notifies every onFeatureFlags listener; a throwing listener never breaks
   * the others (or the reload). */
  private emitFlags(): void {
    for (const cb of this.flagListeners) {
      try {
        cb(this.flags);
      } catch {
        // Listener errors are the listener's problem, not the SDK's.
      }
    }
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
   * `stored_at`), or "fallback" when
   * the flag is unknown - in which case `value` is `fallback` (default
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
   * Emits `$feature_flag_called` once per (key, value) per identity session.
   * Only a read of a loaded, known flag is an exposure - the fallback
   * returned for an unknown key or before load is a default, not an
   * exposure. The event always carries `$feature_flag_source` (the same
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
      } catch {
        // Same contract as emitFlags: a throwing listener is contained.
      }
    }
    return () => {
      this.flagListeners.delete(cb);
    };
  }

  private queueEngage(payload: EngagePayload): void {
    if (this.optedOut) return;
    this.engageQueue.push(
      this.token !== undefined ? { ...payload, token: this.token } : payload,
    );
    // Before hydration a write would race the stored read (the op restored
    // twice) or clobber the stored queue; hydrate() persists the merge.
    if (this.hydrated) this.persistEngageQueue();
    if (this.engageQueue.length >= this.flushAt) {
      this.maybeFlush();
    }
  }

  readonly people = {
    set: (properties: Properties): void => {
      this.queueEngage({
        distinct_id: this.distinctId,
        $set: { ...this.getProfileDefaultProperties(), ...properties },
      });
    },
    setOnce: (properties: Properties): void => {
      this.queueEngage({
        distinct_id: this.distinctId,
        $set_once: { ...this.getProfileDefaultProperties(), ...properties },
      });
    },
    increment: (properties: Properties): void => {
      this.queueEngage({ distinct_id: this.distinctId, $add: properties });
    },
    unset: (keys: string[]): void => {
      this.queueEngage({ distinct_id: this.distinctId, $unset: keys });
    },
    deleteUser: (): void => {
      this.queueEngage({ distinct_id: this.distinctId, $delete: true });
    },
  };

  private flushPromise: Promise<void> | null = null;

  /** Flushes queued exceptions, then events/engage payloads. Safe to call concurrently: if a
   * flush is already in flight (e.g. triggered automatically by `track()`
   * reaching `flushAt` while a caller also calls `flush()` manually), later
   * callers await that same in-flight operation instead of racing it.
   *
   * A manual `flush()` always attempts a send, even while in backoff (treated
   * as an explicit "try now"). The auto-flush timer, size triggers, and
   * app-state transitions go through the backoff-aware path and are skipped
   * until the backoff deadline passes. */
  async flush(): Promise<void> {
    return this.runFlush(true);
  }

  /** Backoff-aware flush used by the timer, size triggers, and app-state. */
  private maybeFlush(): void {
    void this.runFlush(false);
  }

  private runFlush(force: boolean): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.flushPromise = this.doFlush(force).finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async doFlush(force: boolean): Promise<void> {
    if (this.disabled || this.optedOut) return;
    // With replay, no event leaves before the stored session was read and
    // the queue re-stamped (it would carry the provisional `$session_id`).
    if (this.replayLoaded) {
      await this.replayLoaded;
      if (this.disabled || this.optedOut) return;
    }

    // Exceptions first, on their own retry state (not the events' backoff).
    // Like the core, events wait for the next flush when the exceptions could
    // not be delivered (same endpoint, so most likely the same outage).
    if (this.exceptions.isStarted && this.exceptions.storage.hasQueuedExceptions()) {
      const delivered = await this.exceptions.flush(force);
      if (!delivered) return;
    }

    if (!force && Date.now() < this.backoffUntil) return;

    const size = Math.max(1, this.effectiveBatchSize);
    const batch = (
      this.metricsHeld()
        ? this.queue.filter((evt) => evt.event !== METRIC_EVENT)
        : this.queue
    ).slice(0, size);
    if (batch.length > 0) {
      const epoch = this.optOutEpoch;
      const sent = new Set(batch);
      this.queue = this.queue.filter((evt) => !sent.has(evt));
      this.persistQueue();
      try {
        await this.send("/track", batch);
        // Success: clear failure state and backoff.
        if (epoch === this.optOutEpoch) {
          this.consecutiveFailures = 0;
          this.backoffUntil = 0;
        }
      } catch (err) {
        // Opted out while it was on the wire: the batch is not put back (nor
        // persisted) and no backoff is carried over.
        if (epoch === this.optOutEpoch && !this.optedOut) this.handleFlushError(err, batch);
        return; // stop; don't attempt engage while backing off.
      }
    }

    if (this.optedOut) return;
    if (this.engageQueue.length > 0) {
      const batch = this.engageQueue;
      const epoch = this.optOutEpoch;
      this.engageQueue = [];
      this.persistEngageQueue();
      try {
        await this.send("/engage", batch);
      } catch {
        if (epoch === this.optOutEpoch && !this.optedOut) {
          this.engageQueue = [...batch, ...this.engageQueue];
          this.persistEngageQueue();
        }
      }
    }
  }

  /**
   * Applies the retry contract to a failed /track flush. `batch` is the just-
   * attempted set of events (already removed from the front of the queue).
   *
   * - 400: payload permanently rejected - drop that batch, do not re-queue.
   * - 413: too big - re-queue and halve the effective batch size (no backoff).
   * - 401: invalid token - re-queue, backoff at max delay.
   * - 429 / 5xx / network: re-queue, exponential backoff (Retry-After, when
   *   present on a 429, overrides the computed delay, still capped).
   */
  private handleFlushError(err: unknown, batch: TrackEvent[]): void {
    const status = err instanceof TransportError ? err.status : undefined;

    if (status === 400) {
      // Permanently rejected: already removed from the queue, so just drop.
      return;
    }

    // Re-queue at the front for the next attempt. A kill switch that turned
    // metrics off while the batch was on the wire must not get them back.
    const requeue = this.metrics.isEnabled()
      ? batch
      : batch.filter((evt) => evt.event !== METRIC_EVENT);
    this.queue = [...requeue, ...this.queue];
    this.persistQueue();

    if (status === 413) {
      this.effectiveBatchSize = Math.max(1, Math.floor(this.effectiveBatchSize / 2));
      return;
    }

    this.consecutiveFailures += 1;
    let delay = this.computeBackoffMs();
    if (status === 401) {
      delay = this.maxRetryDelayMs;
    } else if (
      status === 429 &&
      err instanceof TransportError &&
      err.retryAfterMs !== undefined
    ) {
      delay = Math.min(err.retryAfterMs, this.maxRetryDelayMs);
    }
    this.backoffUntil = Date.now() + delay;
  }

  /** Exponential backoff: base 2000ms, doubling per failure, capped, +/-20% jitter. */
  private computeBackoffMs(): number {
    const exp = BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1);
    const capped = Math.min(exp, this.maxRetryDelayMs);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  /**
   * Trims the queue to `maxQueueSize`, dropping the OLDEST events; aggregated
   * `$metric` events go first, so they never push product events out.
   */
  private enforceQueueCap(): boolean {
    if (this.queue.length <= this.maxQueueSize) return false;
    const overflow = this.queue.length - this.maxQueueSize;
    const drop = new Set<number>();
    for (let i = 0; i < this.queue.length && drop.size < overflow; i++) {
      if (this.queue[i].event === METRIC_EVENT) drop.add(i);
    }
    for (let i = 0; drop.size < overflow; i++) drop.add(i);
    this.queue = this.queue.filter((_, i) => !drop.has(i));
    return true;
  }

  private async send(path: string, body: unknown): Promise<void> {
    if (!this.fetchImpl) return;
    const res = await this.fetchImpl(`${this.apiHost}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new TransportError(
        res.status,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
  }
}
