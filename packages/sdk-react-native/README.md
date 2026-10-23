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
| `$device_id` | stable per-device id, persisted (see `getDeviceId`); stamped on every event, survives `identify()`, minted anew on `reset()`. A caller-supplied `$device_id` in `track()` properties wins. |
| `$user_id` | the current `distinct_id`, stamped only once `identify()` has been called (omitted while anonymous). A caller-supplied `$user_id` in `track()` properties wins. |

The bundled native module (`ios/`, `android/`) is autolinked automatically -
just install this package and rebuild:

```bash
pnpm add @cohorly/react-native
cd ios && pod install
```

- **Android is a real dependency**, not vendored: `android/build.gradle` pulls
  `com.github.cohorly-io.cohorly-android:cohorly-android:v0.1.0` straight from
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

## Testing

```bash
pnpm test
```

Unit tests use fake storage, a fake `fetch` transport, and a fake `AppState` to cover
payload shape, batching / auto-flush (both size and interval triggered), retry-on-failure,
identify/reset persistence, device default properties, and the `$ae_*` automatic
lifecycle events.
