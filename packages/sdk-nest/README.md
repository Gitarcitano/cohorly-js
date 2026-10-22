# @cohorly/nest

NestJS integration for [Cohorly](https://github.com/Gitarcitano/cohorly-js), hosted product analytics (Mixpanel-style). A standard dynamic module (`forRoot` / `forRootAsync`) plus an injectable `CohorlyService` wrapping [`@cohorly/node`](../sdk-node), with an automatic final flush on application shutdown.

**Documentation:** [NestJS SDK reference](https://cohorly-docs.velloalabs.com/sdks/nest) · [Quickstart](https://cohorly-docs.velloalabs.com/quickstart) · [HTTP API](https://cohorly-docs.velloalabs.com/api/ingestion)

Supports `@nestjs/common` ^10 and ^11 (peer dependency). Requires Node 22+.

## Installation

```sh
npm install @cohorly/nest
```

## Quickstart

Register the module once at the application root:

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { CohorlyModule } from "@cohorly/nest";

@Module({
  imports: [
    CohorlyModule.forRoot({
      token: process.env.COHORLY_TOKEN!,
      host: "https://cohorly-service.velloalabs.com",
      isGlobal: true, // inject CohorlyService anywhere without re-importing
    }),
  ],
})
export class AppModule {}
```

Then inject `CohorlyService`:

```ts
// signup.service.ts
import { Injectable } from "@nestjs/common";
import { CohorlyService } from "@cohorly/nest";

@Injectable()
export class SignupService {
  constructor(private readonly cohorly: CohorlyService) {}

  async signUp(userId: string, email: string) {
    // ... create the user ...
    this.cohorly.track("signed_up", { distinct_id: userId, method: "email" });
    this.cohorly.people.set(userId, { $email: email, plan: "free" });
  }
}
```

`CohorlyService` exposes the full mixpanel-node-style surface: `track`, `trackBatch`, `import`, `importBatch`, `people.*` (`set`, `set_once`, `increment`, `unset`, `delete_user`), `alias`, `flush`, and the raw client at `service.client`.

> Note: `people.unset` / `people.delete_user` are destructive and gated
> server-side - the server refuses them on the project token alone (they need
> an org-owner or superadmin `Authorization` credential this SDK does not
> send) and answers HTTP 200 with `{ status: 0, ..., refused }`. Use the
> dashboard or the admin privacy API for profile removal.

## Async configuration

```ts
import { ConfigModule, ConfigService } from "@nestjs/config";
import { CohorlyModule } from "@cohorly/nest";

CohorlyModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  isGlobal: true,
  useFactory: (config: ConfigService) => ({
    token: config.getOrThrow("COHORLY_TOKEN"),
    host: config.get("COHORLY_HOST") ?? "https://cohorly-service.velloalabs.com",
    debug: config.get("NODE_ENV") !== "production",
  }),
});
```

All [`@cohorly/node` config options](../sdk-node/README.md#configuration) are accepted (`host`, `flushIntervalMs`, `batchSize`, `debug`, `maxQueueSize`, `maxRetryDelayMs`), plus `token` (required) and `isGlobal`.

## Graceful shutdown

`CohorlyService` implements `OnApplicationShutdown`: when the Nest application closes it stops the SDK's flush timer and performs a final flush of queued events. To also cover process signals (SIGTERM etc), enable Nest's shutdown hooks:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
```
