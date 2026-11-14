# @cohorly/react-native

## 1.4.0

### Minor Changes

- 69ac1e5: Stamp `$release` and `$release_dist` on every event (the same release and OTA dist as `$exception_release` / `$exception_dist`), so crash-free users by release can count active users per release.

## 1.3.0

### Minor Changes

- 07d60b9: Android native crash reporting (VEL-1770, ADR-0020). The Android module now depends on the Cohorly Android SDK v0.3.0, whose startup provider reports uncaught Java/Kotlin exceptions and, on API 30+, ANRs, native crashes and foreground low-memory kills as `$exception` events sent on the next launch. New native method `configureNativeCrashes(json)` writes the crash config the JS layer owns. New Expo config plugin (`"plugins": [["@cohorly/react-native", { "projectToken", "apiHost", "androidAnrWatchdog"? }]]`) writes the `com.cohorly.PROJECT_TOKEN`, `com.cohorly.API_HOST` and optional `com.cohorly.ANR_WATCHDOG` manifest meta-data.
- 4860878: Custom metrics in the React Native client (VEL-1801). `metrics.count()`, `gauge()` and `distribution()` (module helpers and `client.metrics`) send the same `$metric` events as `@cohorly/core`, with the `cohorly_metrics` kill switch and a `metrics` option. The pending window is queued when the app goes to the background. `$metric` events wait in the queue while the first flag evaluation is running and are dropped if the flag turns out to be off.
- 569f902: Privacy controls for error tracking (VEL-1774). `@cohorly/core`, `@cohorly/web` and `@cohorly/react-native`: `optOutTracking()`, `optInTracking()` and `hasOptedOutTracking()` (persisted; while opted out nothing is queued or sent, `$exception` included, no feature flag request is made, breadcrumbs are cleared, and queued data is dropped). `captureExceptions: false` turns exception capture off entirely, manual calls included; on web and React Native, omitting it keeps the previous behavior. If you passed `captureExceptions: false` explicitly to mean "no automatic capture", remove it: it now also blocks manual `captureException()`. `@cohorly/core` and `@cohorly/react-native` also expose `isExceptionCaptureEnabled()` (on React Native it is `false` until the persisted state is read, with `onExceptionCaptureChange()` to follow it; the module functions do not throw before `init()`). `@cohorly/node`: `captureExceptions: false` makes `captureException()` a no-op and skips the uncaught handlers. `@cohorly/react` inherits the new `useCohorly()` methods.
- d33a3c0: Error tracking (ADR-0019). `captureException()`, `addBreadcrumb()`, `trackNavigation()` and `<CohorlyErrorBoundary>`, built on the `@cohorly/core` exception queue (persisted apart from events, fatal first). `captureExceptions: true` chains a global `ErrorUtils` handler (fatal exceptions written to AsyncStorage before the previous handler runs and sent on the next launch with the release they crashed in), tracks unhandled promise rejections on Hermes and records AppState and failed-fetch breadcrumbs. Hermes and JavaScriptCore stacks are parsed with the app bundle named `index.android.bundle` / `main.jsbundle`. New `release` (default `<bundleId>@<version>+<build>`), `dist` (default: the `expo-updates` update id of a downloaded OTA update, with `expo_*` properties), `beforeSendException` and `maxExceptionQueueSize` options.
- 4232b55: Native crash reporting on iOS (ADR-0020), opt-in with `nativeCrashReporting: true` plus the new config plugin (`["@cohorly/react-native", { projectToken, apiHost }]`, both required). KSCrash records signals, Mach exceptions, uncaught NSExceptions and C++ exceptions; native code sends them on the next launch, before JS starts, through a background upload, with the release, OTA dist and identity of the launch that crashed. MetricKit crash, hang and CPU diagnostics are sent as `error` / `warning`. The JS layer writes the switch, release, dist and identity on every launch and on `identify()` / `reset()` for the next launch to read. The pod now depends on `KSCrash/Recording` ~> 2.6.
- e56c8b4: `@cohorly/core`: the local exception rate limit (`ExceptionRateLimiter`, 10 per fingerprint per minute), the unhandled rejection builder (`buildRejectionList`, `UnhandledRejection` for non-Error reasons) and the React error boundary (`@cohorly/core/error-boundary`, `react` as an optional peer) now live in core and are shared by the client SDKs.

  `@cohorly/react-native`: the same error is sent at most 10 times per minute, a promise rejected with something that is not an Error is reported as `UnhandledRejection` like on the web, and an exception captured before the stored identity was read keeps the identity of the moment it was captured (an `identify()` or `reset()` made during startup no longer claims it).

  `@cohorly/web` and `@cohorly/react`: no behavior change; they use the shared implementations.

### Patch Changes

- Updated dependencies [2b570a9]
- Updated dependencies [4860878]
- Updated dependencies [569f902]
- Updated dependencies [757925b]
- Updated dependencies [e56c8b4]
  - @cohorly/core@0.4.0

## 1.2.0

### Minor Changes

- Feature flags: remote evaluation on every SDK (`isFeatureEnabled`, `getFeatureFlag`, `getFeatureFlagPayload`, `getAllFlags`, `reloadFeatureFlags`, `onFeatureFlags`), identity-scoped persisted flag cache on client SDKs (reloaded on init/identify/reset), local evaluation for server SDKs (`@cohorly/node` and `@cohorly/nest` via a flag secret and polled definitions, ADR-0011), and `$feature_flag_called` exposure events (deduped per identity session on client SDKs via `sendExposureEvents`, per-call opt-in on server SDKs).

## 1.1.3

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

## 1.1.2

### Patch Changes

- a5ba8cc: Fix `$lib_version` reporting: the `src/version.ts` constants had drifted from
  package.json (stuck at 0.1.0) because releases only bumped package.json. The
  constants are now corrected and kept in sync automatically at release time.

## 1.1.1

### Patch Changes

- 0a7559e: Move `CohorlyReactNative.podspec` to the package root and fix `react-native.config.js` to export the standard self-describing `dependency` key (was `dependencies` keyed by the package's own name, the app-override shape).

  Both Expo's built-in autolinking (`expo-modules-autolinking`) and the classic community CLI only discover a native iOS module's podspec via a non-recursive scan of the package root, and only read a library's own `dependency` config when its own name isn't found there - so with the podspec nested under `ios/` and the config keyed under `dependencies`, the native module silently failed to link in any Expo-prebuild consumer (verified against monoriders), even though the pure-JS SDK worked fine. This matches the convention used by `react-native-mmkv`, `react-native-reanimated`, and other widely-used libraries.

## 1.1.0

### Minor Changes

- c09f00b: Auto-capture device/app properties (`$app_version_string`, `$app_build_number`, `$model`, `$manufacturer`, `$brand`, `$carrier`) via a bundled native module, with fallback to `react-native-device-info` or `expo-device`/`expo-application` when the native module isn't linked.
- 219627e: Reposition the SDKs as hosted SaaS instead of a local self-hosted project, and
  make the ingestion host zero-config.

  - Descriptions, README intros, and examples now describe Cohorly as hosted
    product analytics.
  - `apiHost` is now optional across the client SDKs and defaults to the hosted
    endpoint (`https://cohorly-service.velloalabs.com`); the server-side default
    ingestion host moved off `http://localhost:4000` too. Existing callers that
    pass `apiHost` are unaffected.
