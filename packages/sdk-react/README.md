# @cohorly/react

React bindings for Cohorly (hosted, Mixpanel-style product analytics).
`<CohorlyProvider>` initializes the `@cohorly/web` client on mount; `useCohorly()` gives
any descendant component access to it.

**Documentation:** [React SDK reference](https://cohorly-docs.velloalabs.com/sdks/react) · [Quickstart](https://cohorly-docs.velloalabs.com/quickstart) · [HTTP API](https://cohorly-docs.velloalabs.com/api/ingestion)

## Install

```bash
pnpm add @cohorly/react
# or: npm install @cohorly/react / yarn add @cohorly/react
```

## Quickstart

```tsx
import { CohorlyProvider, useCohorly } from "@cohorly/react";

function App() {
  return (
    <CohorlyProvider token="YOUR_PROJECT_TOKEN" trackPageviews>
      <Dashboard />
    </CohorlyProvider>
  );
}

function Dashboard() {
  const cohorly = useCohorly();
  return (
    <button onClick={() => cohorly.track("Button Clicked", { button: "upgrade" })}>
      Upgrade
    </button>
  );
}
```

## API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `<CohorlyProvider>` | props = `CohorlyWebOptions & { children? }` | Same options as `@cohorly/web`'s `init()`: `apiHost`, `token`, `flushIntervalMs`, `batchSize`, `debug`, `trackPageviews`, `superProperties`, `captureExceptions`, `release`, `dist`, `beforeSendException`, `maxExceptionQueueSize`. |
| `useCohorly()` | `() => Cohorly` | Must be called within a `<CohorlyProvider>`; throws otherwise. Returns the same client shape as `@cohorly/web`'s `cohorly` singleton (`track`, `identify`, `reset`, `register`, `unregister`, `people.*`, `flush`, `getDistinctId`, `isAnonymous`, `captureException`, `addBreadcrumb`). |
| `<CohorlyErrorBoundary>` | props = `{ fallback?, onError?, children? }` | Catches render errors, captures them (`mechanism.type: "react.errorboundary"`, level `error`, component stack as a `react.component_stack` breadcrumb) and renders `fallback`: a node, or `({ error, reset }) => node`. |

Requires React 18+ (peer dependency). `<CohorlyProvider>` is a client component
(`"use client"`); wrap it around the parts of your tree that need tracking, typically near
the root.

## Error tracking

```tsx
import { CohorlyErrorBoundary, CohorlyProvider } from "@cohorly/react";

<CohorlyProvider token="YOUR_PROJECT_TOKEN" release="web@2026.11.3" captureExceptions>
  <CohorlyErrorBoundary fallback={({ reset }) => <button onClick={reset}>Try again</button>}>
    <App />
  </CohorlyErrorBoundary>
</CohorlyProvider>;
```

See `@cohorly/web`'s README for `captureException`, breadcrumbs,
`beforeSendException`, the exception queue and the `release` mapping.

## `token`

Pass `token` as a prop on `<CohorlyProvider>` to stamp your project token on every event
and every `/engage`/`/alias` body. In a Next.js app, prefer `@cohorly/nextjs`'s
`createCohorlyProxy({ token })` server-side mode if you want to avoid embedding the token
in the client bundle - see that package's README for both modes.
