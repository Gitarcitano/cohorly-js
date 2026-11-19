import type {
  BreadcrumbInput,
  CaptureExceptionOptions,
  ExceptionListEntry,
  FlagDetails,
  FlagPersistenceMode,
  FlagResult,
  MetricOptions,
  MetricTags,
  PeopleProperties,
  TrackedEvent,
} from "@cohorly/core";
import { buildExceptionList, CohorlyClient, fetchTransport } from "@cohorly/core";
import { getAttributionProperties, initAttribution } from "./attribution.js";
import type { AutocaptureConfig, AutocaptureOption } from "./autocapture.js";
import { setupAutocapture } from "./autocapture.js";
import { beaconTransport } from "./beacon.js";
import { getDefaultProperties } from "./defaults.js";
import type { ErrorSource } from "./exceptions.js";
import {
  allowException,
  isCrossSourceDuplicate,
  isGlobalRepeatInSameRun,
  markExceptionQueued,
  resetExceptionRateLimit,
  setupExceptionCapture,
} from "./exceptions.js";
import {
  getPageviewProperties,
  PAGEVIEW_EVENT,
  setupPageviewAutotrack,
} from "./pageview.js";
import type { IframeRelay } from "./replay/relay.js";
import { normalizeIframeOrigins, startIframeRelay } from "./replay/relay.js";
import type { ReplayController, SessionReplayOptions } from "./replay/session.js";
import { replayWanted, SESSION_KEY, startSessionReplay } from "./replay/session.js";
import { localStorageAdapter, sessionStorageAdapter } from "./storage.js";

export interface CohorlyWebOptions {
  /**
   * Base URL of the Cohorly ingestion API. Defaults to the hosted endpoint
   * (`https://cohorly-service.velloalabs.com`); only set this to point at a
   * different deployment.
   */
  apiHost?: string;
  flushIntervalMs?: number;
  batchSize?: number;
  debug?: boolean;
  /** Track a `$mp_web_page_view` event on init and on SPA route changes. */
  trackPageviews?: boolean;
  /**
   * Opt-in DOM autocapture (`$mp_click`/`$mp_submit`/`$mp_scroll`). Default off.
   * Pass `true` to enable all, or an object to fine-tune. Input values are never
   * captured; element text only when `captureTextContent` is set.
   */
  autocapture?: AutocaptureOption;
  /** Registered as super properties immediately after init. */
  superProperties?: Record<string, unknown>;
  /**
   * Project token. When set, stamped on every tracked event's properties and
   * included in every /engage and /alias body so the server can route data
   * to the right project.
   */
  token?: string;
  /**
   * Load feature flags on init (POST /flags/evaluate for the current
   * distinct id). Default true; pass false to opt out and call
   * `reloadFeatureFlags()` yourself.
   */
  loadFeatureFlags?: boolean;
  /**
   * Track a `$feature_flag_called` event the first time each flag key/value is
   * read via `getFeatureFlag()`/`isFeatureEnabled()`. Deduped per identity
   * session (cleared on identify()/reset()). Default true.
   */
  sendExposureEvents?: boolean;
  /**
   * Flag persistence policy: "networkOnly" never touches the persisted
   * cache, "networkFirst" serves a still-valid identity-scoped cache
   * (strictly within `flagCacheTtlMs`), and
   * "persistenceUntilNetworkSuccess" serves it until the first successful
   * network evaluation replaces it - still serving an expired cache up to
   * 7 days stale. Default "persistenceUntilNetworkSuccess".
   */
  flagPersistence?: FlagPersistenceMode;
  /**
   * How long the persisted flag cache stays valid, in ms. Bounds strict
   * serving under "networkFirst"; under "persistenceUntilNetworkSuccess" an
   * expired cache still serves up to 7 days stale. Legacy caches without a
   * write timestamp never expire. Default 86400000 (24 hours).
   */
  flagCacheTtlMs?: number;
  /** Max events retained in the persisted queue (drop oldest on overflow). Default 1000. */
  maxQueueSize?: number;
  /** Upper bound on retry backoff delay, in ms. Default 600000 (10 min). */
  maxRetryDelayMs?: number;
  /**
   * Error tracking switch, three states:
   * - `true`: unhandled errors and promise rejections are captured as fatal
   *   `$exception` events, with automatic breadcrumbs (navigation, clicks,
   *   `console.error`, failed fetches and XHRs). An error with the same type,
   *   message and crashing frame seen by a global handler and by
   *   `captureException()` within 1 second is sent once (React 18 in dev
   *   re-reports a caught render error to `window`; the global one is kept).
   * - omitted: no global handlers; manual `captureException()` works.
   * - `false`: no global handlers and no `$exception` leaves the page, not
   *   even from a manual `captureException()`.
   * Opting out with `optOutTracking()` blocks exceptions whatever this says.
   */
  captureExceptions?: boolean;
  /**
   * The release this build is, e.g. `"web@2026.11.3"`. Stamped as
   * `$exception_release` on every exception AND as `$app_version_string`
   * on every event, so crash-free users by release compares one version
   * source on both sides.
   */
  release?: string;
  /** Distribution inside the release (e.g. the build hash), sent as `$exception_dist`. */
  dist?: string;
  /**
   * Called with every `$exception` event before it is queued: return it
   * (possibly scrubbed) to send it, or `null` to drop it. A hook that throws
   * drops the exception.
   */
  beforeSendException?: (event: TrackedEvent) => TrackedEvent | null;
  /** Capacity of the exception queue (oldest non-fatal dropped first). Default 50. */
  maxExceptionQueueSize?: number;
  /**
   * Custom metrics options. `flagKey` is the feature flag that works as the
   * kill switch (default `"cohorly_metrics"`): inactive or 0% turns metrics
   * off and drops the pending window; a missing flag means on.
   */
  metrics?: { flagKey?: string };
  /**
   * Session replay with rrweb (loaded on demand, only when this session
   * records). `sampleRate` records whole sessions; `onErrorSampleRate` keeps
   * the last 30 to 60 seconds in memory and sends them when an exception is
   * captured (needs `captureExceptions` or `captureException()`). Inputs are always masked, `[data-cohorly-mask]` text is masked
   * and `[data-cohorly-block]` elements are never recorded. When set (with a
   * rate above 0), every event carries `$session_id`. `allowedIframeOrigins`
   * records cross-origin iframes that run the SDK and list this page back.
   */
  sessionReplay?: SessionReplayOptions;
}

