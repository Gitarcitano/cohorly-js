import type { CohorlyConfig } from "@cohorly/node";
import type { FactoryProvider, ModuleMetadata } from "@nestjs/common";
import type { CohorlyExceptionFilterOptions } from "./cohorly-exception.filter.js";

/**
 * Options for CohorlyModule.forRoot(): the @cohorly/node config + token.
 * Every @cohorly/node config key passes straight through, including
 * `flagSecret` / `flagPollIntervalMs` for local flag evaluation (ADR-0011);
 * the poller is stopped by `onApplicationShutdown`.
 */
export interface CohorlyModuleOptions
  extends CohorlyConfig,
    CohorlyExceptionFilterOptions {
  /** Cohorly project token (ingestion auth). Required. */
  token: string;
  /** Register the module globally so CohorlyService is injectable anywhere
   * without importing CohorlyModule again. Default false. */
  isGlobal?: boolean;
  /**
   * Register {@link CohorlyExceptionFilter} as a global filter (APP_FILTER):
   * 5xx and non-HTTP errors are reported, 4xx are not. Default false.
   */
  captureExceptions?: boolean;
}

/** Options for CohorlyModule.forRootAsync(). */
export interface CohorlyModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  /** Factory returning the module options (sync or async). */
  useFactory: (
    // biome-ignore lint/suspicious/noExplicitAny: mirrors NestJS FactoryProvider - injected deps are of arbitrary types.
    ...args: any[]
  ) =>
    | Promise<Omit<CohorlyModuleOptions, "isGlobal" | "captureExceptions">>
    | Omit<CohorlyModuleOptions, "isGlobal" | "captureExceptions">;
  /** Providers to inject into `useFactory`. */
  inject?: FactoryProvider["inject"];
  /** Register the module globally. Default false. */
  isGlobal?: boolean;
  /** Register the global exception filter. Default false. */
  captureExceptions?: boolean;
}
