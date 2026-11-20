# @cohorly/react-native

Standalone React Native client for Cohorly (hosted, Mixpanel-style product analytics). No hard
dependency on `react-native` or any storage library - it works out of the box with an in-memory
store, and upgrades to persistent storage when you inject one.

**Documentation:** [React Native SDK reference](https://cohorly-docs.velloalabs.com/sdks/react-native) · [Quickstart](https://cohorly-docs.velloalabs.com/quickstart) · [HTTP API](https://cohorly-docs.velloalabs.com/api/ingestion)

## Install

```bash
pnpm add @cohorly/react-native
# recommended, for persistence across app restarts
pnpm add @react-native-async-storage/async-storage
```

## Usage

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { init, track, identify, people } from "@cohorly/react-native";

init({
  // Project token: stamped on every tracked event's properties and included
  // as a top-level `token` field on every /engage body.
  token: "YOUR_PROJECT_TOKEN",
  storage: AsyncStorage, // injects real persistence; falls back to in-memory if omitted
  // apiHost defaults to the hosted Cohorly API; set it to target a different deployment.
});

track("Screen Viewed", { screen: "Home" });

identify("user_123");
people.set({ plan: "pro" });
```

### Injecting AsyncStorage

This package has no hard dependency on `react-native` or any storage library - the
`storage` option accepts anything matching the minimal `AsyncStorageLike` interface
(`getItem`/`setItem`/`removeItem`, matching `@react-native-async-storage/async-storage`'s
default export shape 1:1). Install it separately and pass it straight through:

```bash
pnpm add @react-native-async-storage/async-storage
```

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { init } from "@cohorly/react-native";

init({ token: "YOUR_PROJECT_TOKEN", storage: AsyncStorage });
```

Without `storage`, the client falls back to `InMemoryStorage` (also exported from this
package), which works but loses the distinct id, queued events, and super properties on
every app restart.

Events are queued and flushed automatically every 5 seconds or once 20 events have
accumulated (both configurable via `flushInterval` / `flushAt`). Queued events are persisted
to storage, so nothing is lost if the app closes before a flush.

## API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `init` | `(options: CohorlyOptions) => CohorlyClient` | All optional: `apiHost` (defaults to the hosted API), `token`, `storage`, `flushInterval`, `flushAt`, `fetch`, `disabled`. |
| `track` | `(event, properties?) => void` | |
| `identify` | `(distinctId: string) => void` | Local only - no `/alias` call from this package. |
| `reset` | `() => void` | Clears identity, super properties, un-flushed events, and pending timers; mints a fresh anonymous distinct id and a matching new device id. |
| `register` / `unregister` | `(props) => void` / `(key) => void` | Super properties merged into every event. |
| `people.set/setOnce/increment/unset/deleteUser` | see source | Queued and sent to `/engage`. `set`/`setOnce` also merge platform profile defaults (see below). `unset`/`deleteUser` are destructive and refused by the server on the public project token alone (they need an org-owner/superadmin `Authorization` credential this SDK does not send) - server-side no-ops here; use the dashboard or the admin privacy API. |
| `timeEvent` | `(event: string) => void` | Starts a timer; the next `track(event)` attaches `$duration` (seconds, 3 decimals). |
| `clearTimedEvent` / `clearTimedEvents` | `(event) => void` / `() => void` | Cancel one / all pending timers without tracking. |
| `flush` | `() => Promise<void>` | Manual flush. |
| `getDistinctId` | `() => string` | |
| `getDeviceId` | `() => string` | Stable per-device id (`$device_id`); persisted, survives `identify()`, changes on `reset()`. |
| `captureException` | `(error, options?) => void` | Queue a `$exception` event (level, title, tags, extra, fingerprint). Never throws; no-op before `init()`. |
| `optOutTracking` / `optInTracking` / `hasOptedOutTracking` | `() => void` / `() => void` / `() => boolean` | Persisted opt-out (own AsyncStorage key): drops queued events, people ops, exceptions and breadcrumbs; nothing is sent (no feature flag request either) until `optInTracking()`. The stored value is applied before any send once the state is read. Before `init()` they do not throw: opt-out/opt-in are no-ops, `hasOptedOutTracking()` is `false`. |
| `isExceptionCaptureEnabled` | `() => boolean` | `false` until the persisted state is read, and after opt-out or with `captureExceptions: false`; use it as `enabled` for a native crash reporter. `false` before `init()`. |
| `onExceptionCaptureChange` | `(listener: (enabled: boolean) => void) => () => void` | Called when `isExceptionCaptureEnabled()` changes (end of hydration, opt-out, opt-in); not on subscribe. Re-send the native crash reporter configuration from it. Subscribe after `init()`; before it returns a no-op unsubscribe. |
| `addBreadcrumb` | `(crumb) => void` | Step sent with the next exceptions (last 50, memory only, cleared by `reset()`). |
| `trackNavigation` | `(navigationRef) => () => void` | `navigation` breadcrumbs (route names only) from a React Navigation / expo-router container ref. |
| `CohorlyErrorBoundary` | component | Catches render errors, captures them (`react.errorboundary`), renders `fallback`. |

You can also construct `new CohorlyClient(options)` directly instead of using the module-level
singleton, e.g. for multiple instances or dependency injection in tests.

### `token`

Pass `token` to `init()` (or the `CohorlyClient` constructor) to stamp your Cohorly
project token on every tracked event's properties and as a top-level `token` field on
every `/engage` payload sent by `people.*`.

## Timed events

Call `timeEvent(name)` to start an in-memory timer; the next `track(name)` of the
same event attaches `$duration` in seconds (float, 3 decimals) and clears the
timer. Mirrors Mixpanel's `time_event`. Timers are not persisted across restarts.

```ts
import { timeEvent, track } from "@cohorly/react-native";

timeEvent("Checkout");
// ...user completes checkout...
track("Checkout", { total: 42 }); // includes $duration
```

Use `clearTimedEvent(name)` or `clearTimedEvents()` to cancel pending timers
without tracking.

## Profile default properties

Every `people.set` / `people.setOnce` call also merges platform-scoped profile
default properties (Mixpanel Native Mode parity), so profiles carry the same
device metadata Mixpanel's native wrappers attach. Your own keys always win and
are never overridden; keys whose source can't be derived are omitted. The set is
chosen by `Platform.OS`:

| Platform | Profile keys |
| --- | --- |
| Android | `$android_lib_version`, `$android_os`, `$android_os_version`, `$android_app_version`, `$android_model`, `$android_manufacturer`, `$android_brand` |
| iOS | `$ios_lib_version`, `$ios_version` (OS version), `$ios_app_release` (app version), `$ios_app_version` (build number), `$ios_device_model` |

`people.increment` / `unset` / `deleteUser` are never augmented.

## Delivery and retries

Events are queued and persisted (AsyncStorage when injected, in-memory
otherwise) and are never dropped on a transient failure. Non-2xx responses drive
a Mixpanel-style retry contract:

- **429** keeps the queue and backs off, honoring the server's `Retry-After`.
- **5xx / network** keeps the queue with exponential backoff (base 2000ms,
  doubling per consecutive failure, capped at `maxRetryDelay`, +/-20% jitter).
- **413** halves the effective batch size and retries smaller (no data loss).
- **400** drops the offending batch permanently.
- **401** keeps the queue and backs off at the max delay.

A success resets the failure counter and clears backoff. While backing off, the
auto-flush timer, size triggers, and app-state flushes are skipped; a manual
`flush()` always forces an attempt. The persisted queue is capped at
`maxQueueSize` (default 1000), dropping the oldest events on overflow. Pass
`maxQueueSize` / `maxRetryDelayMs` to `init()` (or the constructor) to tune these.

## Device default properties and automatic events

Every tracked event is merged with device/app default properties, auto-derived
with zero wiring once you rebuild the app (native modules require a rebuild,
not just a JS update - `pod install` / gradle sync, same as any other RN native
dependency). Nothing here is a hard dependency; every source is independently
optional and simply omitted when absent.

| Property | Source (highest precedence first) |
| --- | --- |
| `$app_version_string`, `$app_build_number`, `$model`, `$manufacturer`, `$brand`, `$carrier` | this package's own bundled native module (`ios/`, `android/`, autolinked) > `react-native-device-info` > `expo-application`/`expo-device` |
| `$wifi` | `@react-native-community/netinfo` |
| `$os`, `$os_version`, `$screen_height`, `$screen_width` | `react-native`'s `Platform`/`Dimensions` |
| `$lib_version` | always sent, this package's version |
| `$release`, `$release_dist` | the release the app runs, the same values as `$exception_release`/`$exception_dist` (`release`/`dist` options, else `<bundleId>@<version>+<build>` and the downloaded `expo-updates` update id). `$release_dist` is absent on the embedded bundle; both are absent on events tracked before `ready` resolves. Powers crash-free users per release in Errors > Releases. Caller and super properties win. |
| `$device_id` | stable per-device id, persisted (see `getDeviceId`); stamped on every event, survives `identify()`, minted anew on `reset()`. A caller-supplied `$device_id` in `track()` properties wins. |
| `$user_id` | the current `distinct_id`, stamped only once `identify()` has been called (omitted while anonymous). A caller-supplied `$user_id` in `track()` properties wins. |

The bundled native module (`ios/`, `android/`) is autolinked automatically -
just install this package and rebuild:

```bash
pnpm add @cohorly/react-native
cd ios && pod install
```

- **Android is a real dependency**, not vendored: `android/build.gradle` pulls
  `com.github.cohorly-io.cohorly-android:cohorly-android:v0.3.0` straight from
  JitPack (built off the public `cohorly-io/cohorly-android` mirror - see
  [docs/RELEASING.md](../../docs/RELEASING.md#sdk-releases)), so it reuses the
  same `AndroidDeviceInfo` class the standalone Cohorly Android SDK ships, no
  copy to keep in sync. Bump the JitPack version string here when a new
  `android-v*` tag is released.
- **iOS stays vendored** (`ios/CohorlyDeviceInfo.swift`) by design, not a
  stopgap: a podspec can only depend on another *published pod*, and CocoaPods
  trunk stops accepting new podspecs 2026-12-02 (permanent read-only) - not
  worth publishing `CohorlySwift` into a registry with 5 months left. The
  vendored file is small and self-contained; low drift risk.

`react-native-device-info` / `expo-application`/`expo-device` remain a fallback
tier - useful before you've rebuilt with the native module linked, or if you
already depend on one of them for other reasons:

```bash
pnpm add react-native-device-info @react-native-community/netinfo
cd ios && pod install
```

Any explicit option always wins over the derived value - pass `appVersion` /
`appBuild` / `platformInfo` to override or to run somewhere none of the above
are installed (plain Node, tests, or Expo Go without a dev build):

```ts
init({
  token: "YOUR_PROJECT_TOKEN",
  appVersion: "1.2.0", // overrides react-native-device-info/expo-application if present
  platformInfo: { carrier: "My Carrier" }, // per-field override; other derived fields untouched
});
```

**Deliberately not captured:**
- `$radio` - no permission-free way to read it on modern Android (same reason
  the native Android SDK skips it).
- `$bluetooth_enabled` - no permission-safe JS API to check it without prompting.
- `$device_id` - no Cohorly SDK on any platform emits this yet; `distinct_id`
  already serves as the stable per-device/user identifier.
- Geo (`$city`, `$region`, `mp_country_code`) - derived server-side from the
  client IP on every `/track` call, not client-side (see the main repo docs).

Set `trackAutomaticEvents: true` to opt into Mixpanel-style lifecycle events:

- `$ae_first_open` - once ever (persisted flag), on first ever init.
- `$ae_updated` - when `appVersion` differs from the previously stored value
  (prop `$ae_updated_version`); skipped silently when `appVersion` is absent.
- `$ae_session` - on the active -> background/inactive transition, with
  `$ae_session_length` (seconds), only when foreground time was at least 10s.
  Each qualifying session also increments the profile props
  `$ae_total_app_sessions` (by 1) and `$ae_total_app_session_length` (by the
  session length in seconds), and `$ae_first_open` sets `$ae_first_app_open_date`.

This reuses the existing `AppState` subscription (no duplicate listeners) that
also flushes on background. Pass `appState` to inject a custom `AppState`-like
object (mainly for tests or non-RN environments); by default it's read lazily
from `react-native`.

## Error tracking

```ts
init({ token: "YOUR_PROJECT_TOKEN", storage: AsyncStorage, captureExceptions: true });
```

- `captureExceptions: true` chains a global handler onto `ErrorUtils` (fatal ->
  `level: "fatal"`, written to AsyncStorage before the previous handler runs,
  waiting at most 1.5 s), tracks unhandled promise rejections on Hermes, and
  records `app.lifecycle` (AppState) and `fetch` (status 400+ or rejected,
  no query or fragment, never the SDK's own requests) breadcrumbs. With the
  default (omitted) nothing global is touched. `captureExceptions: false` also
  blocks manual `captureException()`: no `$exception` is sent. `optOutTracking()`
  blocks them too.
- Exceptions have their own persisted queue (`maxExceptionQueueSize`, default
  50) and every flush sends them before events. `beforeSendException` can
  scrub or drop them (`null` or a throw drops).
- `release` defaults to `<bundleId>@<version>+<build>` (bundle id from
  `expo-application` or `react-native-device-info`, else the lowercase
  platform); `dist` defaults to the `expo-updates` update id for a downloaded
  OTA update. Both must equal `--release` / `--dist` of
  `cohorly sourcemaps upload`. Frames from the app bundle are named
  `index.android.bundle` / `main.jsbundle` with the device path in `abs_path`.
- Native crashes (iOS) are opt-in, see below.

### Native crashes (iOS)

Signals, Mach exceptions, uncaught NSExceptions and C++ exceptions are recorded
by [KSCrash](https://github.com/kstenerud/KSCrash) and sent by native code on
the next launch, before JS starts (ADR-0020), as `$exception` events with level
`fatal`. MetricKit crash, hang and CPU diagnostics are sent as `error` /
`warning`; they come with `nativeCrashReporting` unless `metricKitDiagnostics`
says otherwise. Add the config plugin and turn it on in `init`:

```json
"plugins": [["@cohorly/react-native", { "projectToken": "YOUR_PROJECT_TOKEN", "apiHost": "https://YOUR_COHORLY_API" }]]
```

```ts
init({ token: "YOUR_PROJECT_TOKEN", storage: AsyncStorage, nativeCrashReporting: true });
```

- The plugin writes `CohorlyProjectToken` / `CohorlyApiHost` into the
  Info.plist and calls `CohorlyNativeCrashes.start()` first thing in
  `didFinishLaunching` (Swift or Objective-C AppDelegate). Both props are
  required; there is no default host. Without Expo, make the same two changes
  by hand.
- The switch applies to the NEXT launch: JS writes `nativeCrashReporting` (and
  the current release, dist and identity) to UserDefaults on every launch and
  on `identify()` / `reset()`, and native code reads it before JS exists.
  Turning it off deletes unsent reports on the following launch.
  It is on only while `isExceptionCaptureEnabled()` is true too, and is re-sent
  on every `onExceptionCaptureChange`: `captureExceptions: false` or
  `optOutTracking()` turn it off, `optInTracking()` back on.
- `metricKitDiagnostics` (iOS only, default: the value of
  `nativeCrashReporting`) turns MetricKit on or off on its own.
  `nativeCrashReporting: false, metricKitDiagnostics: true` is MetricKit only:
  no signal handler is installed, so it can run alongside Sentry with
  `enableNativeCrashHandling: true`, and crashes KSCrash recorded on earlier
  launches are still sent. On Android `nativeCrashReporting` alone decides.
- `setNativeCrashReporting({ nativeCrashReporting?, metricKitDiagnostics? })`
  changes either one after init (e.g. once feature flags load); an omitted key
  keeps its value. It applies to the NEXT launch and is persisted: the next
  launch starts from it for every key `init()` leaves out, so a launch that
  ends before its flags arrive never writes the default. Leave a key you drive
  with the setter out of `init()` and call the setter on every launch.
- Never run two native crash handlers: in apps that also use Sentry, set
  `enableNativeCrashHandling: false` in `Sentry.init` before turning
  `nativeCrashReporting` on, or use the MetricKit-only mode.
- Upload the dSYMs of every build so frames are symbolicated, with the same
  release the SDK sends (`<bundleId>@<version>+<build>`):
  `cohorly debug-files upload --release com.example.shop@3.8.1+415 path/to/App.app.dSYM`
  (the `@cohorly/cli` Expo plugin does it from an Xcode build phase).
- The plugin also forwards `application(_:handleEventsForBackgroundURLSession:completionHandler:)`
  to `CohorlyNativeCrashes.handleEventsForBackgroundURLSession(_:completionHandler:)`
  (into an existing handler when the AppDelegate has one), so reports delivered
  while the app is dead are cleaned up when iOS relaunches it in the background.

See the [React Native docs](https://cohorly-docs.velloalabs.com/sdks/react-native#error-tracking) for the details.

## Session replay

Records the screen of sampled sessions on iOS (VEL-2153) and Android (VEL-2142).
Off by default; turn it on in `init`:

```ts
init({
  token: "YOUR_PROJECT_TOKEN",
  storage: AsyncStorage,
  sessionReplay: { sampleRate: 0.1, onErrorSampleRate: 1 },
});
```

| Option | Default | |
| --- | --- | --- |
| `sampleRate` | `0` | Share of sessions recorded whole, 0 to 1. Invalid values count as 0. |
| `onErrorSampleRate` | `0` | Share of the other sessions that keep the last 30 to 60 s in memory and send them only when the SDK records an exception. |
| `mode` | `"screenshot"` | `"screenshot"`: each screen is an image, masked before it is encoded. `"wireframe"` (experimental): views described as boxes and text. |
| `maskAllImages` | `true` | Masks every image, in both modes. |

Replay is on when one rate is above 0. Then every event, `$exception` included,
carries `$session_id`, and the session is drawn once (kept across relaunches):
recorded whole and uploaded every 5 s, on background and on an exception;
buffered for errors; or not recorded. A session ends after more than 30 min in
background or without activity, after 24 h, and on `reset()`. `optOutTracking()`
stops the recorder and drops what it held.

Text inputs are always masked. To hide anything else, wrap it in `<CohorlyMask>`,
a `View` whose content is never recorded (the recorder draws a placeholder of
the same size):

```tsx
import { CohorlyMask } from "@cohorly/react-native";

<CohorlyMask>
  <Text testID="card-number">{card.number}</Text>
</CohorlyMask>
```

`CohorlyMask` takes every `View` prop except `testID`: the recorders find it
by a reserved testID (`cohorly-no-capture`). Put the testID your e2e tests use
on a child, as above.

### Expo and native builds

The recorder is native code in this package, linked by autolinking: an Expo
dev client (`expo run:ios`, `expo run:android`, EAS) or a bare React Native
app records after a rebuild. Expo Go and an app not rebuilt with this version
lack the native module: replay stays off and a development build logs one
warning. Do not also add the native `CohorlyReplay` (iOS) or `cohorly-replay`
(Android) package to the app: this package already ships a copy of each
recorder, and the two copies clash (duplicate classes).

### Limitations

- Android records on API 26+ only. Below that `$session_id` is still stamped
  and nothing is recorded.
- `SurfaceView` and `TextureView` content (video, camera, maps) shows black in
  screenshot mode and as an empty rectangle in wireframe mode.
- On iOS, React Native text is hard to tell apart in wireframe mode, which is
  why screenshot is the default.
- Chunks are sent as plain JSON (no gzip in Hermes).
- Every captured frame crosses the React Native bridge as JSON before upload.
- On Android, `<CohorlyMask>` relies on React Native storing `testID` as the
  view's tag (`view.setTag(testID)`); tested with React Native 0.88.1 and
  Expo SDK 58.
- For a fatal JS error, sending the error buffer is best effort: the app may
  terminate first.
- An Android native crash links to its recording (`$session_id`) only with a
  cohorly-android release that includes VEL-2150; the JitPack `v0.3.0` this
  package depends on does not.
- A drain hands over what the recorder has finished; a screenshot still being
  copied from the screen at that moment arrives in the next drain. A fatal
  native crash loses what is pending in memory.

See [docs/SESSION-REPLAY.md](../../docs/SESSION-REPLAY.md) "React Native" for
the contract between the JS side and the native recorders.

## Testing

```bash
pnpm test
```

Unit tests use fake storage, a fake `fetch` transport, and a fake `AppState` to cover
payload shape, batching / auto-flush (both size and interval triggered), retry-on-failure,
identify/reset persistence, device default properties, and the `$ae_*` automatic
lifecycle events.
