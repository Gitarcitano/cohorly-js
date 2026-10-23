import {
  deriveDeviceInfo,
  fetchNativeDeviceInfo,
  loadNativeModules,
  mergePlatformInfo,
  resolveAppState,
  watchWifi,
} from "./deviceInfo.js";
import { InMemoryStorage } from "./storage.js";
import type {
  AppStateLike,
  AsyncStorageLike,
  CohorlyOptions,
  EngagePayload,
  FlagDetails,
  FlagPersistenceMode,
  FlagResult,
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
  /**
   * /alias source deferred by a pre-ready identify(): the outgoing distinct
   * id captured at call time may still be the transient constructor uuid,
   * so hydrate() swaps in the persisted anonymous predecessor when the
   * stored snapshot resolves with one.
   */
  private pendingAliasFrom: string | undefined;

  constructor(options: CohorlyOptions) {
    this.apiHost = (options.apiHost ?? DEFAULT_API_HOST).replace(/\/$/, "");
    this.storage = options.storage ?? new InMemoryStorage();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.flushAt = options.flushAt ?? DEFAULT_FLUSH_AT;
    this.disabled = options.disabled ?? false;
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
    // Transient until hydrate() resolves the persisted/derived value.
    this.deviceId = this.distinctId;

    const mods = loadNativeModules();
    const derived = deriveDeviceInfo(mods);
    this.appVersion = options.appVersion ?? derived.appVersion;
    this.appBuild = options.appBuild ?? derived.appBuild;
    this.platformInfo = mergePlatformInfo(derived.platformInfo, options.platformInfo);
    this.wifi = this.platformInfo.wifi;
    if (this.wifi === undefined) {
      watchWifi(mods.netInfo, (w) => {
        this.wifi = w;
      });
    }
    this.appStateModule = resolveAppState(options.appState, mods.rn);

    // Highest-precedence auto-derived tier: this package's own autolinked
    // native module (when the host app has rebuilt with it linked). Resolves
    // async, so it's folded into `ready` - explicit options still win over it,
    // and it wins over the react-native-device-info/expo sync tiers above.
    const nativeReady = fetchNativeDeviceInfo(mods.rn).then((native) => {
      this.appVersion = options.appVersion ?? native.appVersion ?? derived.appVersion;
      this.appBuild = options.appBuild ?? native.appBuild ?? derived.appBuild;
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
    this.ready = Promise.all([this.hydrate(), nativeReady]).then(() => {
      if (loadFlags) void this.reloadFeatureFlags();
    });
    this.startTimer();
    watchAppState(this.appStateModule, (state) => this.handleAppStateChange(state));
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
        this.maybeFlush();
      };
      if (this.hydrated) finish();
      else void this.ready.then(finish);
    } else if (state === "active" && !wasActive) {
      this.sessionStartedAt = Date.now();
    }

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
    const [
      storedId,
      storedAnon,
      storedDevice,
      storedSuper,
      storedQueue,
      storedEngageQueue,
      storedFlags,
    ] = await Promise.all([
      this.storage.getItem(KEYS.distinctId),
      this.storage.getItem(KEYS.anonymous),
      this.storage.getItem(KEYS.deviceId),
      this.storage.getItem(KEYS.superProps),
      this.storage.getItem(KEYS.queue),
      this.storage.getItem(KEYS.engageQueue),
      this.storage.getItem(KEYS.flags),
    ]);

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
      if (aliasFrom !== null && !this.disabled) {
        this.sendIdentifyAlias(aliasFrom, this.distinctId);
      }
    }

    if (identityOp !== "reset") {
      // Device id: persisted separately so it survives identify(). A fresh
      // or migrating anonymous install reuses the anon distinct id
      // (Mixpanel's `$device:<uuid>` convention); an identified install
      // (anonymous flag "0") mints a fresh one.
      if (storedDevice) {
        this.deviceId = storedDevice;
      } else {
        this.deviceId = this.anonymous ? this.distinctId : uuid();
        await this.storage.setItem(KEYS.deviceId, this.deviceId);
      }
      if (storedSuper) {
        try {
          this.superProps = JSON.parse(storedSuper);
        } catch {
          this.superProps = {};
        }
      }
      if (storedQueue) {
        try {
          this.queue = JSON.parse(storedQueue);
        } catch {
          this.queue = [];
        }
        // Enforce the persisted cap on load in case a larger queue was stored.
        if (this.enforceQueueCap()) this.persistQueue();
      }
      if (storedEngageQueue) {
        try {
          this.engageQueue = JSON.parse(storedEngageQueue);
        } catch {
          this.engageQueue = [];
        }
      }
    }

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

  /** Stops the auto-flush timer. Useful for tests and clean shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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

  track(event: string, properties: Properties = {}): void {
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
    const payload: TrackEvent = { event, properties: props };
    this.queue.push(payload);
    this.enforceQueueCap();
    this.persistQueue();
    if (this.queue.length >= this.flushAt) {
      this.maybeFlush();
    }
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
    const previousId = this.distinctId;
    const wasAnonymous = this.anonymous;
    this.distinctId = distinctId;
    this.anonymous = false;
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
    // `disabled` is enforced in doFlush() for the queued paths; this post
    // does not go through the queue, so it has to check for itself.
    if (!wasAnonymous || this.disabled) return;
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
    this.distinctId = uuid();
    // New anon identity: the device id follows the fresh anon distinct id.
    this.deviceId = this.distinctId;
    this.anonymous = true;
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
  }

  /**
   * Re-evaluate feature flags for the current distinct id via
   * POST /flags/evaluate, caching the result in memory and - unless the
   * policy is `networkOnly` - in storage (key `cohorly:flags`, scoped by
   * distinct id, stamped with `stored_at`). Never rejects: on any error
   * (network, non-2xx, bad JSON) the stale cache is kept.
   */
  async reloadFeatureFlags(): Promise<void> {
    if (this.disabled || !this.fetchImpl) return;
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
    this.engageQueue.push(
      this.token !== undefined ? { ...payload, token: this.token } : payload,
    );
    this.persistEngageQueue();
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

  /** Flushes queued events/engage payloads. Safe to call concurrently: if a
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
    if (this.disabled) return;
    if (!force && Date.now() < this.backoffUntil) return;

    if (this.queue.length > 0) {
      const size = Math.max(1, this.effectiveBatchSize);
      const batch = this.queue.slice(0, size);
      this.queue = this.queue.slice(batch.length);
      this.persistQueue();
      try {
        await this.send("/track", batch);
        // Success: clear failure state and backoff.
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
      } catch (err) {
        this.handleFlushError(err, batch);
        return; // stop; don't attempt engage while backing off.
      }
    }

    if (this.engageQueue.length > 0) {
      const batch = this.engageQueue;
      this.engageQueue = [];
      this.persistEngageQueue();
      try {
        await this.send("/engage", batch);
      } catch {
        this.engageQueue = [...batch, ...this.engageQueue];
        this.persistEngageQueue();
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

    // Re-queue at the front for the next attempt.
    this.queue = [...batch, ...this.queue];
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

  /** Trims the queue to `maxQueueSize`, dropping the OLDEST events. */
  private enforceQueueCap(): boolean {
    if (this.queue.length <= this.maxQueueSize) return false;
    const overflow = this.queue.length - this.maxQueueSize;
    this.queue.splice(0, overflow);
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