/**
 * Custom metrics (see `CohorlyClient.metrics`): samples are aggregated into one
 * `$metric` event per metric and tag combination per window. Unlike the rest of
 * `cohorly`, these are no-ops before `init()` and never throw. The pending
 * window is queued on `pagehide` and when the page becomes hidden, and sent by
 * beacon when the queue allows it; what stays behind goes out on the next visit.
 */
export interface CohorlyMetrics {
  count(name: string, value?: number, tagsOrOptions?: MetricTags | MetricOptions): void;
  gauge(name: string, value: number, tagsOrOptions?: MetricTags | MetricOptions): void;
  distribution(name: string, value: number, tagsOrOptions?: MetricTags | MetricOptions): void;
  /** Queues the pending window now; `flush()` sends it. */
  flush(): void;
}

export interface Cohorly {
  /** Custom metrics. No-op before `init()`, never throws. */
  metrics: CohorlyMetrics;
  track(event: string, properties?: Record<string, unknown>): void;
  identify(id: string): Promise<void>;
  reset(): void;
  register(props: Record<string, unknown>): void;
  unregister(key: string): void;
  /** Start a timer; the next `track()` of the same name attaches `$duration` (seconds). */
  timeEvent(event: string): void;
  /** Cancel a pending timed event. */
  clearTimedEvent(event: string): void;
  /** Cancel all pending timed events. */
  clearTimedEvents(): void;
  people: PeopleProperties;
  flush(): Promise<void>;
  getDistinctId(): string;
  isAnonymous(): boolean;
  /** Re-evaluate feature flags for the current distinct id. Never rejects. */
  reloadFeatureFlags(): Promise<void>;
  /**
   * Variant key if the flag has one, else its enabled boolean; `fallback`
   * (default false) when unknown/not loaded. Fallback reads emit no exposure.
   */
  getFeatureFlag(key: string, fallback?: boolean | string): boolean | string;
  /**
   * The flag's enabled boolean; `fallback` (default false) when
   * unknown/not loaded. Fallback reads emit no exposure.
   */
  isFeatureEnabled(key: string, fallback?: boolean): boolean;
  /**
   * The full result for one flag: value, enabled, payload, and `source`
   * ("network" | "persistence" | "fallback"), with `ttlMs` - and
   * `persistedAt` when the cache carries a write timestamp - when served
   * from the persisted cache.
   */
  getFeatureFlagDetails(
    key: string,
    fallback?: boolean | string,
  ): FlagDetails;
  getFeatureFlagPayload(key: string): unknown | null;
  /**
   * Whether a flag set is currently being served. Goes back to false on
   * identify()/reset() until the new identity's flags land.
   */
  areFeatureFlagsLoaded(): boolean;
  /**
   * Subscribe to flag updates. Fires whenever the served flag set changes:
   * after every successful reload, when identify()/reset() clears the
   * outgoing identity's flags (with an empty map), and immediately if flags
   * are already loaded. Returns an unsubscribe function.
   */
  onFeatureFlags(cb: (flags: Record<string, FlagResult>) => void): () => void;
  /**
   * Queue a `$exception` event for anything thrown, with the same default
   * properties as `track()` plus the current breadcrumbs. Returns the queued
   * event, or `null` when it was dropped (`beforeSendException`, or more
   * than 10 identical exceptions within 60s).
   */
  captureException(error: unknown, options?: CaptureExceptionOptions): TrackedEvent | null;
  /** Record a breadcrumb; the last 50 travel with every exception. */
  addBreadcrumb(crumb: BreadcrumbInput): void;
  /**
   * Stop collecting on this browser: persisted, drops everything queued, and
   * nothing (events, people, alias, exceptions) is sent until optInTracking().
   */
  optOutTracking(): void;
  /** Resume after optOutTracking(). Discarded data is not restored. */
  optInTracking(): void;
  hasOptedOutTracking(): boolean;
}

