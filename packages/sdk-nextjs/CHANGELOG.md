# @cohorly/nextjs

## 0.4.1

### Patch Changes

- Updated dependencies [650c3c7]
  - @cohorly/react@0.4.1

## 0.4.0

### Minor Changes

- 3586edb: Error tracking (ADR-0019). New `@cohorly/nextjs/instrumentation` subpath with `onRequestError` (configured from `COHORLY_TOKEN`, `COHORLY_API_HOST` and `VERCEL_GIT_COMMIT_SHA`) and `createOnRequestError({ token, apiHost, release, dist, serverName, flushTimeoutMs, beforeSendException, debug })` for Next.js 15's `instrumentation.ts` hook: every server-side error becomes a `$exception` event (mechanism `nextjs.onRequestError`, unhandled) with `route`, `method`, `router_kind`, `route_type`, `request_path` without the query string, `digest` and `runtime`, never headers, cookies or the query string. The hook waits for the send (at most `flushTimeoutMs`, default 2000), never rejects and never touches the error; without a token it does nothing. The subpath resolves per runtime: `edge-light`, `workerd` and `worker` get a `fetch`-only build (`$lib: "nextjs-edge"`), Node.js gets one built on a single `@cohorly/node` client per process. `CohorlyErrorBoundary` is now re-exported from `@cohorly/nextjs`. Now depends on `@cohorly/core` and `@cohorly/node`.

### Patch Changes

- Updated dependencies [2b570a9]
- Updated dependencies [4860878]
- Updated dependencies [569f902]
- Updated dependencies [34aeb04]
- Updated dependencies [757925b]
- Updated dependencies [e56c8b4]
  - @cohorly/core@0.4.0
  - @cohorly/node@0.5.0
  - @cohorly/react@0.4.0

## 0.3.0

### Minor Changes

- Feature flags: remote evaluation on every SDK (`isFeatureEnabled`, `getFeatureFlag`, `getFeatureFlagPayload`, `getAllFlags`, `reloadFeatureFlags`, `onFeatureFlags`), identity-scoped persisted flag cache on client SDKs (reloaded on init/identify/reset), local evaluation for server SDKs (`@cohorly/node` and `@cohorly/nest` via a flag secret and polled definitions, ADR-0011), and `$feature_flag_called` exposure events (deduped per identity session on client SDKs via `sendExposureEvents`, per-call opt-in on server SDKs).

### Patch Changes

- Updated dependencies
  - @cohorly/react@0.3.0

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
  - @cohorly/react@0.2.3

## 0.2.2

### Patch Changes

- @cohorly/react@0.2.2

## 0.2.1

### Patch Changes

- @cohorly/react@0.2.1

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
  - @cohorly/react@0.2.0
