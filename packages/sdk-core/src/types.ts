/**
 * Ingestion contract shapes, copied from apps/server/src/types.ts to keep
 * this package standalone (see repo CLAUDE.md "Ownership" convention).
 */
export interface TrackedEvent {
  event: string;
  properties: {
    distinct_id: string;
    time?: number; // unix ms
    $insert_id?: string;
    [key: string]: unknown;
  };
}

export interface EngageOp {
  distinct_id: string;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
  $add?: Record<string, number>;
  /**
   * Destructive: the server refuses this op unless the request also carries an
   * admin credential (superadmin key, or an account token for an org owner) in
   * the Authorization header. Refused ops are skipped individually; the server
   * still answers HTTP 200 with `{ status: 0, ..., refused }`, so from a
   * client-only SDK this is a silent no-op.
   */
  $unset?: string[];
  /** Destructive: same server-side credential requirement as `$unset`. */
  $delete?: boolean;
}

/**
 * Result of evaluating one feature flag for a distinct id, as returned by
 * POST /flags/evaluate (copied shape, see repo CLAUDE.md "Ownership").
 */
export interface FlagResult {
  enabled: boolean;
  variant: string | null;
  payload: unknown | null;
  reason: string;
}

/**
 * Fetcher used for feature-flag evaluation: POSTs `body` as JSON to `url` and
 * resolves with the parsed JSON response. MUST resolve `undefined` on any
 * error (network, non-2xx, bad JSON) - it never throws into the caller.
 */
export type FlagsFetcher = (url: string, body: unknown) => Promise<unknown>;

/**
 * How flag assignments are sourced and persisted (Mixpanel's
 * `variantLookupPolicy` equivalent). Shared contract across every client SDK.
 *
 * - `"networkOnly"`: never reads or writes the persisted cache. Flags come
 *   only from network responses in this session; a failed evaluation leaves
 *   getters at their fallback.
 * - `"networkFirst"`: prefers the network; until the first successful
 *   evaluation (or whenever it fails), a still-valid persisted cache is
 *   served - strictly within `flagCacheTtlMs` of `stored_at`. The cache
 *   keeps being written on every success.
 * - `"persistenceUntilNetworkSuccess"`: serves a valid persisted cache
 *   immediately (no startup flicker); the first successful network response
 *   takes over and re-persists. If the network keeps failing, the cache
 *   keeps serving. This policy trades freshness for offline availability:
 *   it serves a cache until the wider of `flagCacheTtlMs` and 7 days of
 *   staleness, so an expired cache still serves up to a week stale.
 *
 * A legacy cache written by a pre-TTL SDK (no `stored_at`) has no provable
 * age and is served indefinitely under either persistent policy, matching
 * the pre-feature behavior it was written under.
 */
export type FlagPersistenceMode =
  | "networkOnly"
  | "networkFirst"
  | "persistenceUntilNetworkSuccess";

/**
 * Where a served flag value came from: `"network"` is a successful
 * evaluation this session, `"persistence"` is the identity-scoped persisted
 * cache (within the active policy's staleness window), and `"fallback"`
 * means the flag is unknown so the caller-supplied fallback was returned.
 */
export type FlagSource = "network" | "persistence" | "fallback";

/**
 * The full result of reading one flag, as returned by
 * `getFeatureFlagDetails()`. Exists so callers can observe not just the
 * value but its provenance: a persistence-sourced value is observably
 * different from a fresh network evaluation during an incident or rollout.
 */
export interface FlagDetails {
  key: string;
  /**
   * Variant key when the flag has one, else its enabled boolean. When the
   * flag is unknown this is the fallback passed to the getter (`false` by
   * default).
   */
  value: boolean | string;
  /**
   * The flag's enabled boolean. When the flag is unknown this is
   * `Boolean(fallback)` - a truthy fallback is treated as "the feature is
   * on", matching what `isFeatureEnabled(key, true)` would return.
   */
  enabled: boolean;
  /** Variant payload, or `null` when the flag has none / is unknown. */
  payload: unknown | null;
  source: FlagSource;
  /**
   * Epoch ms when the persisted cache was written. Present only when
   * `source` is `"persistence"` and the served cache was written by a
   * TTL-aware SDK; a legacy cache without `stored_at` leaves it absent.
   */
  persistedAt?: number;
  /**
   * The TTL (ms) the served cache is valid for. Present only when `source`
   * is `"persistence"`.
   */
  ttlMs?: number;
}

