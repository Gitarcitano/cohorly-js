# Cohorly JavaScript SDKs

<!-- cohorly-mirror-notice:start -->
> **This repository is a read-only mirror** of a private monorepo. Its
> contents are generated on every release, so changes made here would be
> overwritten.
>
> - Pull requests are not accepted for now.
> - Bugs and questions: open an issue in this repository.
> - Security vulnerabilities: follow [SECURITY.md](./SECURITY.md). Do not open
>   a public issue.
<!-- cohorly-mirror-notice:end -->


Official JavaScript/TypeScript SDKs for [Cohorly](https://cohorly.com), a product analytics platform.

| Package | Use for |
| --- | --- |
| [`@cohorly/web`](packages/sdk-web) | Browser apps (vanilla JS/TS) |
| [`@cohorly/react`](packages/sdk-react) | React apps (`<CohorlyProvider>` + `useCohorly()`) |
| [`@cohorly/nextjs`](packages/sdk-nextjs) | Next.js App Router (provider + first-party proxy route) |
| [`@cohorly/react-native`](packages/sdk-react-native) | React Native / Expo |
| [`@cohorly/node`](packages/sdk-node) | Node.js backends (mirrors mixpanel-node) |
| [`@cohorly/nest`](packages/sdk-nest) | NestJS module wrapping @cohorly/node |
| [`@cohorly/core`](packages/sdk-core) | Transport-agnostic core (used by the SDKs above) |

Looking for iOS? See [cohorly-swift](https://github.com/Gitarcitano/cohorly-swift).

## Quickstart

```bash
npm install @cohorly/web
```

```ts
import { init, track } from "@cohorly/web";

init({
  apiHost: "https://api.cohorly.com",
  token: "YOUR_PROJECT_TOKEN",
});

track("Signed Up", { plan: "pro" });
```

Full documentation: [docs.cohorly.com](https://docs.cohorly.com)

## Development

pnpm monorepo:

```bash
pnpm install
pnpm build   # build all packages
pnpm test    # test all packages
```

## License

Apache-2.0
