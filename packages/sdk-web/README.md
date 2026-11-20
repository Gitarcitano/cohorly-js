# @cohorly/web

Browser SDK for Cohorly (hosted, Mixpanel-style product analytics). Built on
`@cohorly/core` with localStorage persistence, `fetch`/`sendBeacon` transport (so events
survive tab close/navigation), and optional SPA pageview autotracking.

**Documentation:** [Web SDK reference](https://cohorly-docs.velloalabs.com/sdks/web) · [Quickstart](https://cohorly-docs.velloalabs.com/quickstart) · [HTTP API](https://cohorly-docs.velloalabs.com/api/ingestion)

## Install

```bash
pnpm add @cohorly/web
# or: npm install @cohorly/web / yarn add @cohorly/web
```

## Quickstart

```ts
import { init } from "@cohorly/web";

const cohorly = init({
  // Project token: attached to every event and to every /engage & /alias body.
  token: "YOUR_PROJECT_TOKEN",
  trackPageviews: true,
  // apiHost defaults to the hosted Cohorly API; set it to target a different deployment.
});

cohorly.track("Signed Up", { plan: "pro" });
await cohorly.identify("user_123");
await cohorly.people.set({ name: "Ada Lovelace" });
```

Or use the named singleton after `init()` has run once (e.g. app entry point):

```ts
import { cohorly } from "@cohorly/web";

cohorly.track("Button Clicked", { button: "checkout" });
```

## API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `init` | `(options: CohorlyWebOptions) => Cohorly` | All optional: `apiHost` (defaults to the hosted API), `token`, `flushIntervalMs`, `batchSize`, `debug`, `trackPageviews`, `autocapture`, `superProperties`, and error tracking: `captureExceptions`, `release`, `dist`, `beforeSendException`, `maxExceptionQueueSize`. |
| `cohorly.track` | `(event, properties?) => void` | Merges in device (`$browser`/`$browser_version`/`$os`/`$device`/`$screen_*`/`$lib_version`), `$current_url`, and attribution (`$referrer`/`$referring_domain`/`$initial_*`/`$search_engine`/`mp_keyword`) props automatically. |
| `cohorly.identify` | `(id: string) => Promise<void>` | |
| `cohorly.reset` | `() => void` | |
| `cohorly.register` / `unregister` | `(props) => void` / `(key) => void` | Super properties. |
| `cohorly.timeEvent` | `(event) => void` | Start a timer; next `track(event)` attaches `$duration` (seconds). See `clearTimedEvent` / `clearTimedEvents`. |
| `cohorly.people.*` | `set/setOnce/increment/unset/delete` | Profile updates. `set`/`setOnce` auto-merge platform profile defaults (see below). `unset`/`delete` are destructive and refused by the server on the public project token alone (they need an org-owner/superadmin `Authorization` credential the browser SDK does not have) - server-side no-ops here; use the dashboard or the admin privacy API. |
| `cohorly.flush` | `() => Promise<void>` | Manual flush. |
| `cohorly.captureException` | `(error, options?) => TrackedEvent \| null` | Queues a `$exception` event (see Error tracking below). `null` when dropped. |
| `cohorly.optOutTracking` / `optInTracking` / `hasOptedOutTracking` | `() => void` / `() => void` / `() => boolean` | Persisted opt-out: drops everything queued and sends nothing (events, people, alias, `$exception`) until `optInTracking()`. |
| `cohorly.addBreadcrumb` | `({ category, message?, level?, data?, timestamp? }) => void` | Adds to the last-50 trail sent with every exception. |
| `cohorly.getDistinctId` / `isAnonymous` | - | Accessors. |

Safe to call `init()` during SSR: browser-only APIs (localStorage, `window`,
`sendBeacon`) fall back to in-memory/no-op implementations when unavailable.

## Default & attribution properties

Every event automatically carries Mixpanel-compatible props:

- **Device**: `$browser`, `$browser_version`, `$os`, `$device` (mobile only),
  `$screen_width`, `$screen_height`, `$lib_version`, `$current_url`.
- **Attribution**: `$referrer`, `$referring_domain`, `$search_engine` +
  `mp_keyword` (google/bing/yahoo/duckduckgo referrers), and first-touch
  `$initial_referrer` / `$initial_referring_domain` (persisted once, defaulting
  to `$direct`).
- **Identity**: `$device_id` (stable per-browser, survives `identify()`) on every
  event, and `$user_id` (the identified distinct id) once `identify()` has run.
- **Campaign**: any UTM params (`utm_source/medium/campaign/term/content`),
  `utm_id`, and ad click IDs (`dclid`, `fbclid`, `gclid`, `gbraid`, `wbraid`,
  `ko_click_id`, `li_fat_id`, `msclkid`, `sccid`, `ttclid`, `twclid`) present in
  the landing URL are registered as super properties on `init()`.

On first ever visit, a one-time `$set_once` profile update records
`$initial_referrer`, `$initial_referring_domain`, and `initial_<campaign param>`
(e.g. `initial_utm_source`, `initial_gclid`).

### Profile defaults

`people.set` / `people.setOnce` auto-merge platform profile defaults (Mixpanel
parity) so profiles carry `$os`, `$browser`, `$browser_version`,
`$initial_referrer`, and `$initial_referring_domain`. Keys you pass explicitly
always win.

## Automatic pageviews

With `trackPageviews: true`, a `$mp_web_page_view` event fires on init and on SPA
route changes (history `pushState`/`replaceState`/`popstate`) with props
`$current_url`, `current_page_title`, `current_domain`, `current_url_path`,
`current_url_search`.

## Autocapture (opt-in)

`autocapture` is off by default. Pass `true` for all handlers, or an object to
tune them:

```ts
init({
  token: "YOUR_PROJECT_TOKEN",
  autocapture: {
    clicks: true,           // $mp_click on a/button/[role=button]/input[button|submit]
    submits: true,          // $mp_submit on form submit
    scroll: true,           // $mp_scroll at depth checkpoints
    rageClicks: true,       // $mp_rage_click on 4+ clicks in 1s within 30px
    deadClicks: true,       // $mp_dead_click: interactive click, no DOM change/nav in 500ms
    captureTextContent: false,       // $el_text only when true (trimmed, <=255 chars)
    blockSelectors: [".sensitive"],  // element.closest() match -> skip
    scrollCheckpoints: [25, 50, 75, 100],
  },
});
```

Captured click props: `$el_tag_name`, `$el_id`, `$el_classes` (array), `$el_href`
(anchors only), and `$el_text` (only with `captureTextContent`). Submit props:
`$el_tag_name: "form"`, `$el_id`, `$el_classes`. Scroll prop:
`$scroll_depth_percent`, fired once per checkpoint per page and reset on SPA
navigation. **Input values are never captured.**

`rageClicks` and `deadClicks` default **on** when autocapture is enabled (set
either to `false` to disable). `$mp_rage_click` fires once per burst of 4+ clicks
within 1s in a 30px radius. `$mp_dead_click` fires when a click on an interactive
element (`a`/`button`/`[role=button]`/`input[button|submit]`) triggers no DOM
mutation and no navigation within 500ms. Both carry the same `$el_*` props as
`$mp_click`.

## Error tracking

`captureException(error, options?)` sends a `$exception` event: the error and
its `cause` chain (outermost first, at most 5) with stack frames oldest call
first, the last 50 breadcrumbs, `$exception_release`/`$exception_dist`, and the
same default properties as `track()`. Options: `level`
(`fatal|error|warning|info`, default `error`), `title` (`error_title`),
`fingerprint`, `tags` and `extra` (top-level properties that never override a
reserved key), `mechanism`. A non-Error value becomes a synthetic exception.

`captureExceptions` has three states: `true` installs the global handlers below;
omitted installs none and manual `captureException()` still works; `false`
installs none and no `$exception` is sent at all, not even a manual one.
`optOutTracking()` blocks every `$exception` whatever `captureExceptions` says.

`captureExceptions: true` adds global `error` and
`unhandledrejection` handlers (`handled: false`; `fatal` for uncaught errors, `error` for rejections; existing
handlers keep running) and automatic breadcrumbs: navigation (paths only),
clicks (a short selector like `button#pay`, never text or values),
`console.error`, and failed fetches and XHRs (category `fetch` / `xhr`: method,
URL without query, status - never bodies or headers, never the SDK's own
requests). The same error is sent at most 10 times per 60 seconds. An error
that a global handler and `captureException()` both report within 1 second
(same type, message and crashing frame) is sent once: React 18 re-reports a
render error its boundary caught to `window` in development, and the event
kept is the one from the global handler (level `fatal`).

`beforeSendException(event)` runs before an exception is queued: return the
(scrubbed) event or `null` to drop it; a hook that throws drops it.

Exceptions have their own persisted queue (`maxExceptionQueueSize`, default
50): ordinary events never evict them, the oldest non-fatal one goes first on
overflow, every flush sends exceptions (fatal first) before events, and on
`pagehide` fatal exceptions go out through `sendBeacon`.

`release` is sent as `$exception_release` on exceptions AND as
`$app_version_string` on every event, so crash-free users by release reads one
version string on both sides. Set it from the same source as your deploy.

## Session replay

```ts
init({
  token: "<project token>",
  captureExceptions: true, // error mode sends on exceptions the SDK captures
  sessionReplay: {
    sampleRate: 0.1, // record 10% of sessions whole
    onErrorSampleRate: 1, // of the rest, keep the last 30 to 60 s and send them on an error
    maskTextSelector: ".pii", // optional, added to [data-cohorly-mask]
    blockSelector: ".ads", // optional, added to [data-cohorly-block]
    console: true, // default; false records no console lines
  },
});
```

Recording uses rrweb (`@rrweb/record` 2.2.0). The recorder code and rrweb are
loaded with a dynamic `import()` only when the current session records or
buffers: a page without `sessionReplay`, with both rates at 0, opted out at
`init()`, or whose session was sampled out never downloads them.

- **Sessions.** With `sessionReplay` set (and a rate above 0), every event,
  `$exception` included, carries `$session_id`. A session belongs to one tab
  (it is kept in `sessionStorage`): a reload continues it, another tab or a
  duplicated tab has its own. It expires after 30 minutes without a tracked
  event or recorded interaction (the SDK's own `$metric` events do not
  count), or after 24 hours. An expired session stops recording; the next
  interaction or tracked event starts a new session from a full snapshot.
  `reset()` starts a new one at once.
- **Sampling** is decided once per session and kept with it. `sampleRate`
  picks sessions recorded whole ("session" mode); among the others,
  `onErrorSampleRate` picks sessions that buffer ("error" mode).
- **Remote settings.** `remoteConfig: true` (default false) lets the rates
  and minimum duration saved in Settings > Session replay win over the
  code's, field by field (a field never saved keeps the code's value; with no
  network and no cached copy the code decides). Masking, blocking and iframe
  origins always come from the code. The settings are kept in `localStorage`
  for 1 hour per token and apply to new sessions only; a new session has its
  `$session_id` at once and is sampled when they arrive, at most 3 s later.
  With a minimum duration, session mode sends nothing until the recording is
  that long, so a shorter one is never sent; error mode always sends.