/**
 * Severity of an exception event (`$exception_level`). `"fatal"` means the
 * app or page could not continue; it is the numerator of crash-free users.
 */
export type ExceptionLevel = "fatal" | "error" | "warning" | "info";

/**
 * How an exception was captured. `handled` is false for errors nothing in the
 * app caught (global handlers); `synthetic` is true when the SDK built the
 * exception itself because what was thrown was not an Error.
 */
export interface ExceptionMechanism {
  handled: boolean;
  type: string;
  synthetic: boolean;
}

/**
 * One stack frame of `$exception_list[].stacktrace.frames` (ADR-0019 "Event
 * format", copied shape). JS SDKs fill `filename`/`abs_path`/`function`/
 * `lineno`/`colno`; native SDKs fill `module` and the addresses.
 */
export interface ExceptionStackFrame {
  platform: string;
  filename?: string;
  abs_path?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
  instruction_addr?: string;
  image_addr?: string;
}

/** Frames ordered oldest call first, crashing frame last. SDKs always send `"raw"`. */
export interface ExceptionStacktrace {
  type: "raw" | "resolved";
  frames: ExceptionStackFrame[];
}

/**
 * One entry of `$exception_list`: index 0 is the reported exception, the rest
 * its cause chain, outermost first.
 */
export interface ExceptionListEntry {
  type: string;
  value: string;
  mechanism: ExceptionMechanism;
  stacktrace?: ExceptionStacktrace;
}

/** A trail entry sent with every exception as `$exception_breadcrumbs`. */
export interface Breadcrumb {
  /** ISO 8601. */
  timestamp: string;
  category: string;
  message?: string;
  level?: string;
  data?: Record<string, unknown>;
}

/** What `addBreadcrumb()` takes: `timestamp` defaults to now. */
export type BreadcrumbInput = Omit<Breadcrumb, "timestamp"> & {
  timestamp?: string;
};

export interface CaptureExceptionOptions {
  /** `$exception_level`. Defaults to `"error"`. */
  level?: ExceptionLevel;
  /**
   * Client-side grouping override, sent as `$exception_fingerprint`. The
   * server always derives the final fingerprint from it; it never stores
   * this value as sent.
   */
  fingerprint?: string;
  /** Sent as `error_title`: the display title, and a fingerprint prefix. */
  title?: string;
  /** Top-level properties; override `extra`, never a reserved key. */
  tags?: Record<string, string | number | boolean>;
  /** Top-level properties; never override a reserved key. */
  extra?: Record<string, unknown>;
  /**
   * Mechanism of the reported exception. Defaults to
   * `{ handled: true, type: "generic" }`.
   */
  mechanism?: { type?: string; handled?: boolean };
  /**
   * Properties a platform SDK adds the way `track()` does (`$os`,
   * `$browser`, `$current_url`, ...). Applied below `extra` and `tags`.
   */
  properties?: Record<string, unknown>;
}

/** Options of `flushExceptions()`. */
export interface FlushExceptionsOptions {
  /** Send only `$exception_level: "fatal"` exceptions. */
  fatalOnly?: boolean;
}

/** Storage abstraction injected by platform-specific SDKs (web/react-native/node). Synchronous. */
export interface CohorlyStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Transport abstraction injected by platform-specific SDKs. Defaults to fetch. */
export type CohorlyTransport = (url: string, body: unknown) => Promise<void>;

