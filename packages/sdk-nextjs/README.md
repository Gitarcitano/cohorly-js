# @cohorly/nextjs

Next.js integration for Cohorly (hosted, Mixpanel-style product analytics).
Re-exports `@cohorly/react`'s `<CohorlyProvider>` / `useCohorly()` /
`<CohorlyErrorBoundary>`, plus `createCohorlyProxy()` for a first-party
ingestion route handler and `onRequestError` for server-side error tracking.

**Documentation:** [Next.js SDK reference](https://cohorly-docs.velloalabs.com/sdks/nextjs) · [Quickstart](https://cohorly-docs.velloalabs.com/quickstart) · [HTTP API](https://cohorly-docs.velloalabs.com/api/ingestion)

## Install

```bash
pnpm add @cohorly/nextjs
# or: npm install @cohorly/nextjs / yarn add @cohorly/nextjs
```

## Quickstart (client SDK mode - token in the browser bundle)

```tsx
// app/layout.tsx
import { CohorlyProvider } from "@cohorly/nextjs";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <CohorlyProvider token="YOUR_PROJECT_TOKEN" trackPageviews>
          {children}
        </CohorlyProvider>
      </body>
    </html>
  );
}
```

## Two token modes

There are two ways to attach your Cohorly project token to ingested data; pick one.

### 1. Client-side (token ships in the browser bundle)

Pass `token` directly to `<CohorlyProvider>` as above. Simple, but the token is visible
in your client JS.

### 2. Server-side proxy (token never leaves your server)

Point the client SDK at a first-party API route instead of the Cohorly server, and let
the route handler inject the token server-side:

```ts
// app/api/cohorly/[...path]/route.ts
import { createCohorlyProxy } from "@cohorly/nextjs/server";

export const { POST } = createCohorlyProxy({
  token: "YOUR_PROJECT_TOKEN", // injected server-side into every forwarded body
  // apiHost defaults to the hosted Cohorly API; set it to target a different deployment.
});
```

```tsx
// app/layout.tsx - point apiHost at your own route, omit `token` on the client
<CohorlyProvider apiHost="/api/cohorly" trackPageviews>
  {children}
</CohorlyProvider>
```

The proxy forwards `POST /api/cohorly/track`, `/engage`, and `/alias` upstream. In this
mode it parses each forwarded body and stamps `token` into every `/track` event's
`properties` and as a top-level field on every `/engage`/`/alias` payload (each of which
may be a single object or an array) before relaying the request - so the browser bundle
never needs to embed the token at all. This also avoids ad-blockers that block direct
requests to third-party analytics hosts, and keeps `apiHost` private.

## Error tracking

Server-side errors (server components, route handlers, server actions, middleware) are
captured through Next.js's `onRequestError` hook (Next.js 15+). Re-export ours and set
`COHORLY_TOKEN` on the server:

```ts
// instrumentation.ts
export { onRequestError } from "@cohorly/nextjs/instrumentation";
```

Or configure it in code with `createOnRequestError({ token?, apiHost?, release?, dist?,
serverName?, flushTimeoutMs?, beforeSendException?, debug? })`; options win over the env
vars `COHORLY_TOKEN`, `COHORLY_API_HOST` and `VERCEL_GIT_COMMIT_SHA` (the default
`release`). Without a token the hook does nothing.

- Each error becomes a `$exception` event (mechanism `nextjs.onRequestError`, level
  `error`) with `route`, `method`, `router_kind`, `route_type`, `request_path` (no query
  string), `digest`, `runtime`, and `render_source` / `revalidate_reason` /
  `render_type` when Next.js sets them.
- Request headers, cookies and the query string are never sent.
- The hook waits for the send (at most `flushTimeoutMs`, default 2000) so serverless
  functions do not freeze first, never rejects, and never touches the error.
- The subpath resolves per runtime: `edge-light` / `workerd` / `worker` get a
  `fetch`-only build, Node.js gets one built on `@cohorly/node`.

In the browser, pass `captureExceptions` to the provider and wrap client subtrees in
`<CohorlyErrorBoundary>` (not the root layout's `children`, which would capture
server errors a second time), and in `app/global-error.tsx` capture only errors without a `digest` (errors with one were
already captured on the server). Use the same release as `cohorly sourcemaps upload
--release`; until Next.js server source maps are uploaded, production frames point at
`.next/server`. See the [docs](https://cohorly-docs.velloalabs.com/sdks/nextjs#error-tracking)
and `examples/app-router` in this package's directory.

## API reference

| Export | From | Notes |
| --- | --- | --- |
| `CohorlyProvider`, `useCohorly`, `CohorlyErrorBoundary` | `@cohorly/nextjs` (re-exported from `@cohorly/react`) | See `@cohorly/react`'s README. |
| `createCohorlyProxy(options)` | `@cohorly/nextjs/server` | `{ apiHost?, allowedPaths?, token? }` -> `{ POST }` route handler. `apiHost` defaults to the hosted API; `allowedPaths` defaults to `["track", "engage", "alias"]`. |

| `onRequestError`, `createOnRequestError(options)` | `@cohorly/nextjs/instrumentation` | Server-side error tracking, see above. |

Requires Next.js 13+ and React 18+ (peer dependencies); `onRequestError` needs Next.js 15+.
