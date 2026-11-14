import "reflect-metadata";
import {
  type ArgumentsHost,
  BadRequestException,
  type HttpServer,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { type AbstractHttpAdapter, APP_FILTER, BaseExceptionFilter, HttpAdapterHost } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CohorlyExceptionFilter,
  CohorlyModule,
  CohorlyService,
} from "../src/index.js";

const { FakeClient, instances } = vi.hoisted(() => {
  const instances: FakeClient[] = [];
  class FakeClient {
    token: string;
    config: Record<string, unknown>;
    captureException = vi.fn().mockReturnValue(null);
    addBreadcrumb = vi.fn();
    withCohorly = vi.fn((handler: unknown) => handler);
    flushWithTimeout = vi.fn().mockResolvedValue(true);
    shutdown = vi.fn().mockResolvedValue(undefined);
    constructor(token: string, config: Record<string, unknown>) {
      this.token = token;
      this.config = config;
      instances.push(this);
    }
  }
  return { FakeClient, instances };
});

vi.mock("@cohorly/node", () => ({ CohorlyNode: FakeClient }));

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  route?: { path: string };
  headers?: Record<string, string>;
  body?: unknown;
  query?: unknown;
}

function httpHost(request: FakeRequest, type = "http"): ArgumentsHost {
  const response = { kind: "response" };
  return {
    getType: () => type,
    getArgs: () => [request, response],
    getArgByIndex: (index: number) => [request, response][index],
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
    switchToRpc: () => ({ getData: () => request, getContext: () => undefined }),
    switchToWs: () => ({ getData: () => request, getClient: () => undefined }),
  } as unknown as ArgumentsHost;
}

/**
 * The slice of Nest's HTTP adapter BaseExceptionFilter answers through. It
 * only records the calls: status and body are computed by the real
 * BaseExceptionFilter, never by the mock.
 */
function fakeHttpAdapter() {
  return {
    reply: vi.fn(),
    isHeadersSent: vi.fn(() => false),
    end: vi.fn(),
  };
}

function setup(options: ConstructorParameters<typeof CohorlyExceptionFilter>[1] = {}) {
  const adapter = fakeHttpAdapter();
  const service = { captureException: vi.fn() };
  const filter = new CohorlyExceptionFilter(
    service as unknown as CohorlyService,
    options,
    adapter as unknown as HttpServer,
  );
  const superCatch = vi.spyOn(BaseExceptionFilter.prototype, "catch");
  return { adapter, service, filter, superCatch };
}

const GET_ORDER: FakeRequest = { method: "GET", url: "/orders/42", route: { path: "/orders/:id" } };