export interface CohorlyClientOptions {
  /**
   * Base URL of the Cohorly ingestion API. Defaults to the hosted endpoint
   * (`https://cohorly-service.velloalabs.com`); only set this to point at a
   * different deployment.
   */
  apiHost?: string;
  storage: CohorlyStorage;
  transport?: CohorlyTransport;
  flushIntervalMs?: number;
  batchSize?: number;
  debug?: boolean;
  /** Value stamped on every event as $lib. Defaults to "core". */
  lib?: string;
  /**
   * Project token (mixpanel-style). When set, stamped as `properties.token`
   * on every tracked event and included as a top-level `token` field on
   * every /engage and /alias body, so the server can resolve the event to
   * a project.
   */
  token?: string;
  /**
   * Maximum number of events retained in the persisted queue. On overflow the
   * OLDEST events are dropped (logged via debug). Defaults to 1000.
   */
  maxQueueSize?: number;
  /**
   * Upper bound on the retry backoff delay, in ms. Exponential backoff
   * (base 2000ms, doubling per consecutive failure) and any server-supplied
   * Retry-After are both capped at this value. Defaults to 600000 (10 min).
   */
  maxRetryDelayMs?: number;
  /**
   * Fetcher for feature-flag evaluation requests (POST /flags/evaluate).
   * Defaults to a global-fetch JSON fetcher that resolves `undefined` on any
   * error, so a failed reload keeps the stale flag cache and never throws.
   */
  fetcher?: FlagsFetcher;
  /**
   * Track a `$feature_flag_called` event the first time each flag key/value is
   * read via getFeatureFlag()/isFeatureEnabled(). Deduped in memory per
   * identity session (cleared on identify()/reset()). Defaults to true.
   */
  sendExposureEvents?: boolean;
  /**
   * Flag persistence policy (see {@link FlagPersistenceMode}). Defaults to
   * `"persistenceUntilNetworkSuccess"`, which preserves the historical
   * behavior: a valid identity-scoped cache is served immediately until the
   * first successful network evaluation replaces it. The cache is keyed by
   * `distinct_id` and re-scoped on every identify()/reset().
   */
  flagPersistence?: FlagPersistenceMode;
  /**
   * How long a persisted flag cache stays valid, in ms. `networkFirst`
   * serves the cache only within this TTL; `persistenceUntilNetworkSuccess`
   * still serves an expired cache up to 7 days stale (the TTL bounds
   * freshness, not availability, under that policy). A legacy cache
   * without `stored_at` is never expired. Defaults to 86400000 (24 hours),
   * matching the Mixpanel flag-persistence reference TTL. Non-positive or
   * non-finite values fall back to the default.
   */
  flagCacheTtlMs?: number;
  /**
   * Release the app is running, stamped as `$exception_release` on every
   * exception (omitted when unset). Must be the release at crash time.
   */
  release?: string;
  /**
   * Distribution inside the release (OTA update id, build flavor), stamped
   * as `$exception_dist` on every exception (omitted when unset).
   */
  dist?: string;
  /**
   * App version stamped as `$app_version_string` on EVERY event, exceptions
   * included, unless the caller passed one. It is the denominator of
   * crash-free users, so it should come from the same version source as
   * `release`.
   */
  appVersion?: string;
  /**
   * Called with every fully built `$exception` event right before it is
   * queued. Return the event (possibly modified, e.g. scrubbed of PII) to
   * send it, or `null` to drop it. A hook that throws drops the exception:
   * an exception is never sent unscrubbed.
   */
  beforeSendException?: (event: TrackedEvent) => TrackedEvent | null;
  /**
   * Capacity of the exception queue, separate from the event queue. On
   * overflow the oldest non-fatal exception is dropped first. Defaults to 50.
   */
  maxExceptionQueueSize?: number;
  /**
   * Custom metrics (`client.metrics`). `flagKey` names the Cohorly feature
   * flag used as the remote kill switch (default `cohorly_metrics`).
   * `windowMs` and `maxSeries` exist for tests and tuning only: another
   * `windowMs` changes `metric_window_ms`, and the "1-minute" wording and the
   * cost estimate in the docs no longer hold.
   */
  metrics?: CohorlyMetricsOptions;
  /**
   * Set to `false` to turn exception capture off: `captureException()` and
   * `captureExceptionList()` queue nothing and return `null`. Ordinary events
   * are unaffected. Defaults to `true`.
   */
  captureExceptions?: boolean;
  /**
   * Called each time an event is built (every `track()`, internal events
   * such as `$feature_flag_called` and `$metric`, and `$exception`). Its keys
   * are stamped on the event unless the caller passed them. Used by platform
   * SDKs for per-event state such as the web `$session_id`. Receives the
   * event name. A hook that throws is ignored.
   */
  eventProperties?: (event: string) => Record<string, unknown>;
}

export interface CohorlyMetricsOptions {
  flagKey?: string;
  windowMs?: number;
  maxSeries?: number;
}

export interface PeopleProperties {
  set(props: Record<string, unknown>): Promise<void>;
  setOnce(props: Record<string, unknown>): Promise<void>;
  increment(props: Record<string, number>): Promise<void>;
  /**
   * Destructive: the server only honors $unset when the request carries an
   * admin credential (org owner / superadmin), which browser and mobile SDKs
   * authenticated by the public project token do not have. Called from a
   * client SDK this is a server-side no-op; remove properties from the
   * dashboard or a server-side integration instead.
   */
  unset(keys: string[]): Promise<void>;
  /** Destructive: same server-side credential requirement as `unset()`. */
  delete(): Promise<void>;
}
