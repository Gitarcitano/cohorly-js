import type {
  BreadcrumbInput,
  CaptureExceptionOptions,
  MetricOptions,
  MetricTags,
} from "@cohorly/core";
import { CohorlyClient } from "./client.js";
import { teardownExceptionCapture } from "./exceptions/handlers.js";
import { type NavigationRefLike, watchNavigation } from "./exceptions/navigation.js";
import type {
  CohorlyOptions,
  FlagDetails,
  FlagResult,
  NativeCrashReportingOptions,
  Properties,
} from "./types.js";

export type {
  Breadcrumb,
  BreadcrumbInput,
  CaptureExceptionOptions,
  ExceptionLevel,
  ExceptionListEntry,
  ExceptionMechanism,
  ExceptionStackFrame,
  ExceptionStacktrace,
  MetricOptions,
  MetricTags,
  MetricType,
  TrackedEvent,
} from "@cohorly/core";
export {
  CohorlyErrorBoundary,
  type CohorlyErrorBoundaryFallbackProps,
  type CohorlyErrorBoundaryProps,
} from "./CohorlyErrorBoundary.js";
export { CohorlyClient, TransportError } from "./client.js";
export type { NavigationRefLike } from "./exceptions/navigation.js";
export { CohorlyMask, type CohorlyMaskProps } from "./replay/mask.js";
export type { SessionReplayMode, SessionReplayOptions } from "./replay/options.js";
export { InMemoryStorage } from "./storage.js";
export type {
  AppStateLike,
  AsyncStorageLike,
  CohorlyOptions,
  EngagePayload,
  FlagDetails,
  FlagPersistenceMode,
  FlagResult,
  FlagSource,
  NativeCrashReportingOptions,
  PlatformInfo,
  Properties,
  TrackEvent,
} from "./types.js";

let sharedInstance: CohorlyClient | null = null;

/** Initializes the shared Cohorly client. Call once near app startup, e.g.:
 *
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 * import { init } from "@cohorly/react-native";
 *
 * init({ apiHost: "https://cohorly-service.velloalabs.com", storage: AsyncStorage });
 * ```
 */
export function init(options: CohorlyOptions): CohorlyClient {
  // The previous client stops capturing (its handlers are restored first, so
  // the new client never wraps them).
  teardownExceptionCapture();
  // Two clients must not share the persisted exception queue.
  sharedInstance?.stop();
  sharedInstance = new CohorlyClient(options);
  return sharedInstance;
}

function client(): CohorlyClient {
  if (!sharedInstance) {
    throw new Error("Cohorly: call init() before using the SDK.");
  }
  return sharedInstance;
}

export function track(event: string, properties?: Properties): void {
  client().track(event, properties);
}

export function identify(distinctId: string): void {
  client().identify(distinctId);
}

export function reset(): void {
  client().reset();
}

export function register(properties: Properties): void {
  client().register(properties);
}

export function unregister(key: string): void {
  client().unregister(key);
}

export function getDistinctId(): string {
  return client().getDistinctId();
}

export function getDeviceId(): string {
  return client().getDeviceId();
}

export function flush(): Promise<void> {
  return client().flush();
}

export function timeEvent(event: string): void {
  client().timeEvent(event);
}

export function clearTimedEvent(event: string): void {
  client().clearTimedEvent(event);
}

export function clearTimedEvents(): void {
  client().clearTimedEvents();
}

/** Re-evaluate feature flags for the current distinct id. Never rejects. */
export function reloadFeatureFlags(): Promise<void> {
  return client().reloadFeatureFlags();
}

/** Variant key if the flag has one, else its enabled boolean; `fallback`
 * (default false) when unknown/not loaded. Fallback reads emit no exposure. */
export function getFeatureFlag(
  key: string,
  fallback?: boolean | string,
): boolean | string {
  return client().getFeatureFlag(key, fallback);
}

/** The flag's enabled boolean; `fallback` (default false) when
 * unknown/not loaded. Fallback reads emit no exposure. */
export function isFeatureEnabled(key: string, fallback?: boolean): boolean {
  return client().isFeatureEnabled(key, fallback);
}

/** The full result for one flag: value, enabled, payload, and `source`
 * ("network" | "persistence" | "fallback"), with `ttlMs` - and
 * `persistedAt` when the cache carries a write timestamp - when served
 * from the persisted cache. */
export function getFeatureFlagDetails(
  key: string,
  fallback?: boolean | string,
): FlagDetails {
  return client().getFeatureFlagDetails(key, fallback);
}

export function getFeatureFlagPayload(key: string): unknown | null {
  return client().getFeatureFlagPayload(key);
}

/**
 * Subscribe to flag updates. Fires after every successful reload, and
 * immediately if flags are already loaded. Returns an unsubscribe function.
 */
