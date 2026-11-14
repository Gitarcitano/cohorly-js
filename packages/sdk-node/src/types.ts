import type { CaptureExceptionOptions as CoreCaptureExceptionOptions } from "@cohorly/core";

/**
 * Ingestion contract shapes, copied from apps/server/src/types.ts to keep
 * this package standalone (see repo CLAUDE.md "Ownership" convention).
 */
export type Properties = Record<string, unknown>;

/** Node-style callback: called with no args on success, an Error on failure. */
export type Callback = (err?: Error) => void;

/** A fully-stamped event as sent to POST /track. */
export interface TrackEvent {
  event: string;
  properties: Properties & {
    distinct_id: string;
    time: number; // unix ms
    $insert_id: string;
    $lib: string;
    $lib_version: string;
  };
}

/** Caller-supplied event for trackBatch/importBatch (before stamping). */
export interface BatchEventInput {
  event: string;
  properties: Properties & { distinct_id: string };
}

/** Body shape for POST /engage. */
export interface EngagePayload {
  distinct_id: string;
  $set?: Properties;
  $set_once?: Properties;
  $add?: Record<string, number>;
  /**
   * Destructive: the server refuses this op unless the request also carries an
   * admin credential (superadmin key, or an account token for an org owner) in
   * the Authorization header, which this SDK does not send. Refused ops are
   * skipped individually and the server answers HTTP 200 with
   * `{ status: 0, ..., refused }`.
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

/** Node-style value callback: (err, result). `err` is undefined on success. */
export type FlagsCallback<T> = (err: Error | undefined, result?: T) => void;

/** One variant of a multivariate flag (copied shape, see "Ownership"). */
export interface FlagVariant {
  key: string;
  payload?: unknown;
  rolloutPct: number;
}

/** One targeting rule; ordered within the flag, first match wins. */
export interface FlagRule {
  /** Cohort reference. Its presence makes the whole flag non-locally-evaluable. */
  cohortId?: number;
  /** Override: explicit allow-list of distinct ids. */
  distinctIds?: string[];
  rolloutPct: number;
  variant?: string;
}

/**
 * One flag as served by GET /flags/local-evaluation (ADR-0011).
 * `localEvaluable: false` means the flag references a Cohort and MUST be
 * evaluated remotely - never locally.
 */
export interface FlagDefinition {
  key: string;
  name: string;
  active: boolean;
  variants: FlagVariant[];
  rules: FlagRule[];
  localEvaluable: boolean;
}

/** Per-call options for the flag methods. */
export interface FlagCallOptions {
  /**
   * Track a `$feature_flag_called` event for this read (opt-in, per call).
   * Goes through the normal batching queue. Never sent by getAllFlags.
   */
  sendExposureEvent?: boolean;
}

/**
 * Fetcher abstraction for endpoints that return a JSON body (flags): POSTs
 * `body` as JSON to `url` with `headers` and resolves the parsed response.
 * Must throw a TransportError on non-2xx responses. Injected in tests.
 */
export type CohorlyFetcher = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
) => Promise<unknown>;

/**
 * GET fetcher for flag definitions: GETs `url` with `headers` and resolves the
 * parsed JSON body. Must throw a TransportError on non-2xx. Injected in tests.
 */
export type CohorlyGetFetcher = (
  url: string,
  headers: Record<string, string>,
) => Promise<unknown>;

/**
 * Transport abstraction: POSTs `body` as JSON to `url` with `headers`.
 * Must throw a TransportError on non-2xx responses. Injected in tests.
 *
 * `signal` aborts a /track request that outlived a flush deadline
 * (`flushTimeoutMs`); the transport should then reject, like a network
 * error. Optional: a transport that ignores it still works, but a hung
 * request then keeps holding the flush queue (and the process) until it
 * settles on its own.
 */
export type CohorlyTransport = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<void>;

