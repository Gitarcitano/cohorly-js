# @cohorly/react

## 0.4.2

### Patch Changes

- Updated dependencies [916660e]
- Updated dependencies [8ea584e]
- Updated dependencies [916660e]
- Updated dependencies [cefb784]
  - @cohorly/core@0.5.0
  - @cohorly/web@0.6.0

## 0.4.1

### Patch Changes

- 650c3c7: Custom metrics in the web SDK (VEL-1806). `cohorly.metrics.count()`, `gauge()`, `distribution()` and `flush()` send the same `$metric` events as `@cohorly/core`, and `init({ metrics: { flagKey } })` picks the kill switch flag (default `cohorly_metrics`). Unlike the rest of `cohorly`, `metrics` is a no-op before `init()` and never throws. The pending window is queued on `pagehide` and when the page becomes hidden, and sent by beacon when the queue allows it; what stays behind goes out on the next visit. `@cohorly/react`'s `useCohorly()` returns the same object, so it exposes `metrics` too.
- Updated dependencies [650c3c7]
  - @cohorly/web@0.5.0

## 0.4.0

### Minor Changes

- 757925b: Error tracking (ADR-0019). `@cohorly/core`: `captureException()`, `captureExceptionList()`, `addBreadcrumb()` and `flushExceptions()`, a separate persisted exception queue (fatal first, never evicted by ordinary events), Chrome/Firefox/Safari stack parsing, and the `release`, `dist`, `appVersion`, `beforeSendException` and `maxExceptionQueueSize` options. `@cohorly/web`: `captureExceptions` (global error and unhandled rejection handlers, automatic breadcrumbs, local rate limit, fatal exceptions sent through `sendBeacon` on `pagehide`), `captureException()`/`addBreadcrumb()` on the singleton, and `release` stamped as both `$exception_release` and `$app_version_string`. `@cohorly/react`: `<CohorlyErrorBoundary>`.

### Patch Changes

- e56c8b4: `@cohorly/core`: the local exception rate limit (`ExceptionRateLimiter`, 10 per fingerprint per minute), the unhandled rejection builder (`buildRejectionList`, `UnhandledRejection` for non-Error reasons) and the React error boundary (`@cohorly/core/error-boundary`, `react` as an optional peer) now live in core and are shared by the client SDKs.

  `@cohorly/react-native`: the same error is sent at most 10 times per minute, a promise rejected with something that is not an Error is reported as `UnhandledRejection` like on the web, and an exception captured before the stored identity was read keeps the identity of the moment it was captured (an `identify()` or `reset()` made during startup no longer claims it).

  `@cohorly/web` and `@cohorly/react`: no behavior change; they use the shared implementations.

- Updated dependencies [2b570a9]
- Updated dependencies [4860878]
- Updated dependencies [569f902]
- Updated dependencies [fde6f0d]
- Updated dependencies [757925b]
- Updated dependencies [e56c8b4]
  - @cohorly/core@0.4.0
  - @cohorly/web@0.4.0

## 0.3.0

### Minor Changes

- Feature flags: remote evaluation on every SDK (`isFeatureEnabled`, `getFeatureFlag`, `getFeatureFlagPayload`, `getAllFlags`, `reloadFeatureFlags`, `onFeatureFlags`), identity-scoped persisted flag cache on client SDKs (reloaded on init/identify/reset), local evaluation for server SDKs (`@cohorly/node` and `@cohorly/nest` via a flag secret and polled definitions, ADR-0011), and `$feature_flag_called` exposure events (deduped per identity session on client SDKs via `sendExposureEvents`, per-call opt-in on server SDKs).

### Patch Changes

- Updated dependencies
  - @cohorly/web@0.3.0

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
  - @cohorly/web@0.2.3

## 0.2.2

### Patch Changes

- @cohorly/web@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [a5ba8cc]
  - @cohorly/web@0.2.1

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
  - @cohorly/web@0.2.0
