# @cohorly/web

## 0.5.0

### Minor Changes

- 650c3c7: Custom metrics in the web SDK (VEL-1806). `cohorly.metrics.count()`, `gauge()`, `distribution()` and `flush()` send the same `$metric` events as `@cohorly/core`, and `init({ metrics: { flagKey } })` picks the kill switch flag (default `cohorly_metrics`). Unlike the rest of `cohorly`, `metrics` is a no-op before `init()` and never throws. The pending window is queued on `pagehide` and when the page becomes hidden, and sent by beacon when the queue allows it; what stays behind goes out on the next visit. `@cohorly/react`'s `useCohorly()` returns the same object, so it exposes `metrics` too.

## 0.4.0

### Minor Changes

- 569f902: Privacy controls for error tracking (VEL-1774). `@cohorly/core`, `@cohorly/web` and `@cohorly/react-native`: `optOutTracking()`, `optInTracking()` and `hasOptedOutTracking()` (persisted; while opted out nothing is queued or sent, `$exception` included, no feature flag request is made, breadcrumbs are cleared, and queued data is dropped). `captureExceptions: false` turns exception capture off entirely, manual calls included; on web and React Native, omitting it keeps the previous behavior. If you passed `captureExceptions: false` explicitly to mean "no automatic capture", remove it: it now also blocks manual `captureException()`. `@cohorly/core` and `@cohorly/react-native` also expose `isExceptionCaptureEnabled()` (on React Native it is `false` until the persisted state is read, with `onExceptionCaptureChange()` to follow it; the module functions do not throw before `init()`). `@cohorly/node`: `captureExceptions: false` makes `captureException()` a no-op and skips the uncaught handlers. `@cohorly/react` inherits the new `useCohorly()` methods.
- fde6f0d: `@cohorly/web`: `captureExceptions` now records `xhr` breadcrumbs for failed XMLHttpRequests, and sends an error once when a global handler and `captureException()` both report it within 1 second (same type, message and crashing frame; e.g. React 18 dev re-reporting a caught render error).
- 757925b: Error tracking (ADR-0019). `@cohorly/core`: `captureException()`, `captureExceptionList()`, `addBreadcrumb()` and `flushExceptions()`, a separate persisted exception queue (fatal first, never evicted by ordinary events), Chrome/Firefox/Safari stack parsing, and the `release`, `dist`, `appVersion`, `beforeSendException` and `maxExceptionQueueSize` options. `@cohorly/web`: `captureExceptions` (global error and unhandled rejection handlers, automatic breadcrumbs, local rate limit, fatal exceptions sent through `sendBeacon` on `pagehide`), `captureException()`/`addBreadcrumb()` on the singleton, and `release` stamped as both `$exception_release` and `$app_version_string`. `@cohorly/react`: `<CohorlyErrorBoundary>`.

### Patch Changes

- 4860878: `$metric` events are held in the queue while a flag evaluation is in flight and no flags are loaded, so a window sent before the first flag set no longer escapes a disabled `cohorly_metrics`: a disabled flag drops them (new `MetricsHost.onDisabled` hook), an enabled or missing flag releases them, a failed evaluation releases them too. The client `@cohorly/web` creates also queues the pending metric window on `pagehide` and when the page becomes hidden (the web `cohorly` object does not expose `metrics` yet).
- e56c8b4: `@cohorly/core`: the local exception rate limit (`ExceptionRateLimiter`, 10 per fingerprint per minute), the unhandled rejection builder (`buildRejectionList`, `UnhandledRejection` for non-Error reasons) and the React error boundary (`@cohorly/core/error-boundary`, `react` as an optional peer) now live in core and are shared by the client SDKs.

  `@cohorly/react-native`: the same error is sent at most 10 times per minute, a promise rejected with something that is not an Error is reported as `UnhandledRejection` like on the web, and an exception captured before the stored identity was read keeps the identity of the moment it was captured (an `identify()` or `reset()` made during startup no longer claims it).

  `@cohorly/web` and `@cohorly/react`: no behavior change; they use the shared implementations.

- Updated dependencies [2b570a9]
- Updated dependencies [4860878]
- Updated dependencies [569f902]
- Updated dependencies [757925b]
- Updated dependencies [e56c8b4]
  - @cohorly/core@0.4.0

## 0.3.0

### Minor Changes

- Feature flags: remote evaluation on every SDK (`isFeatureEnabled`, `getFeatureFlag`, `getFeatureFlagPayload`, `getAllFlags`, `reloadFeatureFlags`, `onFeatureFlags`), identity-scoped persisted flag cache on client SDKs (reloaded on init/identify/reset), local evaluation for server SDKs (`@cohorly/node` and `@cohorly/nest` via a flag secret and polled definitions, ADR-0011), and `$feature_flag_called` exposure events (deduped per identity session on client SDKs via `sendExposureEvents`, per-call opt-in on server SDKs).

### Patch Changes

- Updated dependencies
  - @cohorly/core@0.3.0

## 0.2.3

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
- Updated dependencies [9d06dd2]
  - @cohorly/core@0.2.2

## 0.2.2

### Patch Changes

- Updated dependencies [db6d86a]
  - @cohorly/core@0.2.1

## 0.2.1

### Patch Changes

- a5ba8cc: Fix `$lib_version` reporting: the `src/version.ts` constants had drifted from
  package.json (stuck at 0.1.0) because releases only bumped package.json. The
  constants are now corrected and kept in sync automatically at release time.

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

### Patch Changes

- Updated dependencies [219627e]
  - @cohorly/core@0.2.0
