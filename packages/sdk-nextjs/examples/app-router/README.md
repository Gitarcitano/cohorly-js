# @cohorly/nextjs - App Router error tracking example

A minimal Next.js 15 App Router app that captures server-side errors with
`onRequestError` and client-side errors with `CohorlyErrorBoundary` and
`global-error.tsx`. It is not a workspace package: copy it into a Next.js app.

## Run

```bash
npx create-next-app@latest my-app --ts --app --no-src-dir
cp -R app instrumentation.ts .env.example my-app/
cd my-app
npm install @cohorly/nextjs @cohorly/web
cp .env.example .env.local   # fill in COHORLY_TOKEN and NEXT_PUBLIC_COHORLY_TOKEN
npm run dev
```

Open http://localhost:3000 and follow the links:

- `/boom` - a server component throws; `onRequestError` sends it (Node.js runtime).
- `/client-boom` - a client component throws while rendering; `CohorlyErrorBoundary`
  captures it in the browser and shows its fallback.
- `/api/boom` - a route handler throws on the Node.js runtime.
- `/edge-boom` - a route handler throws on the Edge runtime; the Edge build of
  `@cohorly/nextjs/instrumentation` sends it with `fetch`.

Each one shows up as a `$exception` event with `route`, `method`,
`router_kind`, `route_type` and `request_path` (no query string). Headers,
cookies and query strings are never sent.

See the [Next.js SDK docs](https://cohorly-docs.velloalabs.com/sdks/nextjs#error-tracking).