export interface CohorlyConfig {
  /** Base URL of the Cohorly ingestion server. Default "https://cohorly-service.velloalabs.com". */
  host?: string;
  /** Auto-flush the event queue every N ms. Default 5000. 0 disables the timer. */
  flushIntervalMs?: number;
  /** Flush once the queue reaches this many events. Default 20, clamped to
   * the server per-request cap of 500. */
  batchSize?: number;
  /** Log SDK activity via console.warn. Default false. */
  debug?: boolean;
  /** Max events retained in the in-memory queue (drop oldest on overflow). Default 1000. */
  maxQueueSize?: number;
  /** Upper bound on retry backoff delay, in ms. Default 600000 (10 min). */
  maxRetryDelayMs?: number;
  /** Custom transport, mainly for testing. Defaults to a fetch transport. */
  transport?: CohorlyTransport;
  /** Custom JSON fetcher for flag evaluation, mainly for testing. Defaults to a fetch JSON fetcher. */
  fetcher?: CohorlyFetcher;
  /**
   * Flag secret (ADR-0011). When set, the client polls
   * `GET {host}/flags/local-evaluation` and evaluates locally-evaluable flags
   * in-process, at zero request latency. Distinct from the project token; it
   * authorizes exactly that one endpoint. Unset = every flag read is a
   * `/flags/evaluate` request.
   */
  flagSecret?: string;
  /** How often to refetch flag definitions, in ms. Default 30000. 0 = fetch once. */
  flagPollIntervalMs?: number;
  /** Custom GET fetcher for flag definitions, mainly for testing. */
  definitionsFetcher?: CohorlyGetFetcher;
  /**
   * The release this deploy is, e.g. `"api@2026.11.3"` or a git sha. Sent as
   * `$exception_release` on every exception AND as `$app_version_string` on
   * every event (a value you pass wins), so crash-free users by release
   * compares one version string (ADR-0019). Unset: neither is stamped.
   */
  release?: string;
  /** Distribution inside the release (e.g. a build id), sent as `$exception_dist`. */
  dist?: string;
  /** Overrides `$app_version_string` only; `$exception_release` still comes from `release`. */
  appVersion?: string;
  /**
   * Called with every fully built `$exception` event before it is queued.
   * Return it (changed if needed) or `null` to drop it. Returning anything
   * that is not an event, or throwing, drops it too: an exception is never
   * sent unscrubbed.
   */
  beforeSendException?: (event: TrackEvent) => TrackEvent | null;
  /** Capacity of the exception queue, separate from the event queue. Default 50. */
  maxExceptionQueueSize?: number;
  /**
   * Sent as `server_name` on exceptions, and the `distinct_id` of exceptions
   * captured without one (default `"server"`).
   */
  serverName?: string;
  /** Frame paths inside this directory are sent relative to it. Default `process.cwd()`. */
  projectRoot?: string;
  /**
   * Capture `uncaughtException` (level fatal) and `unhandledRejection`
   * (level error), flush with a timeout, then let the process end exactly
   * as it would without the SDK. Default false.
   */
  captureUncaught?: boolean;
  /**
   * Set to `false` to turn exception capture off: `captureException()` sends
   * nothing and the uncaught handlers are not registered, even with
   * `captureUncaught: true`. Default true.
   */
  captureExceptions?: boolean;
  /** Deadline of the flush done by withCohorly() and the uncaught handlers, in ms. Default 2000. */
  flushTimeoutMs?: number;
}

/** Options of `captureException()` / `captureExceptionList()`. */
export interface CaptureExceptionOptions
  extends Omit<CoreCaptureExceptionOptions, "properties"> {
  /** Who hit the error. Default: `serverName`, else `"server"`. */
  distinctId?: string;
}

/** Options of `flushExceptions()`. */
export interface FlushExceptionsOptions {
  /** Send only `$exception_level: "fatal"` exceptions. */
  fatalOnly?: boolean;
}

/** Options of `withCohorly()`. */
export interface WithCohorlyOptions<A extends unknown[]> {
  /** Derives the exception's `distinct_id` from the handler's arguments. */
  distinctId?: (...args: A) => string | undefined;
  /** Overrides the client's `flushTimeoutMs` for this handler. */
  flushTimeoutMs?: number;
}