- **Triggers** (with `remoteConfig: true` only). The event, URL and flag
  triggers saved in Settings > Session replay start recording a session that
  is not recording (or only buffering for errors): an event with that exact
  name whose properties pass the filters, a page path matching the pattern
  (on load and on SPA navigation; query and fragment never count), or a flag
  that loads on (with the variant asked for). Each draws its rate once per
  session, hit or miss; a hit records the rest of the session from a full
  snapshot (a buffered session sends its buffer first), and the minimum
  duration counts from the snapshot the hit starts. Flag triggers read
  the loaded flags without sending `$feature_flag_called`, and never fire
  with `loadFeatureFlags: false`.
- **Session mode** sends chunks to `POST /replay` every 5 seconds or 1000
  rrweb events (split before sending past 1 MB), gzipped with
  `CompressionStream` where the browser has it. When the tab is hidden,
  queued chunks go through `fetch(..., { keepalive: true })` as far as the
  browser's 64 KB keepalive budget allows; on `pagehide` a chunk too big is
  split to use the rest of that budget, and what does not fit stays queued if
  the page comes back. Chunks are kept in memory only (at most 5 MB; past it
  the oldest goes and a fresh full snapshot keeps the next ones playable),
  never in `localStorage`, and follow the same retry rules as events
  (below). A 404 from `/replay` stops replay for the page load.
