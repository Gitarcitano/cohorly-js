export type Properties = Record<string, unknown>;

/** Minimal AsyncStorage-compatible interface. Matches
 * `@react-native-async-storage/async-storage`'s default export shape,
 * so it can be passed in directly without this package depending on it. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Device/platform info merged into every event's default properties. When
 * `options.platformInfo` is not provided, the client tries to derive this
 * lazily (and safely) from `react-native`'s `Platform`/`Dimensions` modules;
 * any field left undefined (e.g. because react-native isn't present, as in
 * plain Node/vitest) is simply omitted from the event properties.
 */
export interface PlatformInfo {
  /** Mapped from `Platform.OS`: "iOS" for "ios", "Android" for "android",
   * otherwise passed through as-is. */
  os?: string;
  /** `Platform.Version`. */
  osVersion?: string | number;
  /** `Dimensions.get("screen").height`. */
  screenHeight?: number;
  /** `Dimensions.get("screen").width`. */
  screenWidth?: number;
  /** Device model. Auto-derived when `react-native-device-info` or
   * `expo-device` is installed; an explicit value here always wins. */
  model?: string;
  /** Device manufacturer. Auto-derived when `react-native-device-info` or
   * `expo-device` is installed (always `"Apple"` on iOS); an explicit value
   * here always wins. */
  manufacturer?: string;
  /** Device brand (Android only). Auto-derived when `react-native-device-info`
   * or `expo-device` is installed; an explicit value here always wins. */
  brand?: string;
  /** Mobile carrier name. Auto-derived when `react-native-device-info` is
   * installed; an explicit value here always wins. */
  carrier?: string;
  /** Wifi connectivity. Auto-derived when `@react-native-community/netinfo`
   * is installed; an explicit value here always wins. */
  wifi?: boolean;
}

/** Minimal `AppState`-compatible interface (matches React Native's `AppState`
 * shape) so tests and non-RN environments can inject a fake implementation. */
export interface AppStateLike {
  addEventListener(event: "change", callback: (state: string) => void): unknown;
  currentState?: string;
}

export interface CohorlyOptions {
  /**
   * Base URL of the Cohorly ingestion API. Defaults to the hosted endpoint
   * (`https://cohorly-service.velloalabs.com`); only set this to point at a
   * different deployment.
   */
  apiHost?: string;
  /** Injected AsyncStorage-like implementation. Defaults to an in-memory store. */
  storage?: AsyncStorageLike;
  /** Flush queue after this many ms. Default 5000. */
  flushInterval?: number;
  /** Flush queue once it reaches this many events. Default 20. */
  flushAt?: number;
  /** Custom fetch implementation, mainly for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Disable all network calls (still queues + persists). Useful for tests. */
  disabled?: boolean;
  /**
   * Project token. When set, stamped on every tracked event's properties and
   * included as a top-level `token` field on every /engage body, so the
   * server can route data to the right project.
   */
  token?: string;
  /** Max events retained in the persisted queue (drop oldest on overflow). Default 1000. */
  maxQueueSize?: number;
  /** Upper bound on retry backoff delay, in ms. Default 600000 (10 min). */
  maxRetryDelayMs?: number;
  /** App version string, sent as `$app_version_string` and used to detect
   * `$ae_updated`. Auto-derived when `react-native-device-info` or
   * `expo-application` is installed; an explicit value here always wins. */
  appVersion?: string;
  /** App build number/string, sent as `$app_build_number`. Auto-derived when
   * `react-native-device-info` or `expo-application` is installed; an
   * explicit value here always wins. */
  appBuild?: string;
  /** When true, tracks `$ae_first_open`, `$ae_updated`, and `$ae_session`
   * automatic lifecycle events. Default false (opt-in). */
  trackAutomaticEvents?: boolean;
  /** Static device/platform info to merge into default properties, bypassing
   * the lazy `react-native` require. Mainly for tests and non-RN callers. */
  platformInfo?: PlatformInfo;
  /** Injected `AppState`-like implementation. Defaults to lazily requiring
   * `react-native`'s `AppState`. Mainly for tests and non-RN callers. */
  appState?: AppStateLike;
  /**
   * Evaluate feature flags on init (POST /flags/evaluate for the current
   * distinct id), once persisted state has hydrated. Default true; set false
   * to call `reloadFeatureFlags()` yourself.
   */
  loadFeatureFlags?: boolean;
  /**
   * Track a `$feature_flag_called` event the first time each flag key/value is
   * read via `getFeatureFlag()`/`isFeatureEnabled()`. Deduped in memory per
   * identity session (cleared on identify()/reset()). Default true.
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
}

/**
 * Result of evaluating one feature flag for a distinct id, as returned by
 * POST /flags/evaluate. Copied to keep this package standalone (see repo
 * CLAUDE.md "Ownership" convention).
 */
export interface FlagResult {
  enabled: boolean;
  variant: string | null;
  payload: unknown | null;
  reason: string;
}

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

export interface TrackEvent {
  event: string;
  properties: Properties & {
    distinct_id: string;
    time: number;
    $insert_id: string;
    $lib: string;
  };
}

export interface EngagePayload {
  distinct_id: string;
  $set?: Properties;
  $set_once?: Properties;
  $add?: Properties;
  $unset?: string[];
  $delete?: boolean;
  token?: string;
}