/**
 * Profile operations, mirroring mixpanel-node's `people` API (snake_case
 * canonical names + camelCase aliases), mapped to POST /engage ops.
 * `append`/`union`/`track_charge` are not supported by the Cohorly server
 * and intentionally absent.
 */
export interface CohorlyPeople {
  /** $set: set profile properties. Object form or single key/value form. */
  set(distinctId: string, properties: Properties, callback?: Callback): Promise<void>;
  set(distinctId: string, property: string, value: unknown, callback?: Callback): Promise<void>;

  /** $set_once: set only if not already present. */
  set_once(distinctId: string, properties: Properties, callback?: Callback): Promise<void>;
  set_once(distinctId: string, property: string, value: unknown, callback?: Callback): Promise<void>;
  setOnce(distinctId: string, properties: Properties, callback?: Callback): Promise<void>;
  setOnce(distinctId: string, property: string, value: unknown, callback?: Callback): Promise<void>;

  /** $add: increment numeric profile properties. Amount defaults to 1. */
  increment(distinctId: string, properties: Record<string, number>, callback?: Callback): Promise<void>;
  increment(distinctId: string, property: string, by?: number, callback?: Callback): Promise<void>;

  /**
   * $unset: remove profile properties. Destructive: the server only honors it
   * with an org-owner or superadmin Authorization credential, which this SDK
   * (authenticated by the project token) does not send - the op is refused
   * server-side. Remove properties from the dashboard or the admin API instead.
   */
  unset(distinctId: string, properties: string | string[], callback?: Callback): Promise<void>;

  /**
   * $delete: delete the whole profile. Destructive: same server-side
   * credential requirement as `unset` - refused on the project token alone.
   * Use the dashboard or `DELETE /api/privacy/subjects/:distinctId` (audited)
   * to delete a person.
   */
  delete_user(distinctId: string, callback?: Callback): Promise<void>;
  deleteUser(distinctId: string, callback?: Callback): Promise<void>;
}

/**
 * Feature-flag operations. Server-side style: `distinctId` passed on every
 * call. Without a `flagSecret` every call is a direct POST /flags/evaluate
 * (single-key calls send a `flag_keys` filter). With one, locally-evaluable
 * flags are resolved in-process from polled definitions (ADR-0011) and only
 * cohort-targeted or unknown flags hit the network.
 */
export interface CohorlyFlags {
  /** Whether the flag is enabled for this distinct id. False for unknown flags. */
  isFeatureEnabled(
    key: string,
    distinctId: string,
    callback?: FlagsCallback<boolean>,
  ): Promise<boolean>;
  isFeatureEnabled(
    key: string,
    distinctId: string,
    options?: FlagCallOptions,
    callback?: FlagsCallback<boolean>,
  ): Promise<boolean>;
  /** The flag's variant key when it has one, else its enabled boolean. False for unknown flags. */
  getFeatureFlag(
    key: string,
    distinctId: string,
    callback?: FlagsCallback<boolean | string>,
  ): Promise<boolean | string>;
  getFeatureFlag(
    key: string,
    distinctId: string,
    options?: FlagCallOptions,
    callback?: FlagsCallback<boolean | string>,
  ): Promise<boolean | string>;
  /** The matched variant's payload, or null when the flag has none / is unknown. */
  getFeatureFlagPayload(
    key: string,
    distinctId: string,
    callback?: FlagsCallback<unknown>,
  ): Promise<unknown>;
  getFeatureFlagPayload(
    key: string,
    distinctId: string,
    options?: FlagCallOptions,
    callback?: FlagsCallback<unknown>,
  ): Promise<unknown>;
  /** All flag results for this distinct id, keyed by flag key. */
  getAllFlags(
    distinctId: string,
    callback?: FlagsCallback<Record<string, FlagResult>>,
  ): Promise<Record<string, FlagResult>>;
}