- **Error mode** keeps the last 30 to 60 seconds in memory (at most 10 MB) and
  sends them only when the SDK captures an `$exception`, so it needs exception
  capture: `captureExceptions: true`, or your own `captureException()` calls.
  The send starts at a full snapshot (the SDK takes one every 30 s while
  something happens), covers at least 30 s when the recording is that old,
  never includes anything older than 60 s, and ends with the event that led
  to the error. It then keeps buffering, so the next error sends again (at
  most one send every 5 s); it never turns into full recording.
- **Quota.** When the project is over its monthly replay quota, the server
  answers 429 `replay quota exceeded`: session mode stops until the
  `Retry-After` time (remembered across reloads and tabs) and those sessions
  fall back to the error buffer. Error-mode chunks are never refused by the
  quota. A plain 429 rate limit is only retried.
- **Opt-out.** `optOutTracking()` stops the recorder and drops everything
  buffered or queued; nothing is sent afterwards. Recording resumes only at
  the next `init()` after `optInTracking()`.
- **Proxy.** `createCohorlyProxy()` from `@cohorly/nextjs` forwards `/replay`
  too (the body as bytes, with its encoding, token header and query).

Privacy defaults, which cannot be turned off:

- Every input value is masked: every input type (`hidden` and `password`
  included), textarea and select.
