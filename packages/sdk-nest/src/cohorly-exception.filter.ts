import type { ArgumentsHost, HttpServer } from "@nestjs/common";
import { Catch, HttpException, Inject, Optional } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { COHORLY_MODULE_OPTIONS } from "./cohorly.constants.js";
import { CohorlyService } from "./cohorly.service.js";

/** Options of {@link CohorlyExceptionFilter}; also accepted by CohorlyModule. */
export interface CohorlyExceptionFilterOptions {
  /** Who hit the error, e.g. from the authenticated request. Default: the server id. */
  distinctId?: (host: ArgumentsHost) => string | undefined;
}

interface RequestLike {
  method?: unknown;
  url?: unknown;
  originalUrl?: unknown;
  route?: { path?: unknown };
  routeOptions?: { url?: unknown };
}

/**
 * The status Nest's default filter answers with for `exception`. Reporting
 * goes by this status, not by the exception's class: a non-HttpException
 * that carries a numeric `statusCode` (http-errors, e.g. body-parser's 413)
 * is answered with that status by BaseExceptionFilter, so a 4xx one is a
 * client error and is NOT reported, like any other 4xx (VEL-1763).
 */
function responseStatus(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  // Same test as BaseExceptionFilter.isHttpError: statusCode and message.
  const candidate = exception as { statusCode?: unknown; message?: unknown } | null;
  if (
    candidate &&
    typeof candidate.statusCode === "number" &&
    candidate.message
  ) {
    return candidate.statusCode;
  }
  return 500;
}

/** Route pattern when the framework knows it (`/users/:id`), else the path; never the query. */
function routeOf(request: RequestLike): string | undefined {
  const pattern = request.route?.path ?? request.routeOptions?.url;
  if (typeof pattern === "string" && pattern) return pattern;
  const url = request.originalUrl ?? request.url;
  return typeof url === "string" ? url.split("?")[0] : undefined;
}

/**
 * Global exception filter that reports server errors to Cohorly: any
 * `HttpException` with status >= 500 and anything that is not an
 * `HttpException` (Nest answers those with 500, or with an http-errors
 * `statusCode`). Client errors (4xx) are not reported. The response is always
 * Nest's default one: the filter extends `BaseExceptionFilter` and hands
 * every exception to it after capturing.
 *
 * HTTP only: BaseExceptionFilter answers through the HTTP adapter, so in RPC
 * and WebSocket contexts the error is captured (without tags) and delegated,
 * and the outcome for the client is whatever Nest does there.
 *
 * Tags are `http.method` and `http.route` only - never the body, headers,
 * cookies or query string. Register it with
 * `CohorlyModule.forRoot({ captureExceptions: true })`.
 */
@Catch()
export class CohorlyExceptionFilter extends BaseExceptionFilter {
  constructor(
    @Inject(CohorlyService) private readonly cohorly: CohorlyService,
    @Optional()
    @Inject(COHORLY_MODULE_OPTIONS)
    private readonly options: CohorlyExceptionFilterOptions = {},
    applicationRef?: HttpServer,
  ) {
    super(applicationRef);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    try {
      if (responseStatus(exception) >= 500) this.capture(exception, host);
    } catch {
      // Reporting must never change how the request is answered.
    }
    super.catch(exception, host);
  }

  private capture(exception: unknown, host: ArgumentsHost): void {
    let distinctId: string | undefined;
    try {
      distinctId = this.options?.distinctId?.(host);
    } catch {
      distinctId = undefined;
    }
    const tags: Record<string, string> = {};
    if (host.getType() === "http") {
      const request = host.switchToHttp().getRequest<RequestLike>() ?? {};
      if (typeof request.method === "string") tags["http.method"] = request.method;
      const route = routeOf(request);
      if (route) tags["http.route"] = route;
    }
    this.cohorly.captureException(exception, {
      distinctId,
      tags,
      mechanism: { type: "nestjs", handled: false },
    });
  }
}