describe("CohorlyExceptionFilter", () => {
  it.each([
    ["HttpException 500", new InternalServerErrorException(), 500],
    ["HttpException 503", new ServiceUnavailableException(), 503],
    ["a plain Error (answered 500)", new Error("db down"), 500],
  ])("captures %s and still answers with Nest's default response", (_name, exception, status) => {
    const { adapter, service, filter, superCatch } = setup();
    const host = httpHost(GET_ORDER);
    filter.catch(exception, host);

    expect(service.captureException).toHaveBeenCalledTimes(1);
    expect(service.captureException).toHaveBeenCalledWith(exception, {
      distinctId: undefined,
      tags: { "http.method": "GET", "http.route": "/orders/:id" },
      mechanism: { type: "nestjs", handled: false },
    });
    expect(superCatch).toHaveBeenCalledWith(exception, host);
    expect(adapter.reply).toHaveBeenCalledWith(
      { kind: "response" },
      expect.anything(),
      status,
    );
  });

  it.each([
    ["404", new NotFoundException(), 404],
    ["400", new BadRequestException(), 400],
    ["401", new UnauthorizedException(), 401],
    [
      "a non-HttpException with statusCode 413 (http-errors, body-parser), since Nest answers it 413",
      Object.assign(new Error("too large"), { statusCode: 413 }),
      413,
    ],
  ])("ignores %s and still answers with Nest's default response", (_name, exception, status) => {
    const { adapter, service, filter, superCatch } = setup();
    const host = httpHost(GET_ORDER);
    filter.catch(exception, host);

    expect(service.captureException).not.toHaveBeenCalled();
    expect(superCatch).toHaveBeenCalledWith(exception, host);
    expect(adapter.reply).toHaveBeenCalledWith({ kind: "response" }, expect.anything(), status);
  });

  it("tags only method and path: no query string, headers, cookies or body", () => {
    const { service, filter } = setup();
    filter.catch(
      new Error("boom"),
      httpHost({
        method: "POST",
        originalUrl: "/checkout/pay?card=4111111111111111",
        url: "/pay?card=4111111111111111",
        headers: { authorization: "Bearer secret-token", cookie: "sid=secret-cookie" },
        body: { password: "secret-password" },
        query: { card: "4111111111111111" },
      }),
    );
    const [, options] = service.captureException.mock.calls[0];
    expect(options.tags).toEqual({ "http.method": "POST", "http.route": "/checkout/pay" });
    const serialized = JSON.stringify(options);
    for (const secret of ["4111", "secret-token", "secret-cookie", "secret-password"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("uses the distinctId callback, and survives one that throws", () => {
    const distinctId = vi.fn((host: ArgumentsHost) =>
      (host.switchToHttp().getRequest() as { user?: { id: string } }).user?.id,
    );
    const { service, filter } = setup({ distinctId });
    const host = httpHost({ ...GET_ORDER, user: { id: "user-7" } } as FakeRequest);
    filter.catch(new Error("boom"), host);
    expect(distinctId).toHaveBeenCalledWith(host);
    expect(service.captureException.mock.calls[0][1].distinctId).toBe("user-7");

    const throwing = setup({
      distinctId: () => {
        throw new Error("no user");
      },
    });
    throwing.filter.catch(new Error("boom"), httpHost(GET_ORDER));
    expect(throwing.service.captureException).toHaveBeenCalledTimes(1);
    expect(throwing.service.captureException.mock.calls[0][1].distinctId).toBeUndefined();
  });

  it("answers normally even when capturing throws", () => {
    const { adapter, service, filter } = setup();
    service.captureException.mockImplementation(() => {
      throw new Error("sdk broke");
    });
    filter.catch(new Error("boom"), httpHost(GET_ORDER));
    expect(adapter.reply).toHaveBeenCalledWith({ kind: "response" }, expect.anything(), 500);
  });

  it("rpc context (not supported for the response): still captures, without tags, and delegates to BaseExceptionFilter", () => {
    const { service, filter, superCatch } = setup();
    const host = httpHost({ method: "GET", url: "/x" }, "rpc");
    filter.catch(new Error("rpc boom"), host);
    expect(service.captureException.mock.calls[0][1].tags).toEqual({});
    expect(superCatch).toHaveBeenCalled();
  });
});

describe("CohorlyModule captureExceptions", () => {
  function hasAppFilter(providers: unknown[] | undefined): boolean {
    return (providers ?? []).some(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as { provide?: unknown }).provide === APP_FILTER &&
        (p as { useExisting?: unknown }).useExisting === CohorlyExceptionFilter,
    );
  }

  it("registers the filter as APP_FILTER only when asked", () => {
    expect(hasAppFilter(CohorlyModule.forRoot({ token: "t" }).providers)).toBe(false);
    expect(
      hasAppFilter(CohorlyModule.forRoot({ token: "t", captureExceptions: true }).providers),
    ).toBe(true);
    expect(
      hasAppFilter(CohorlyModule.forRootAsync({ useFactory: () => ({ token: "t" }) }).providers),
    ).toBe(false);
    expect(
      hasAppFilter(
        CohorlyModule.forRootAsync({
          useFactory: () => ({ token: "t" }),
          captureExceptions: true,
        }).providers,
      ),
    ).toBe(true);
  });

  it("wires the filter to the module's client and the app's HTTP adapter, and keeps filter options out of the client config", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CohorlyModule.forRoot({
          token: "tok",
          release: "api@1.0.0",
          captureUncaught: true,
          captureExceptions: true,
          distinctId: () => "from-option",
        }),
      ],
    }).compile();
    // What NestFactory.create does with the platform adapter; the filter
    // reaches it through BaseExceptionFilter's injected HttpAdapterHost.
    const adapter = fakeHttpAdapter();
    moduleRef.get(HttpAdapterHost).httpAdapter = adapter as unknown as AbstractHttpAdapter;

    expect(instances[0].config).toEqual({ release: "api@1.0.0", captureUncaught: true });
    const filter = moduleRef.get(CohorlyExceptionFilter);
    filter.catch(new Error("boom"), httpHost(GET_ORDER));
    expect(instances[0].captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ distinctId: "from-option" }),
    );
    expect(adapter.reply).toHaveBeenCalledWith(
      { kind: "response" },
      expect.objectContaining({ statusCode: 500 }),
      500,
    );

    // The inverse through the same wiring: a 404 is answered, not captured.
    filter.catch(new NotFoundException(), httpHost(GET_ORDER));
    expect(instances[0].captureException).toHaveBeenCalledTimes(1);
    expect(adapter.reply).toHaveBeenLastCalledWith({ kind: "response" }, expect.anything(), 404);
    await moduleRef.close();
  });

  it("has no filter when captureExceptions is off (the inverse)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CohorlyModule.forRoot({ token: "tok" })],
    }).compile();
    expect(() => moduleRef.get(CohorlyExceptionFilter)).toThrow();
    await moduleRef.close();
  });
});

describe("CohorlyService error tracking", () => {
  it("delegates captureException, addBreadcrumb, withCohorly and flushWithTimeout", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CohorlyModule.forRoot({ token: "tok" })],
    }).compile();
    const service = moduleRef.get(CohorlyService);
    const client = instances[0];

    const error = new Error("x");
    service.captureException(error, { distinctId: "u1" });
    expect(client.captureException).toHaveBeenCalledWith(error, { distinctId: "u1" });

    service.addBreadcrumb({ category: "step" });
    expect(client.addBreadcrumb).toHaveBeenCalledWith({ category: "step" });

    const handler = async () => "ok";
    service.withCohorly(handler, { flushTimeoutMs: 100 });
    expect(client.withCohorly).toHaveBeenCalledWith(handler, { flushTimeoutMs: 100 });

    await expect(service.flushWithTimeout(50)).resolves.toBe(true);
    expect(client.flushWithTimeout).toHaveBeenCalledWith(50);
    await moduleRef.close();
  });
});
