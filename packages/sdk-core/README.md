# @cohorly/core

Transport-agnostic core client for Cohorly (hosted, Mixpanel-style product
analytics). Handles the event queue, batching, flush scheduling, identity, and super
properties. Storage and network transport are injected by platform SDKs, so this package
has zero DOM/Node/React Native dependencies and can be used to build a new platform SDK.

**Documentation:** [Core SDK reference](https://cohorly-docs.velloalabs.com/sdks/core) · [Quickstart](https://cohorly-docs.velloalabs.com/quickstart) · [HTTP API](https://cohorly-docs.velloalabs.com/api/ingestion)

Most apps should use a platform package instead of this one directly:
`@cohorly/web`, `@cohorly/react`, `@cohorly/nextjs`, `@cohorly/react-native`, or the iOS
`CohorlySwift` package.

## Install

```bash
pnpm add @cohorly/core
# or: npm install @cohorly/core / yarn add @cohorly/core
```

## Quickstart

```ts
import { CohorlyClient, fetchTransport } from "@cohorly/core";
import type { CohorlyStorage } from "@cohorly/core";

const storage: CohorlyStorage = {
  get: (key) => myStore.get(key) ?? null,
  set: (key, value) => myStore.set(key, value),
  remove: (key) => myStore.delete(key),
};

const client = new CohorlyClient({
  // apiHost defaults to the hosted Cohorly API; set it to target a different deployment.
  // Project token: attached to every tracked event's properties and to every
  // /engage and /alias body, so the server can route data to your project.
  token: "YOUR_PROJECT_TOKEN",
  storage,
  transport: fetchTransport, // or a custom CohorlyTransport
});

client.track("Signed Up", { plan: "pro" });
await client.identify("user_123");
await client.people.set({ name: "Ada Lovelace" });
```

## API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `new CohorlyClient(options)` | `CohorlyClientOptions` | `storage` required; optional `apiHost` (defaults to the hosted API), `transport`, `token`, `flushIntervalMs`, `batchSize`, `debug`, `lib`. |
| `track` | `(event: string, properties?) => TrackedEvent` | Enqueues an event; auto-flushes at `batchSize`. |
| `identify` | `(id: string) => Promise<void>` | Switches distinct id; sends `/alias` the first time if previously anonymous. `$device_id` is preserved. |
| `reset` | `() => void` | Assigns a fresh anonymous distinct id **and** a new `$device_id`; clears any pending timed events. |
| `register` / `unregister` | `(props) => void` / `(key: string) => void` | Super properties merged into every event. |
| `timeEvent` | `(event: string) => void` | Starts a timer; the next `track(event)` of the same name attaches `$duration` (seconds, 3 decimals) and clears it. Persisted across reloads. |
| `clearTimedEvent` / `clearTimedEvents` | `(event) => void` / `() => void` | Cancel one / all pending timers. |
| `people.set/setOnce/increment/unset/delete` | see `PeopleProperties` | Profile updates sent to `/engage`. `unset`/`delete` are destructive and refused by the server on the project token alone (see note below the table). |
| `flush` | `(transportOverride?) => Promise<void>` | Manually flush: queued exceptions first (fatal first), then one batch of events. |
| `captureException` | `(error: unknown, options?: CaptureExceptionOptions) => TrackedEvent \| null` | Queues a `$exception` event (ADR-0019 wire shape). `null` when `beforeSendException` dropped it. Never throws. |
| `captureExceptionList` | `(list: ExceptionListEntry[], options?) => TrackedEvent \| null` | Same, for platform SDKs that build `$exception_list` themselves (synthetic exceptions, native crash reports). |
| `optOutTracking` / `optInTracking` / `hasOptedOutTracking` | `() => void` / `() => void` / `() => boolean` | Opt-out is persisted in the injected storage and drops every queued event, people op and exception; while opted out nothing is queued or sent (track, people, alias, `$exception`) and `reloadFeatureFlags()` makes no request; breadcrumbs are cleared and ignored meanwhile. Opting back in does not restore what was dropped. |
| `isExceptionCaptureEnabled` | `() => boolean` | `!hasOptedOutTracking() && captureExceptions !== false`. Pass it as `enabled` to a native crash reporter. |
| `addBreadcrumb` | `(crumb: BreadcrumbInput) => void` | In-memory trail, last 50, copied onto every exception; cleared by `reset()`. |
| `flushExceptions` | `(transport, { fatalOnly? }?) => Promise<void>` | Sends queued exceptions only, ignoring backoff and an in-flight flush. For teardown (e.g. `sendBeacon` on `pagehide`). |
| `getDistinctId` / `getDeviceId` / `isAnonymous` / `getApiHost` | - | Accessors. |
| `stop` | `() => void` | Stops the auto-flush timer. |

> **`people.unset` / `people.delete` are gated server-side.** The `/engage`
> `$unset`/`$delete` verbs are destructive, so the server refuses them when the
> request carries only the project token (which is public in client bundles);
> they require an org-owner or superadmin `Authorization` credential that this
> SDK does not send. The server still answers HTTP 200 (with
> `{ status: 0, ..., refused }`), so from this SDK the calls are silent
> server-side no-ops. Remove profile data from the dashboard or the admin
> privacy API instead. `set`/`setOnce`/`increment` are unaffected.

### Identity properties

Every tracked event is stamped with:
- **`$device_id`** - a stable per-device/browser id minted on first run and
  persisted (survives `identify()`; `reset()` mints a new one).
- **`$user_id`** - the `distinct_id`, but **only once identified** (anonymous
  users carry no `$user_id`).

Both are stamped last but never override a value the caller passes explicitly to
`track()`.

### `token`

When `options.token` is set, it is:
- stamped as `properties.token` on every event passed to `track()`,
- included as a top-level `token` field on every `/engage` body (via `people.*`),
- included as a top-level `token` field on the `/alias` body sent by `identify()`.

Omit it if you don't use per-project tokens.

## Error tracking

Options: `release` (`$exception_release`), `dist` (`$exception_dist`),
`appVersion` (`$app_version_string` on every event unless passed),
`beforeSendException` (return the event, a modified one, or `null` to drop;
a throwing hook drops), `maxExceptionQueueSize` (default 50).

`captureException(error, { level, fingerprint, title, tags, extra, mechanism,
properties })` builds `$exception_list` from the error and its `cause` chain
(outermost first, at most 5, cycle-safe), parsing `error.stack` (Chrome/V8,
Firefox and Safari formats) into frames ordered oldest call first. Non-Error
values become synthetic exceptions. `tags`/`extra` never override a reserved
key (`$exception_*`, `error_title`, `distinct_id`, `time`, `$insert_id`,
`$lib`, `token`, `$device_id`, `$user_id`). The helpers `parseStackTrace`,
`buildExceptionList`, `createStackFrame` and `stringifyValue` are exported for
platform SDKs.

Exceptions live in their own persisted queue (`cohorly_exception_queue`):
ordinary events never evict them; on overflow the oldest non-fatal exception
is dropped first. Every flush sends exceptions first, fatal before non-fatal,
in batches of the current batch size; if an exception batch fails, the event
queue waits. Both queues share the retry contract and backoff below.
`reset()` keeps queued exceptions and clears breadcrumbs.

The `captureExceptions: false` option turns exception capture off: `captureException()` and `captureExceptionList()` queue nothing and return `null`, while ordinary events are unaffected (default `true`).

## Delivery and retries

The client is built to never lose events. Non-2xx responses surface as a
`TransportError` (`status` + optional `retryAfterMs` parsed from `Retry-After`),
which drives the retry contract:

- **429 (rate limit / quota)** - queue is kept intact; the client enters
  backoff. The next retry is delayed by `Retry-After` when present, otherwise by
  the computed backoff.
- **5xx / network error** - queue kept, same exponential backoff.
- **413 (payload too large)** - the effective per-flush batch size is halved
  (floor 1) and the batch is retried smaller; no events are dropped.
- **400 (permanently rejected)** - that batch is dropped (logged via `debug`);
  it is not retried forever.
- **401 (invalid token)** - queue kept, warning logged, backoff at the max delay.

Backoff is exponential (base 2000ms, doubling per consecutive failure, capped at
`maxRetryDelayMs`, default 10 min) with +/-20% jitter. A success resets the
failure counter and clears backoff. While in backoff the auto-flush timer and
size-triggered flushes are skipped; a manual `flush()` always forces an attempt.

The persisted queue is bounded at `maxQueueSize` (default 1000). On overflow the
**oldest** events are dropped (logged via `debug`). Both `maxQueueSize` and
`maxRetryDelayMs` are optional `CohorlyClientOptions` fields.

## Custom metrics

`client.metrics.count|gauge|distribution(name, value, tagsOrOptions?)` aggregates
samples in the client and sends one `$metric` event per metric name and tag
combination per 60 second window (never one per sample). It is switched off
remotely by deactivating the `cohorly_metrics` feature flag. `$metric` events
count toward the event quota. Details in the docs: Core SDK, "Custom metrics".

## Testing

```bash
pnpm test
```
