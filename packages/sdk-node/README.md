# @cohorly/node

Server-side Node.js SDK for [Cohorly](https://github.com/Gitarcitano/cohorly-js), hosted product analytics (Mixpanel-style). The API mirrors the official `mixpanel` npm library: stateless, `distinct_id` passed explicitly on every call, optional Node-style callbacks, plus first-class promises.

**Documentation:** [Node.js SDK reference](https://cohorly-docs.velloalabs.com/sdks/node) · [Quickstart](https://cohorly-docs.velloalabs.com/quickstart) · [HTTP API](https://cohorly-docs.velloalabs.com/api/ingestion)

Requires Node 22+. Zero runtime dependencies.

## Installation

```sh
npm install @cohorly/node
```

## Quickstart

```ts
import Cohorly from "@cohorly/node";

// Grab your project token from the Cohorly dashboard (Settings -> Projects).
const cohorly = Cohorly.init("<YOUR_PROJECT_TOKEN>", {
  host: "https://cohorly-service.velloalabs.com", // your Cohorly server
});

// Track an event. distinct_id is required (server-side style).
cohorly.track("signed_up", {
  distinct_id: "user-13793",
  plan: "premium",
});

// Or with a callback / await:
await cohorly.track("purchase", { distinct_id: "user-13793", amount: 9.99 });
cohorly.track("purchase", { distinct_id: "user-13793" }, (err) => {
  if (err) console.error(err);
});
```

Events are queued in memory and delivered in batches (auto-flush every 5s, or as soon as 20 events accumulate, up to the server's 500-events-per-request cap). Call `flush()` to force delivery and `shutdown()` before your process exits:

```ts
process.on("SIGTERM", async () => {
  await cohorly.shutdown(); // stops the timer + final flush, never throws
  process.exit(0);
});
```

## Express example

```ts
import express from "express";
import Cohorly from "@cohorly/node";

const cohorly = Cohorly.init(process.env.COHORLY_TOKEN!, {
  host: process.env.COHORLY_HOST ?? "https://cohorly-service.velloalabs.com",
});

const app = express();

app.post("/signup", async (req, res) => {
  // ... create the user ...
  cohorly.track("signed_up", {
    distinct_id: req.body.userId,
    source: req.query.utm_source,
  });
  cohorly.people.set(req.body.userId, {
    $email: req.body.email,
    plan: "free",
  });
  res.sendStatus(201);
});

app.listen(3000);
```

## Configuration

```ts
const cohorly = Cohorly.init(token, {
  host: "https://cohorly-service.velloalabs.com", // Cohorly server base URL
  flushIntervalMs: 5000,         // auto-flush timer (0 disables it)
  batchSize: 20,                 // flush at this queue size (clamped to 500)
  debug: false,                  // console.warn SDK activity
  maxQueueSize: 1000,            // in-memory queue cap (drop oldest)
  maxRetryDelayMs: 600000,       // retry backoff ceiling (10 min)
});
```

`new CohorlyNode(token, config)` is equivalent to `Cohorly.init(token, config)`.

## Tracking

- `track(event, properties, callback?)` - queue an event. `properties.distinct_id` is required. Defaults stamped on every event: `time` (unix ms, now), `$insert_id` (uuid), `$lib` (`"node"`), `$lib_version`. Supply your own `time` or `$insert_id` to override.
- `trackBatch(events, callback?)` / `track_batch(...)` - queue many `{ event, properties }` at once.
- `import(event, time, properties, callback?)` - track a historical event with an explicit timestamp (`Date` or unix ms). `importBatch` / `import_batch` for arrays (each event carries `properties.time`).
- `flush(callback?)` - force-drain the queue now (rejects if events could not be delivered; they are kept for retry).
- `shutdown()` - stop the auto-flush timer and attempt a final flush. Never rejects.

### Delivery and retries

The queue survives transient failures: on 429/5xx/network errors events are kept and retried with exponential backoff (2s base, doubling, 10 min cap, +/-20% jitter), honoring the server's `Retry-After`. A 413 halves the batch size (floor 1); a 400 drops the rejected batch; a 401 (invalid token) keeps the queue and backs off at the max delay. The queue holds at most 1000 events (oldest dropped first). The flush timer is `unref`'d, so it never keeps your process alive.

## User profiles

Mirrors mixpanel-node's `people` API, mapped to Cohorly `/engage` ops. Profile updates are sent immediately (not queued):

```ts
cohorly.people.set("user-13793", { $name: "Sam", plan: "premium" });
cohorly.people.set("user-13793", "plan", "premium");      // key/value form
cohorly.people.set_once("user-13793", { first_seen: Date.now() });
cohorly.people.increment("user-13793", "logins");         // +1
cohorly.people.increment("user-13793", "credits", 5);
cohorly.people.increment("user-13793", { logins: 1, credits: -2 });
cohorly.people.unset("user-13793", ["legacy_prop"]);
cohorly.people.delete_user("user-13793");
```

camelCase aliases exist for TypeScript comfort: `setOnce`, `deleteUser`.

> **`unset` / `delete_user` are gated server-side.** These map to the
> destructive `/engage` `$unset`/`$delete` verbs, which the server refuses when
> the request carries only the project token; they require an org-owner or
> superadmin `Authorization` credential that this SDK does not send. The server
> answers HTTP 200 with `{ status: 0, ..., refused }` and skips the op. Remove
> profile data from the dashboard, or delete a person (with an audit trail) via
> `DELETE /api/privacy/subjects/:distinctId`. The other people verbs are
> unaffected.

## Aliases

```ts
cohorly.alias("user-13793", "anonymous-abc"); // POST /alias { alias, distinct_id }
```

## Differences from mixpanel-node

- Batching: `track` queues and delivers in batches instead of one HTTP request per event (call `flush()`/`shutdown()` for immediacy). Callbacks/promises settle when the event is accepted into the queue.
- `people.append`, `people.union`, `people.track_charge`, `people.clear_charges` are not implemented - the Cohorly server has no `$append`/`$union`/revenue engage ops.
- No `geolocate`/`ip` modifiers (the Cohorly server geo-enriches from the request IP), no `secret` (`import` uses the regular `/track` endpoint, which accepts any timestamp), no `protocol`/`keepAlive` knobs (`host` is a full base URL).
- The project token travels as an `X-Cohorly-Token` header rather than inside the payload.

## Related packages

- `@cohorly/nest` - NestJS module wrapping this SDK.
- `@cohorly/web`, `@cohorly/react`, `@cohorly/nextjs`, `@cohorly/react-native` - client-side SDKs.
