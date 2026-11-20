import type { CohorlyMetricsOptions, TrackedEvent } from "@cohorly/core";
import type { SessionReplayOptions } from "./replay/options.js";

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
   * Custom metrics (`metrics.count/gauge/distribution`). `flagKey` names the
   * feature flag used as the remote kill switch (default `cohorly_metrics`);
   * `windowMs` and `maxSeries` exist for tests and tuning only.
   */
  metrics?: CohorlyMetricsOptions;
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
  /**
   * Error tracking switch, three states:
   * - `true`: capture uncaught JS errors (`ErrorUtils` global handler: fatal
   *   ones as `level: "fatal"`), unhandled promise rejections (Hermes), and
   *   record AppState and failed-fetch breadcrumbs.
   * - omitted: nothing global is touched; manual `captureException()` works.
   * - `false`: nothing global, and no `$exception` is sent, not even from a
   *   manual `captureException()`.
   * `optOutTracking()` blocks exceptions whatever this says.
   */
  captureExceptions?: boolean;
  /**
   * Release stamped as `$exception_release`, used exactly as given. Defaults
   * to `<bundleId>@<appVersion>+<appBuild>` (bundle id from
   * `expo-application` or `react-native-device-info`, else the lowercase
   * platform). Must equal the `--release` of `cohorly sourcemaps upload`.
   */
  release?: string;
  /**
   * Distribution inside the release, stamped as `$exception_dist`. Defaults
   * to the running `expo-updates` update id when the bundle is a downloaded
   * update (none for the embedded bundle). Must equal `--dist` of the upload.
   */
  dist?: string;
  /**
   * Called with every `$exception` event right before it is queued. Return
   * it (possibly scrubbed) to send it, or `null` to drop it; a hook that
   * throws drops the exception.
   */
  beforeSendException?: (event: TrackedEvent) => TrackedEvent | null;
  /** Capacity of the persisted exception queue (separate from events). Default 50. */
  maxExceptionQueueSize?: number;
  /**
   * Native crash reporting (ADR-0020): on iOS, signals, Mach exceptions,
   * NSExceptions and C++ exceptions recorded by KSCrash (in-process signal
   * handlers) and sent by native code on the next launch; on Android, the
   * native reporter. Needs the config plugin
   * (`["@cohorly/react-native", { projectToken, apiHost }]`). On iOS it also
   * turns on MetricKit diagnostics unless `metricKitDiagnostics` says
   * otherwise. The choice is written for the NEXT launch: turning it on takes
   * effect from the launch after the one that set it, and so does turning it
   * off. Change it after init with `setNativeCrashReporting()`.
   * `disabled`, `optOutTracking()` and `captureExceptions: false` keep it
   * off. Never enable it alongside another native crash handler (Sentry's
   * `enableNativeCrashHandling`). Default false.
   */
  nativeCrashReporting?: boolean;
  /**
   * MetricKit crash, hang and CPU diagnostics (iOS only; Android ignores it,
   * there `nativeCrashReporting` alone decides). Defaults to the value of
   * `nativeCrashReporting`, so both are off when neither is set.
   * - `nativeCrashReporting: false, metricKitDiagnostics: true`: MetricKit
   *   only. No signal handler is installed, so it can run alongside another
   *   native crash reporter (Sentry with `enableNativeCrashHandling: true`).
   *   Crashes KSCrash recorded on earlier launches are still sent.
   * - `nativeCrashReporting: true, metricKitDiagnostics: false`: KSCrash
   *   without MetricKit.
   * Written for the NEXT launch, like `nativeCrashReporting`, and kept off by
   * the same `disabled` / opt-out / `captureExceptions: false`. Change it
   * after init with `setNativeCrashReporting()`.
   */
  metricKitDiagnostics?: boolean;
  /**
   * Session replay (iOS; Android follows). Needs the native module, so an
   * app rebuilt with this version (not Expo Go). With a rate above 0 every
   * event, `$exception` included, carries `$session_id`; each new session is
   * drawn once: recorded whole (`sampleRate`), kept in memory for 30 to 60 s
   * and sent when the SDK captures an exception (`onErrorSampleRate`, of the
   * sessions not recorded whole), or not recorded. A session ends after more
   * than 30 min in background or without activity, after 24 h, and on
   * `reset()`. Wrap views that must never be recorded in `<CohorlyMask>`.
   * Off without this option or with both rates at 0.
   */
  sessionReplay?: SessionReplayOptions;
  /**
   * Send `$screen` with `$screen_name` (the React Navigation / expo-router
   * route name, never params) for the initial route and every route change
   * seen by `trackNavigation(navigationRef)`; it does nothing without that
   * call. Off by default. Each `$screen` is an ordinary event and counts
   * against the event quota like any `track()`. Session replay never turns
   * it on. Default `false`.
   */
  trackScreenViews?: boolean;
}

/**
 * Argument of `setNativeCrashReporting()`. An omitted (or `undefined`) key
 * keeps the current value; see `CohorlyOptions` for what each one means.
 */
export interface NativeCrashReportingOptions {
  nativeCrashReporting?: boolean;
  metricKitDiagnostics?: boolean;
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