/**
 * Platform profile defaults auto-merged into every `people.set`/`setOnce`
 * (Mixpanel parity): device (`$os`/`$browser`/`$browser_version`) plus persisted
 * first-touch `$initial_referrer`/`$initial_referring_domain`. User-supplied keys
 * always win. Empty during SSR / before any first-touch is recorded.
 */
export function getProfileDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const device = getDefaultProperties();
  for (const key of ["$os", "$browser", "$browser_version"] as const) {
    if (device[key] !== undefined) out[key] = device[key];
  }
  const attribution = getAttributionProperties(localStorageAdapter);
  for (const key of ["$initial_referrer", "$initial_referring_domain"] as const) {
    if (attribution[key] !== undefined) out[key] = attribution[key];
  }
  return out;
}

let activeClient: CohorlyClient | null = null;
let debugEnabled = false;
let exceptionTeardown: (() => void) | null = null;
let replayController: ReplayController | null = null;
/** Child-frame side of cross-origin iframe recording (VEL-2152). */
let iframeRelay: IframeRelay | null = null;
/** The child's own recording is suspended while its parent records this frame. */
let ownReplaySuspended = false;

function ensureClient(): CohorlyClient {
  if (!activeClient) {
    throw new Error(
      "[cohorly] cohorly.* called before init(). Call init({ apiHost }) first.",
    );
  }
  return activeClient;
}

/**
 * The single path every web exception takes: the cross-source dedup, the local rate limit, then the
 * same default properties as track(), then the core client.
 */