- Text inside `[data-cohorly-mask]` (plus your `maskTextSelector`) is masked.
- `[data-cohorly-block]` elements (plus your `blockSelector`) are never
  recorded; the replay shows a placeholder of the same size.
- The page URL is recorded without its query string or fragment.
- Network requests (`fetch` and `XMLHttpRequest`, `http(s)` only) appear as
  `$network` events with only method, URL without query or fragment, status
  (0 for a network error) and duration, never the SDK's own requests to the
  Cohorly API. Headers and bodies only with the `network` option below. The
  SDK wraps `fetch` and `XMLHttpRequest` once per page, shared with the error
  tracking breadcrumbs, and the app always gets the original response.

The console is recorded by default and can be turned off:

- `console.log`, `info`, `warn` and `error` appear as `$console` events
  (`{ level, message }`), the arguments joined by a space, at most 2048
  characters: an `Error` with its stack, objects as JSON (4 levels, 50 keys
  each, cycles as `[Circular]`). Each line is scrubbed in the browser:
  values under secret keys (`password`, `apiKey`, `authorization`, ...)
  become `[token]`, and e-mails, bearer and JWT tokens, `token=`-style
  secrets and card numbers become `[email]`, `[token]` or `[card]`.
- At most 500 lines a minute per page; the rest is counted and the recording
  shows how many lines were dropped.
- The SDK's own `[cohorly] ...` messages are never recorded, nor lines logged
  while no session is recording. The page's console keeps working exactly as
  before (same arguments, same `this`, same return value).
- `sessionReplay: { console: false }` records none; without
  `captureExceptions` the console is then never wrapped.

```html
<div data-cohorly-block>card form</div>
<p data-cohorly-mask>Signed in as jane@example.com</p>
```

**Network headers and bodies.** `network` records request and response
headers and/or bodies (both `false` by default) for the URLs in `allowUrls`
only, tested against the absolute URL without query or fragment (a string as
a prefix, a `RegExp` with `test`). Without `allowUrls` nothing more is
recorded (a debug warning says so); a request to another URL is marked
`capture: "not_allowed"`.

```ts
sessionReplay: {
  sampleRate: 0.1,
  network: {
    headers: true,
    bodies: true,
    allowUrls: ["https://api.example.com/"],
    redact: (entry) => entry, // change it, or return null for no headers and bodies
  },
}
```

Turning this on is your app's responsibility: a body can carry personal data
the scrub does not recognize, and `redact` is where you remove it.
`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`
and any header whose name contains `token`, `secret`, `password`, `auth` or
`session` are never recorded; other values are scrubbed. Text bodies (JSON,
`text/*`, form, XML) are scrubbed (in JSON, secret keys become `[token]`) and
cut at 16 KiB with `[truncated]`; other bodies become `[binary N bytes]`,
`[form-data]` or `[stream]`. A fetch response is read from a clone, at most
16 KiB and 2 s (`[unavailable]` after that), without delaying or changing the
response the app gets. A `redact` that throws records the request without
headers or bodies. On a cross-origin request only the response headers in
`Access-Control-Expose-Headers` (plus the safe ones) can be recorded.

**Cross-origin iframes.** `allowedIframeOrigins` (exact origins such as
`"https://pay.example.com"`, empty by default; `*`, paths and trailing
slashes are ignored with a debug log) records a cross-origin `<iframe>`
inside the parent page's recording, when both pages run the SDK and each
lists the other's origin:

```ts
// parent, https://shop.example.com
sessionReplay: { sampleRate: 0.1, allowedIframeOrigins: ["https://pay.example.com"] }
// iframe, https://pay.example.com (relays even with both rates at 0)
sessionReplay: { allowedIframeOrigins: ["https://shop.example.com"] }
```

Both sides use `postMessage({ source: "cohorly-replay", v: 1, op }, origin)`,
only to listed origins, never `"*"`: `op` is `"snapshot"` or `"stop"` from the
parent, and `"ready"` from the frame at each `init()` (so a late or repeated
init is asked again). The frame answers only its own `window.parent` on a
listed origin, and the parent drops rrweb messages from unlisted origins, from
windows that are not one of its iframes, or from an iframe it blocks (its
`blockSelector`, on the frame or an ancestor). The frame's own masking applies
inside it, and it does not record a session of its own meanwhile. An
interaction inside the frame wakes the parent's session after an idle expiry.
One level of nesting, no canvas or cursor inside the frame. Details in
`docs/SESSION-REPLAY.md` "Cross-origin iframes".

