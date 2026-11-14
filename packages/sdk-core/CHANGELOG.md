# @cohorly/core

## 0.4.0

### Minor Changes

- 2b570a9: Custom metrics (VEL-1773). `client.metrics.count()`, `gauge()` and `distribution()` aggregate samples in 60 second clock-aligned windows and send one `$metric` event per metric name and tag combination (never one per sample), with flat `metric_*` properties, a client-side p50/p95 and a `metric_bucket` range label. Limits: 10 tags, 64 character tag values, 200 series per window, 2048 samples per distribution series. Remote kill switch: deactivate the `cohorly_metrics` feature flag (a missing flag means on). `identify()`, `reset()` and `stop()` queue the pending window first. New `metrics` option (`flagKey`).
- 569f902: Privacy controls for error tracking (VEL-1774). `@cohorly/core`, `@cohorly/web` and `@cohorly/react-native`: `optOutTracking()`, `optInTracking()` and `hasOptedOutTracking()` (persisted; while opted out nothing is queued or sent, `$exception` included, no feature flag request is made, breadcrumbs are cleared, and queued data is dropped). `captureExceptions: false` turns exception capture off entirely, manual calls included; on web and React Native, omitting it keeps the previous behavior. If you passed `captureExceptions: false` explicitly to mean "no automatic capture", remove it: it now also blocks manual `captureException()`. `@cohorly/core` and `@cohorly/react-native` also expose `isExceptionCaptureEnabled()` (on React Native it is `false` until the persisted state is read, with `onExceptionCaptureChange()` to follow it; the module functions do not throw before `init()`). `@cohorly/node`: `captureExceptions: false` makes `captureException()` a no-op and skips the uncaught handlers. `@cohorly/react` inherits the new `useCohorly()` methods.
- 757925b: Error tracking (ADR-0019). `@cohorly/core`: `captureException()`, `captureExceptionList()`, `addBreadcrumb()` and `flushExceptions()`, a separate persisted exception queue (fatal first, never evicted by ordinary events), Chrome/Firefox/Safari stack parsing, and the `release`, `dist`, `appVersion`, `beforeSendException` and `maxExceptionQueueSize` options. `@cohorly/web`: `captureExceptions` (global error and unhandled rejection handlers, automatic breadcrumbs, local rate limit, fatal exceptions sent through `sendBeacon` on `pagehide`), `captureException()`/`addBreadcrumb()` on the singleton, and `release` stamped as both `$exception_release` and `$app_version_string`. `@cohorly/react`: `<CohorlyErrorBoundary>`.
- e56c8b4: `@cohorly/core`: the local exception rate limit (`ExceptionRateLimiter`, 10 per fingerprint per minute), the unhandled rejection builder (`buildRejectionList`, `UnhandledRejection` for non-Error reasons) and the React error boundary (`@cohorly/core/error-boundary`, `react` as an optional peer) now live in core and are shared by the client SDKs.

  `@cohorly/react-native`: the same error is sent at most 10 times per minute, a promise rejected with something that is not an Error is reported as `UnhandledRejection` like on the web, and an exception captured before the stored identity was read keeps the identity of the moment it was captured (an `identify()` or `reset()` made during startup no longer claims it).

  `@cohorly/web` and `@cohorly/react`: no behavior change; they use the shared implementations.

### Patch Changes

- 4860878: `$metric` events are held in the queue while a flag evaluation is in flight and no flags are loaded, so a window sent before the first flag set no longer escapes a disabled `cohorly_metrics`: a disabled flag drops them (new `MetricsHost.onDisabled` hook), an enabled or missing flag releases them, a failed evaluation releases them too. The client `@cohorly/web` creates also queues the pending metric window on `pagehide` and when the page becomes hidden (the web `cohorly` object does not expose `metrics` yet).

## 0.3.0

### Minor Changes

- Feature flags: remote evaluation on every SDK (`isFeatureEnabled`, `getFeatureFlag`, `getFeatureFlagPayload`, `getAllFlags`, `reloadFeatureFlags`, `onFeatureFlags`), identity-scoped persisted flag cache on client SDKs (reloaded on init/identify/reset), local evaluation for server SDKs (`@cohorly/node` and `@cohorly/nest` via a flag secret and polled definitions, ADR-0011), and `$feature_flag_called` exposure events (deduped per identity session on client SDKs via `sendExposureEvents`, per-call opt-in on server SDKs).

## 0.2.2

### Patch Changes

- 9d06dd2: Server behavior change: the destructive `/engage` verbs `$unset` and `$delete`
  (`people.unset` / `people.delete` / `people.delete_user` / `deleteUser`) are no
  longer honored when a request is authenticated only by the project token, which
  ships in public client bundles. They now require an org-owner or superadmin
  `Authorization: Bearer` credential on the same request. Refused ops are skipped
  individually - the rest of the batch still applies - and the server keeps
  answering HTTP 200 with `{ status: 0, error, applied, refused: [{ index, op }] }`,
  so SDK retry queues are not wedged. From these SDKs (which send only the project
  token) the destructive calls become server-side no-ops; remove profile data from
  the dashboard or via `DELETE /api/privacy/subjects/:distinctId` (audited).
  `set` / `set_once` / `increment` ($add) are unaffected. No SDK code changed;
  docs and type annotations updated.

## 0.2.1

### Patch Changes

- db6d86a: Patch bump to unblock publish: 0.2.0 was already on npm but not skipped correctly due to OIDC auth check failure during npm info lookup.

## 0.2.0

### Minor Changes

- 219627e: Reposition the SDKs as hosted SaaS instead of a local self-hosted project, and
  make the ingestion host zero-config.

  - Descriptions, README intros, and examples now describe Cohorly as hosted
    product analytics.
  - `apiHost` is now optional across the client SDKs and defaults to the hosted
    endpoint (`https://cohorly-service.velloalabs.com`); the server-side default
    ingestion host moved off `http://localhost:4000` too. Existing callers that
    pass `apiHost` are unaffected.