function captureExceptionList(
  list: ExceptionListEntry[],
  options: CaptureExceptionOptions = {},
  source: ErrorSource = "manual",
): TrackedEvent | null {
  const client = ensureClient();
  // Before the rate limit: a duplicate must not use up the quota of 10.
  if (
    (source === "global" && isGlobalRepeatInSameRun(list)) ||
    isCrossSourceDuplicate(list, source)
  ) {
    if (debugEnabled) {
      console.warn("[cohorly] dropping an exception just captured from the other source");
    }
    return null;
  }
  if (!allowException(list)) {
    if (debugEnabled) {
      console.warn("[cohorly] dropping a repeated exception (local rate limit)");
    }
    return null;
  }
  const queued = client.captureExceptionList(list, {
    ...options,
    properties: {
      ...getDefaultProperties(),
      ...getAttributionProperties(localStorageAdapter),
      ...options.properties,
    },
  });
  // Only what was really queued anchors the window: an exception dropped by
  // beforeSendException must not swallow the same error from the other source.
  if (queued) {
    markExceptionQueued(list, source);
    replayController?.onException();
  }
  return queued;
}

/** Named singleton, usable as `import { cohorly } from "@cohorly/web"` after init(). */
export const cohorly: Cohorly = {
  metrics: {
    count: (name, value, tagsOrOptions) => activeClient?.metrics.count(name, value, tagsOrOptions),
    gauge: (name, value, tagsOrOptions) => activeClient?.metrics.gauge(name, value, tagsOrOptions),
    distribution: (name, value, tagsOrOptions) =>
      activeClient?.metrics.distribution(name, value, tagsOrOptions),
    flush: () => activeClient?.metrics.flush(),
  },
  track(event, properties = {}) {
    ensureClient().track(event, {
      ...getDefaultProperties(),
      ...getAttributionProperties(localStorageAdapter),
      ...properties,
    });
  },
  identify(id) {
    return ensureClient().identify(id);
  },
  reset() {
    const client = ensureClient();
    // Replay first: its pending chunk still belongs to the outgoing identity.
    replayController?.reset();
    // Suspended by an iframe relay: the resumed recording must not continue the outgoing identity's session.
    if (ownReplaySuspended) sessionStorageAdapter.remove(SESSION_KEY);
    client.reset();
  },
  register(props) {
    ensureClient().register(props);
  },
  unregister(key) {
    ensureClient().unregister(key);
  },
  timeEvent(event) {
    ensureClient().timeEvent(event);
  },
  clearTimedEvent(event) {
    ensureClient().clearTimedEvent(event);
  },
  clearTimedEvents() {
    ensureClient().clearTimedEvents();
  },
  people: {
    // $set / $set_once auto-merge platform profile defaults; caller keys win.
    set: (props) => ensureClient().people.set({ ...getProfileDefaults(), ...props }),
    setOnce: (props) =>
      ensureClient().people.setOnce({ ...getProfileDefaults(), ...props }),
    increment: (props) => ensureClient().people.increment(props),
    unset: (keys) => ensureClient().people.unset(keys),
    delete: () => ensureClient().people.delete(),
  },
  flush() {
    return ensureClient().flush();
  },
  getDistinctId() {
    return ensureClient().getDistinctId();
  },
  isAnonymous() {
    return ensureClient().isAnonymous();
  },
  reloadFeatureFlags() {
    return ensureClient().reloadFeatureFlags();
  },
  getFeatureFlag(key, fallback) {
    return ensureClient().getFeatureFlag(key, fallback);
  },
  isFeatureEnabled(key, fallback) {
    return ensureClient().isFeatureEnabled(key, fallback);
  },
  getFeatureFlagDetails(key, fallback) {
    return ensureClient().getFeatureFlagDetails(key, fallback);
  },
  getFeatureFlagPayload(key) {
    return ensureClient().getFeatureFlagPayload(key);
  },
  areFeatureFlagsLoaded() {
    return ensureClient().areFeatureFlagsLoaded();
  },
  onFeatureFlags(cb) {
    return ensureClient().onFeatureFlags(cb);
  },
  captureException(error, options = {}) {
    ensureClient();
    let list: ExceptionListEntry[];
    try {
      list = buildExceptionList(error, {
        handled: options.mechanism?.handled ?? true,
        type: options.mechanism?.type ?? "generic",
      });
    } catch {
      return null;
    }
    return captureExceptionList(list, options, "manual");
  },
  addBreadcrumb(crumb) {
    ensureClient().addBreadcrumb(crumb);
  },
  optOutTracking() {
    ensureClient().optOutTracking();
    // Recording does not resume on optInTracking(), only on the next init().
    replayController?.optOut();
    replayController = null;
    iframeRelay?.dispose();
    iframeRelay = null;
    if (ownReplaySuspended) {
      ownReplaySuspended = false;
      // The suspended recorder handed its queue on for the resume: opt-out drops it instead.
      void import("./replay/replay.js").then((mod) => mod.discardHandoff()).catch(() => {});
    }
  },
  optInTracking() {
    ensureClient().optInTracking();
  },
  hasOptedOutTracking() {
    return ensureClient().hasOptedOutTracking();
  },
};