**Canvas.** `canvas` records every `<canvas>` (2D and WebGL) as WebP images.
It is off unless it is an object: `canvas: {}` turns it on with the defaults,
`fps` 2 (1 to 12) frames per second per canvas and `quality` 0.4 (0.1 to 1);
out-of-range numbers are clamped and anything else is the default.

```ts
sessionReplay: { sampleRate: 0.1, canvas: { fps: 2, quality: 0.4 } }
```

Cost, measured with the same bench (2026-11-18, headless Chromium, a 800x600
canvas redrawn 20 times a second with noisy content, `fps: 2`): about 118
frames and 1.9 MiB per minute on the wire (gzip barely shrinks WebP in
base64), +0.74 s of main-thread task time per minute (1.2% of wall time) and
+0.04 s at init, against the same page with the option off. A page whose
canvas changes less costs less. A canvas is recorded as
pixels: text masking does not apply, so text drawn on it is recorded as it
shows. Put `data-cohorly-block` on the canvas or an ancestor (or match it with
`blockSelector`) to keep it out of the recording. A frame over 400,000
characters is dropped, a page load records at most 64 MiB of frames, and a
snapshot over the chunk limit is sent without the canvases' pixels. A page
whose CSP has no `worker-src` for `blob:` (and `data:`) records no canvas, with
no error. rrweb forces `preserveDrawingBuffer` on WebGL contexts created after
recording started, which can cost performance. Details in
`docs/SESSION-REPLAY.md` "Canvas (VEL-2155)".

Overhead, measured with `bench/replay-overhead.mjs` (in the repository) on
an Apple M4 Pro (12 cores, macOS), headless Chromium 149, 60 seconds of
scripted interaction (typing 10 keys/s, a click that appends a list item 2/s,
text mutations 1/s, mouse moves 20/s, a scroll every 2 s), 3 runs per variant.
Init covers `init()` to 1.5 s after it (loading the recorder and rrweb, the
first full snapshot); the CPU columns cover the 60 s interaction only.

| | Init task time | Main-thread task time (CDP `TaskDuration`) | Script time (CDP `ScriptDuration`) | Sent to `/replay` |
| --- | --- | --- | --- | --- |
| Session mode, ~900 elements | +0.011 s | +0.018 s per minute (0.03% of wall time) | +0.136 s per minute | 43.8 KiB/min gzip (444.9 KiB raw), 13 chunks |
| Error mode, ~900 elements | +0.016 s | +0.182 s per minute (0.30%) | +0.178 s per minute | 36.9 KiB gzip for one error send (468.4 KiB raw) |
| Session mode, ~4800 elements | +0.031 s | +0.162 s per minute (0.27%) | +0.195 s per minute | 137.0 KiB/min gzip (1446.9 KiB raw), 13 chunks |

Differences are against the same page without replay. Task time varies
between runs (1.71 to 2.10 s per minute without replay) more than some of
these differences, so read it as an order of magnitude; script time is
steadier. Bytes include the full snapshots. Details in
`docs/SESSION-REPLAY.md` section 6.

## `token`

Pass `token` to `init()` to stamp your Cohorly project token on every tracked event and
every `/engage`/`/alias` request body. If you'd rather keep the token out of the client
bundle entirely, proxy ingestion through `@cohorly/nextjs`'s `createCohorlyProxy({ token })`
server-side mode instead and omit `token` here.

## Delivery and retries

Events are queued in `localStorage` (in-memory fallback during SSR) and never
dropped on a transient failure. The SDK inherits the `@cohorly/core` retry
contract:

- **429** keeps the queue and backs off, honoring the server's `Retry-After`.
- **5xx / network** keeps the queue with exponential backoff (base 2000ms,
  doubling, capped at `maxRetryDelayMs`, +/-20% jitter).
- **413** halves the effective batch size and retries smaller (no data loss).
- **400** drops the offending batch (it will never succeed).
- **401** keeps the queue and backs off at the max delay.

The persisted queue is capped at `maxQueueSize` (default 1000), dropping the
oldest events on overflow. Pass `maxQueueSize` / `maxRetryDelayMs` to `init()` to
tune these. On page hide / tab close the queue is flushed via `navigator.sendBeacon`
(best effort, fire-and-forget).
