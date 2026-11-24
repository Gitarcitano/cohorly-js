# @cohorly/web

## 0.7.1

### Patch Changes

- 345190e: Session replay canvas: the 64 MiB of canvas frames is now a budget per session across its page loads (sessionStorage, falling back to a count per page load without it), and once it is spent the recorder restarts without canvas so rrweb stops encoding frames, while the DOM keeps being recorded. A snapshot or mutation over the chunk limit loses the pixels of its largest canvases first, only until it fits, instead of every canvas. On pagehide a canvas frame that fits the keepalive budget alone is sent in its own request; one that cannot fit any keepalive request is counted in the debug log.

## 0.7.0

### Minor Changes

- aba7402: Session replay can follow the project's settings (VEL-2185). New `sessionReplay.remoteConfig`, default false: without it the SDK never calls `/replay/config` and nothing changes. With `true`, the SDK reads `GET {apiHost}/replay/config?token=` (no custom header, `credentials: "omit"`, so no preflight) and keeps the answer in `localStorage` under `chl_replay_config:<token>` for 1 hour; a fresh copy is used with no request. Each of `sampleRate`, `onErrorSampleRate` and the minimum duration that the project saved wins over the code's value; a field never saved keeps the code's, and with no network and no copy the code's values apply (an expired copy is used while the request fails). Nothing else is read from the answer: masking, blocking and iframe origins always come from the code. Replay starts even with both code rates at 0. A new session without a fresh copy gets its `$session_id` at once and is sampled when the answer arrives, the request fails or 3 s pass; rrweb loads only after that. A session already in progress keeps its mode. With a minimum duration, session mode holds its events until the recording, measured from its first event across the session's pages, is that long: nothing is sent before (not when the tab hides or closes), so a shorter recording never reaches the server or the quota, and the first chunk sent carries the full snapshot. The minimum is decided with the session's mode and stored on its record, so a session keeps it when the settings change; a held recording past 2.5 MiB is sent anyway, so the outbox bound never drops its snapshot. Error mode always sends its buffer. A new session minted when the settings in memory are an hour old, or older than the stored copy, reads them again. `/replay/config` is never recorded as `$network`.
- b15ca9e: Session replay fires the project's triggers (VEL-2187), with `sessionReplay.remoteConfig: true` only. In a session that is `off` or buffering for errors, an event trigger fires on a `track` of that exact name whose final properties (super props included) pass every filter, a URL trigger when `location.pathname` matches its pattern on load and after each `pushState`, `replaceState` and `popstate` (query and fragment never count), and a flag trigger when the flags load or reload with the flag on (and the named variant, if any); flag triggers read the loaded flags, never send `$feature_flag_called`, and never fire with `loadFeatureFlags: false`. Each trigger draws its rate once per session, hit or miss, kept in the session record (`triggered`), so a reload never draws it again. A hit turns the session to session mode for good: from `off`, rrweb loads and records from a full snapshot; from error mode, the buffer is sent as on an error and the recording restarts from a new snapshot. The minimum duration counts from the hit, and a quota pause still keeps the session in error mode. A session already recording ignores triggers. `history` is now wrapped once for SPA pageviews, navigation breadcrumbs and URL triggers, and a later `init()` no longer stacks a second pageview subscription.

### Patch Changes

- Updated dependencies [b15ca9e]
  - @cohorly/core@0.6.0

## 0.6.0

### Minor Changes

- 8ea584e: Session replay records canvas (VEL-2155). New `sessionReplay.canvas`, off unless it is an object (`{}` turns it on): the content of every `<canvas>`, 2D and WebGL, is recorded as WebP images, at most `fps` frames per second per canvas (default 2, 1 to 12) at `quality` (default 0.4, 0.1 to 1), values outside the range clamped. A canvas is recorded as pixels, so text masking does not apply and text drawn on it is recorded; one inside `[data-cohorly-block]` or the `blockSelector` is never recorded. A frame over 400,000 characters is dropped, a page load records at most 64 MiB of frames (later ones are dropped with a debug log), and a full snapshot over the chunk limit is sent without its canvases' `rr_dataURL`, so a chunk is never refused because of canvas. A page whose CSP has no `worker-src` for `blob:` and `data:` records no frames. Without the option nothing changes.
- 916660e: Session replay records the console (VEL-2144). While a recorder runs (session mode or the error buffer), `console.log`, `info`, `warn` and `error` become rrweb custom events `{ type: 5, data: { tag: "$console", payload: { level, message } } }`: the arguments joined by a space, at most 2048 characters, an `Error` with its stack, objects as JSON 4 levels deep with 50 keys or items each and cycles as `[Circular]`. Each line is scrubbed in the browser (values under secret keys such as `password`, `apiKey` or `authorization` become `[token]`; e-mails, bearer and JWT tokens, `token=`-style secrets and Luhn-valid card numbers are replaced). At most 500 lines per 60 s window per page; when a window that dropped lines closes, one `{ level: "warn", message: "", dropped, at }` line records how many. The SDK's own `[cohorly]` messages and lines logged while nothing records are never recorded. On by default; `sessionReplay.console: false` turns it off and, without `captureExceptions`, leaves the console unwrapped. The console is wrapped once per page, shared with the `console.error` breadcrumb of error tracking, and calls the page's console with the same `this` and arguments and returns its result.
- cefb784: Session replay can record request and response headers and bodies (VEL-2145). New `sessionReplay.network: { headers?, bodies?, allowUrls, redact? }`, off by default: without it, or with an empty `allowUrls` (a debug warning says so), `$network` keeps only method, URL without query, status and duration, and no body is read. For a URL in `allowUrls` (tested against the absolute URL without query or fragment; a string matches as a prefix, a `RegExp` by `test`) the payload gains `kind`, `ts` and `request`/`response` with `headers` (lower-case names) and/or `body`; a URL outside it gets `capture: "not_allowed"` only. `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key` and every header whose name contains `token`, `secret`, `password`, `auth` or `session` are never recorded, and the other values are scrubbed. Text bodies (JSON, `text/*`, form, XML) are scrubbed and cut at 16 KiB with `[truncated]`; binary bodies become `[binary N bytes]`, `FormData` `[form-data]`, streams and `text/event-stream` `[stream]`. A fetch response is read from a clone, at most 16 KiB and 2 s (`[unavailable]` after that), in the background: the page gets the same response, as soon as before, with its body intact. `redact(entry)` changes an entry or returns `null` to drop its headers and bodies; one that throws drops them too. The exception breadcrumbs share the wrapper and still read no header and no body.
- dbb67ae: Session replay records cross-origin iframes (VEL-2152). New `sessionReplay.allowedIframeOrigins` (exact origins such as `"https://pay.example.com"`, empty by default; `*`, paths and trailing slashes are ignored with a debug log): when the page and the iframe both run the SDK and each lists the other's origin, the iframe's content is recorded in the parent page's session in place of the empty frame, with the iframe's own masking and blocking, and interactions inside it count as session activity. The parent asks only listed origins, never records an iframe it blocks, and drops rrweb messages from unlisted origins, from windows that are not one of its iframes or from blocked iframes; the iframe answers only its own `window.parent` on a listed origin, tells the parent it is ready at each `init()`, relays even with both rates at 0, and does not record a session of its own meanwhile. An interaction inside the iframe wakes the parent's session after an idle expiry. Without lists on both sides nothing changes. One level of nesting, no canvas or cursor inside the iframe.

### Patch Changes

- Updated dependencies [916660e]
  - @cohorly/core@0.5.0

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