export function onFeatureFlags(
  cb: (flags: Record<string, FlagResult>) => void,
): () => void {
  return client().onFeatureFlags(cb);
}

export const people = {
  set: (properties: Properties): void => client().people.set(properties),
  setOnce: (properties: Properties): void => client().people.setOnce(properties),
  increment: (properties: Properties): void => client().people.increment(properties),
  unset: (keys: string[]): void => client().people.unset(keys),
  deleteUser: (): void => client().people.deleteUser(),
};

/**
 * Custom metrics (see `CohorlyClient.metrics`): samples are aggregated into one
 * `$metric` event per metric and tag combination per window. No-ops before
 * init(); never throws.
 */
export const metrics = {
  count: (name: string, value?: number, tagsOrOptions?: MetricTags | MetricOptions): void =>
    sharedInstance?.metrics.count(name, value, tagsOrOptions),
  gauge: (name: string, value: number, tagsOrOptions?: MetricTags | MetricOptions): void =>
    sharedInstance?.metrics.gauge(name, value, tagsOrOptions),
  distribution: (
    name: string,
    value: number,
    tagsOrOptions?: MetricTags | MetricOptions,
  ): void => sharedInstance?.metrics.distribution(name, value, tagsOrOptions),
  /** Queues the pending window now; `flush()` sends it. */
  flush: (): void => sharedInstance?.metrics.flush(),
};

/**
 * Queue a `$exception` event for anything thrown (see
 * `CohorlyClient.captureException`). A no-op before init(); never throws.
 */
export function captureException(error: unknown, options?: CaptureExceptionOptions): void {
  sharedInstance?.captureException(error, options);
}

/**
 * Stop collecting on this device (persisted); see
 * `CohorlyClient.optOutTracking`. A no-op before init() (like
 * `captureException`), so call it after init().
 */
export function optOutTracking(): void {
  sharedInstance?.optOutTracking();
}

/**
 * Resume collecting after `optOutTracking()`. Discarded data is not restored.
 * A no-op before init().
 */
export function optInTracking(): void {
  sharedInstance?.optInTracking();
}

/** Whether `optOutTracking()` is in force. `false` before init(). */
export function hasOptedOutTracking(): boolean {
  return sharedInstance?.hasOptedOutTracking() ?? false;
}

/**
 * Whether exceptions would be recorded now: the persisted opt-out was read
 * and says "in", and `captureExceptions` is not `false`. `false` before
 * init() and until the hydration of the persisted state finishes, so a device
 * with a saved opt-out never reads `true` at startup. Use it as the `enabled`
 * flag of a native crash reporter, and re-send that configuration whenever
 * `onExceptionCaptureChange` fires.
 */
export function isExceptionCaptureEnabled(): boolean {
  return sharedInstance?.isExceptionCaptureEnabled() ?? false;
}

/**
 * Calls `listener(enabled)` whenever `isExceptionCaptureEnabled()` changes:
 * when the hydration finishes (if it turns `true`), and on
 * `optOutTracking()` / `optInTracking()`. Not called on subscribe. Native
 * crash reporter configuration must be re-sent from here. Returns the
 * unsubscribe. Before init() it subscribes to nothing and returns a no-op
 * unsubscribe, so subscribe after init(); a later init() starts a new client
 * that does not carry the listener over.
 */
export function onExceptionCaptureChange(listener: (enabled: boolean) => void): () => void {
  return sharedInstance?.onExceptionCaptureChange(listener) ?? (() => {});
}

/**
 * Changes `nativeCrashReporting` / `metricKitDiagnostics` for the NEXT
 * launch, e.g. after feature flags load; an omitted key keeps its value. See
 * `CohorlyClient.setNativeCrashReporting`. A no-op before init(), so call it
 * after init().
 */
export function setNativeCrashReporting(options: NativeCrashReportingOptions): void {
  sharedInstance?.setNativeCrashReporting(options);
}

/** Record a breadcrumb sent with the next exceptions. A no-op before init(); never throws. */
export function addBreadcrumb(crumb: BreadcrumbInput): void {
  sharedInstance?.addBreadcrumb(crumb);
}

/**
 * Records a `navigation` breadcrumb ("Home -> Cart", route names only, never
 * params) on every route change of a React Navigation or expo-router
 * container ref. Returns the unsubscribe.
 *
 * ```ts
 * const navigationRef = useNavigationContainerRef();
 * useEffect(() => trackNavigation(navigationRef), [navigationRef]);
 * ```
 */
export function trackNavigation(navigationRef: NavigationRefLike | null | undefined): () => void {
  return watchNavigation(navigationRef, addBreadcrumb);
}