let unloadTeardown: (() => void) | null = null;

function setupUnloadFlush(client: CohorlyClient): () => void {
  if (typeof window === "undefined") return () => {};
  const flushWithBeacon = () => {
    // Fatal exceptions first, past any fetch flush still in flight: a crash
    // that just happened is the one thing a closing page must not lose.
    client.flushExceptions(beaconTransport, { fatalOnly: true }).catch(() => {
      /* best effort during teardown */
    });
    client.metrics.flush();
    client.flush(beaconTransport).catch(() => {
      /* best effort during teardown */
    });
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") flushWithBeacon();
  };
  window.addEventListener("pagehide", flushWithBeacon);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("pagehide", flushWithBeacon);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/** Initialize the web SDK. Safe to call during SSR (falls back to no-op browser APIs). */
export function init(options: CohorlyWebOptions): Cohorly {
  // A second init() replaces the client: the old one must stop flushing and
  // unloading, or it would overwrite the queues the new client persisted.
  activeClient?.stop();
  unloadTeardown?.();
  unloadTeardown = null;
  replayController?.stop();
  replayController = null;
  iframeRelay?.dispose();
  iframeRelay = null;
  ownReplaySuspended = false;
  activeClient = new CohorlyClient({
    apiHost: options.apiHost,
    storage: localStorageAdapter,
    transport: fetchTransport,
    flushIntervalMs: options.flushIntervalMs,
    batchSize: options.batchSize,
    debug: options.debug,
    lib: "web",
    token: options.token,
    maxQueueSize: options.maxQueueSize,
    maxRetryDelayMs: options.maxRetryDelayMs,
    sendExposureEvents: options.sendExposureEvents,
    flagPersistence: options.flagPersistence,
    flagCacheTtlMs: options.flagCacheTtlMs,
    release: options.release,
    appVersion: options.release,
    dist: options.dist,
    beforeSendException: options.beforeSendException,
    maxExceptionQueueSize: options.maxExceptionQueueSize,
    captureExceptions: options.captureExceptions,
    metrics: options.metrics,
    // $session_id while session replay is on (the controller of THIS init).
    eventProperties: (event) => replayController?.eventProperties(event) ?? {},
  });
  debugEnabled = options.debug ?? false;

  if (options.superProperties) {
    activeClient.register(options.superProperties);
  }

  // Attribution: register UTM super props + persist first-touch (before any
  // event fires so pageviews carry the attribution props).
  initAttribution(localStorageAdapter, {
    register: (props) => activeClient?.register(props),
    setOnce: (props) => activeClient?.people.setOnce(props),
  });

  unloadTeardown = setupUnloadFlush(activeClient);

  exceptionTeardown?.();
  exceptionTeardown = null;
  resetExceptionRateLimit();
  if (options.captureExceptions === true) {
    exceptionTeardown = setupExceptionCapture({
      capture: (list, captureOptions) => {
        captureExceptionList(list, captureOptions, "global");
      },
      addBreadcrumb: (crumb) => activeClient?.addBreadcrumb(crumb),
      apiHost: activeClient.getApiHost(),
    });
  }

  // After the exception capture: both share one fetch/XHR wrapper (network.ts).
  // Opted out at init: rrweb is never loaded.
  if (options.sessionReplay && !activeClient.hasOptedOutTracking()) {
    const client = activeClient;
    const replayLog = (...args: unknown[]) => {
      if (debugEnabled) console.warn("[cohorly]", ...args);
    };
    const replayOptions = {
      ...options.sessionReplay,
      allowedIframeOrigins: normalizeIframeOrigins(options.sessionReplay.allowedIframeOrigins, replayLog),
    };
    const startOwnReplay = () => {
      if (!replayWanted(replayOptions)) return;
      replayController = startSessionReplay(replayOptions, {
        apiHost: client.getApiHost(),
        token: options.token,
        localStorage: localStorageAdapter,
        sessionStorage: sessionStorageAdapter,
        maxRetryDelayMs: options.maxRetryDelayMs ?? 600_000,
        getDistinctId: () => client.getDistinctId(),
        log: replayLog,
        random: Math.random,
        // replay.ts, the sender and rrweb load only when a session records.
        loadReplay: () => import("./replay/replay.js"),
      });
    };
    startOwnReplay();
    // In a cross-origin iframe whose parent lists this origin (and this page
    // lists the parent's): the parent records this frame on request. Not
    // gated by the rates, and no rrweb until the parent asks.
    iframeRelay = startIframeRelay({
      options: replayOptions,
      origins: replayOptions.allowedIframeOrigins,
      load: () => import("./replay/replay.js"),
      suspend: () => {
        ownReplaySuspended = replayController !== null;
        replayController?.stop();
        replayController = null;
      },
      resume: () => {
        const resume = ownReplaySuspended;
        ownReplaySuspended = false;
        if (resume && activeClient === client && !client.hasOptedOutTracking()) startOwnReplay();
      },
      log: replayLog,
    });
  }

  const autocapture = setupAutocapture(
    (event, props) => cohorly.track(event, props),
    options.autocapture,
  );

  const trackPageview = () =>
    cohorly.track(PAGEVIEW_EVENT, getPageviewProperties());

  if (options.trackPageviews) trackPageview();

  if (options.trackPageviews || autocapture) {
    setupPageviewAutotrack(() => {
      autocapture?.resetScroll();
      if (options.trackPageviews) trackPageview();
    });
  }

  // Feature flags: kick off the first evaluation (default on). Fire and
  // forget - reloadFeatureFlags never rejects.
  if (options.loadFeatureFlags !== false) {
    void activeClient.reloadFeatureFlags();
  }

  return cohorly;
}

export type {
  Breadcrumb,
  BreadcrumbInput,
  CaptureExceptionOptions,
  CohorlyClientOptions,
  CohorlyStorage,
  CohorlyTransport,
  EngageOp,
  ExceptionLevel,
  ExceptionListEntry,
  ExceptionMechanism,
  ExceptionStackFrame,
  ExceptionStacktrace,
  FlagDetails,
  FlagPersistenceMode,
  FlagResult,
  FlagSource,
  FlagsFetcher,
  FlushExceptionsOptions,
  MetricOptions,
  MetricTags,
  MetricType,
  PeopleProperties,
  TrackedEvent,
} from "@cohorly/core";
export { CohorlyClient, TransportError } from "@cohorly/core";
export {
  CAMPAIGN_PARAMS,
  getAttributionProperties,
  parseReferrer,
  parseUtm,
  referringDomain,
  UTM_PARAMS,
} from "./attribution.js";
export { getDefaultProperties } from "./defaults.js";
export {
  CROSS_SOURCE_DEDUP_WINDOW_MS,
  EXCEPTION_DEDUP_WINDOW_MS,
  MAX_EXCEPTIONS_PER_FINGERPRINT,
} from "./exceptions.js";
export { getPageviewProperties, PAGEVIEW_EVENT } from "./pageview.js";
export type { SessionReplayOptions } from "./replay/session.js";
export type { AutocaptureConfig, AutocaptureOption };
