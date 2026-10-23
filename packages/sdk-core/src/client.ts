import { fetchFlagsFetcher, fetchTransport, TransportError } from "./transport.js";
import type {
  CohorlyClientOptions,
  CohorlyStorage,
  CohorlyTransport,
  FlagDetails,
  FlagPersistenceMode,
  FlagResult,
  FlagsFetcher,
  PeopleProperties,
  TrackedEvent,
} from "./types.js";
import { uuid } from "./uuid.js";

const KEY_DISTINCT_ID = "cohorly_distinct_id";
const KEY_DEVICE_ID = "cohorly_device_id";
const KEY_ANONYMOUS = "cohorly_anonymous";
const KEY_SUPER_PROPS = "cohorly_super_props";
const KEY_QUEUE = "cohorly_queue";
const KEY_TIMED_EVENTS = "cohorly_timed_events";
const KEY_FLAGS = "chl_flags";

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

    this.people = {
      set: (props) => this.sendEngage({ $set: props }),
      setOnce: (props) => this.sendEngage({ $set_once: props }),
      increment: (props) => this.sendEngage({ $add: props }),
      unset: (keys) => this.sendEngage({ $unset: keys }),
      delete: () => this.sendEngage({ $delete: true }),
    };

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

    const props: TrackedEvent["properties"] = {
      ...this.superProps,
      ...properties,
      ...(duration !== undefined ? { $duration: duration } : {}),
      distinct_id: this.distinctId,
      time: Date.now(),
      $insert_id: uuid(),
      $lib: this.lib,
      ...(this.token !== undefined ? { token: this.token } : {}),
    };
    // Reserved identity fields, stamped last but never overriding a value the
    // caller passed explicitly (mirrors Mixpanel's $device_id/$user_id).
    if (props.$device_id === undefined) props.$device_id = this.deviceId;
    if (!this.anonymous && props.$user_id === undefined) {
      props.$user_id = this.distinctId;
    }
    const evt: TrackedEvent = { event, properties: props };
    this.queue.push(evt);
    this.enforceQueueCap();
    this.persistQueue();
    if (this.queue.length >= this.batchSize) {
      this.maybeFlush();
    }
    return evt;
  }

  async identify(id: string): Promise<void> {
    if (id === this.distinctId) return;

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
    if (wasAnonymous) {
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

  reset(): void {
    this.distinctId = uuid();
    this.deviceId = this.distinctId;
    this.anonymous = true;
    this.storage.set(KEY_DISTINCT_ID, this.distinctId);
    this.storage.set(KEY_DEVICE_ID, this.deviceId);
    this.storage.set(KEY_ANONYMOUS, "1");
    this.clearTimedEvents();
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
   */
  async flush(transportOverride?: CohorlyTransport): Promise<void> {
    return this.doFlush(transportOverride, true);
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
    if (this.flushing || this.queue.length === 0) return;
    if (!force && Date.now() < this.backoffUntil) return;
    this.flushing = true;
    try {
      const size = Math.max(1, this.effectiveBatchSize);
      const batch = this.queue.slice(0, size);
      const send = transportOverride ?? this.transport;
      try {
        await send(`${this.apiHost}/track`, batch);
        this.queue = this.queue.slice(batch.length);
        this.persistQueue();
        // Success: clear failure state and backoff.
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
      } catch (err) {
        this.handleFlushError(err, batch.length);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Applies the retry contract to a failed flush. `batchLen` is how many events
   * were in the just-attempted batch (front of the queue).
   *
   * - 400: payload permanently rejected - drop that batch, do not retry it.
   * - 413: payload too big - halve the effective batch size (floor 1), keep
   *   the queue, retry smaller next time (no backoff).
   * - 401: invalid token - keep queue, warn, backoff at max delay.
   * - 429 / 5xx / network: keep queue, exponential backoff (Retry-After, when
   *   present on a 429, overrides the computed delay, still capped).
   */
  private handleFlushError(err: unknown, batchLen: number): void {
    const status = err instanceof TransportError ? err.status : undefined;

    if (status === 400) {
      this.log("dropping batch permanently rejected with 400", err);
      this.queue = this.queue.slice(batchLen);
      this.persistQueue();
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
    this.queue.splice(0, overflow);
    this.log("queue cap exceeded, dropped oldest events", overflow);
    return true;
  }

  /** Base URL events are sent to, e.g. for building a sendBeacon URL. */
  getApiHost(): string {
    return this.apiHost;
  }

  /** Stop the auto-flush timer. Useful in tests / on app teardown. */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  private async sendEngage(op: Record<string, unknown>): Promise<void> {
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
