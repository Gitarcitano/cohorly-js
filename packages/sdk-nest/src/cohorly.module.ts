import type { DynamicModule, Provider } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { CohorlyExceptionFilter } from "./cohorly-exception.filter.js";
import { COHORLY_MODULE_OPTIONS } from "./cohorly.constants.js";
import { CohorlyService } from "./cohorly.service.js";
import type {
  CohorlyModuleAsyncOptions,
  CohorlyModuleOptions,
} from "./interfaces.js";

/** The global exception filter, when `captureExceptions` is on. */
function exceptionFilterProviders(captureExceptions: boolean | undefined): Provider[] {
  if (!captureExceptions) return [];
  return [
    CohorlyExceptionFilter,
    { provide: APP_FILTER, useExisting: CohorlyExceptionFilter },
  ];
}

/**
 * Cohorly NestJS module. Register once at the application root:
 *
 * ```ts
 * CohorlyModule.forRoot({ token: process.env.COHORLY_TOKEN!, isGlobal: true })
 * ```
 *
 * or asynchronously (e.g. with @nestjs/config):
 *
 * ```ts
 * CohorlyModule.forRootAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (config: ConfigService) => ({
 *     token: config.getOrThrow("COHORLY_TOKEN"),
 *     host: config.get("COHORLY_HOST"),
 *   }),
 * })
 * ```
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS dynamic modules must be a class decorated with @Module.
export class CohorlyModule {
  static forRoot(options: CohorlyModuleOptions): DynamicModule {
    return {
      module: CohorlyModule,
      global: options.isGlobal ?? false,
      providers: [
        { provide: COHORLY_MODULE_OPTIONS, useValue: options },
        CohorlyService,
        ...exceptionFilterProviders(options.captureExceptions),
      ],
      exports: [CohorlyService],
    };
  }

  static forRootAsync(options: CohorlyModuleAsyncOptions): DynamicModule {
    return {
      module: CohorlyModule,
      global: options.isGlobal ?? false,
      imports: options.imports ?? [],
      providers: [
        {
          provide: COHORLY_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        CohorlyService,
        ...exceptionFilterProviders(options.captureExceptions),
      ],
      exports: [CohorlyService],
    };
  }
}
