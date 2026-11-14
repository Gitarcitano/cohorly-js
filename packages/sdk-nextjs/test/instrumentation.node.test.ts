import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOnRequestError,
  onRequestError,
} from "../src/instrumentation.node.js";
import {
  CONTEXT,
  clearCohorlyEnv,
  HOST,
  hangingFetch,
  REQUEST,
  recordingFetch,
  rejectingFetch,
  SECRETS,
  ServerComponentError,
} from "./request-error-fixtures.js";

const CLIENT_KEY = Symbol.for("cohorly.nextjs.node-client");

function resetClient() {
  delete (globalThis as Record<symbol, unknown>)[CLIENT_KEY];
}

beforeEach(() => {
  clearCohorlyEnv();
  resetClient();
});

afterEach(() => {
  resetClient();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("onRequestError (Node.js runtime)", () => {
  it("sends a server component error before the hook resolves", async () => {
    const { sent } = recordingFetch(30);
    const hook = createOnRequestError({ token: "tok", apiHost: HOST });

    await hook(new ServerComponentError("server component boom"), REQUEST, CONTEXT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${HOST}/track`);
    expect(sent[0].headers["X-Cohorly-Token"]).toBe("tok");
    expect(sent[0].events).toHaveLength(1);
    const { event, properties } = sent[0].events[0];
    expect(event).toBe("$exception");
    const list = properties.$exception_list as Array<{
      type: string;
      value: string;
      mechanism: { type: string; handled: boolean };
      stacktrace: { frames: unknown[] };
    }>;
    expect(list[0].type).toBe("Error");
    expect(list[0].value).toBe("server component boom");
    expect(list[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(list[0].mechanism).toMatchObject({ type: "nextjs.onRequestError", handled: false });
    expect(properties).toMatchObject({
      $exception_level: "error",
      route: "/boom",
      method: "GET",
      router_kind: "App Router",
      route_type: "render",
      render_source: "react-server-components",
      request_path: "/boom",
      digest: "1234567890",
      runtime: "node",
      distinct_id: "server",
    });
    expect(properties).not.toHaveProperty("revalidate_reason");
    expect(properties).not.toHaveProperty("render_type");
  });

  it("reads the token and host from the env", async () => {
    vi.stubEnv("COHORLY_TOKEN", "tok-env");
    vi.stubEnv("COHORLY_API_HOST", `${HOST}/`);
    const { sent } = recordingFetch();

    await onRequestError(new Error("boom"), REQUEST, CONTEXT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${HOST}/track`);
    expect(sent[0].headers["X-Cohorly-Token"]).toBe("tok-env");
  });

  it("resolves at flushTimeoutMs when the send hangs", async () => {
    const mock = hangingFetch();
    const hook = createOnRequestError({ token: "tok", apiHost: HOST, flushTimeoutMs: 50 });

    const started = Date.now();
    await expect(hook(new Error("boom"), REQUEST, CONTEXT)).resolves.toBeUndefined();

    expect(Date.now() - started).toBeLessThan(1000);
    expect(mock).toHaveBeenCalled();
  });

  it("never rejects", async () => {
    rejectingFetch();
    const failing = createOnRequestError({ token: "tok", apiHost: HOST, flushTimeoutMs: 50 });
    await expect(failing(new Error("boom"), REQUEST, CONTEXT)).resolves.toBeUndefined();

    resetClient();
    const { mock } = recordingFetch();
    const throwingHook = createOnRequestError({
      token: "tok",
      apiHost: HOST,
      beforeSendException: () => {
        throw new Error("hook");
      },
    });
    await expect(throwingHook(new Error("boom"), REQUEST, CONTEXT)).resolves.toBeUndefined();
    expect(mock).not.toHaveBeenCalled();

    resetClient();
    const malformed = createOnRequestError({ token: "tok", apiHost: HOST });
    await expect(
      malformed(new Error("boom"), undefined as never, null as never),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["a string", "plain string"],
    ["undefined", undefined],
    ["an object", { code: 42 }],
  ])("captures %s thrown instead of an Error", async (_label, thrown) => {
    const { sent } = recordingFetch();
    const hook = createOnRequestError({ token: "tok", apiHost: HOST });

    await expect(hook(thrown, REQUEST, CONTEXT)).resolves.toBeUndefined();

    expect(sent).toHaveLength(1);
    expect(sent[0].events[0].event).toBe("$exception");
  });

  it("drops the exception when beforeSendException returns null", async () => {
    const { mock } = recordingFetch();
    const hook = createOnRequestError({
      token: "tok",
      apiHost: HOST,
      beforeSendException: () => null,
    });

    await hook(new Error("boom"), REQUEST, CONTEXT);

    expect(mock).not.toHaveBeenCalled();
  });

  it("stamps VERCEL_GIT_COMMIT_SHA as the release", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    const { sent } = recordingFetch();

    await createOnRequestError({ token: "tok", apiHost: HOST })(
      new Error("boom"),
      REQUEST,
      CONTEXT,
    );

    expect(sent[0].events[0].properties).toMatchObject({
      $exception_release: "abc123",
      $app_version_string: "abc123",
    });
  });

  it("prefers options.release over VERCEL_GIT_COMMIT_SHA", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    const { sent } = recordingFetch();

    await createOnRequestError({ token: "tok", apiHost: HOST, release: "web@1.2.3" })(
      new Error("boom"),
      REQUEST,
      CONTEXT,
    );

    expect(sent[0].events[0].properties).toMatchObject({
      $exception_release: "web@1.2.3",
      $app_version_string: "web@1.2.3",
    });
  });

  it("sends no release when none is configured", async () => {
    const { sent } = recordingFetch();

    await createOnRequestError({ token: "tok", apiHost: HOST })(
      new Error("boom"),
      REQUEST,
      CONTEXT,
    );

    const { properties } = sent[0].events[0];
    expect(properties).not.toHaveProperty("$exception_release");
    expect(properties).not.toHaveProperty("$app_version_string");
  });

  it("never sends headers, cookies or the query string", async () => {
    const { sent } = recordingFetch();

    await createOnRequestError({ token: "tok", apiHost: HOST })(
      new Error("boom"),
      REQUEST,
      CONTEXT,
    );

    expect(sent[0].events[0].properties.request_path).toBe("/boom");
    for (const secret of SECRETS) expect(sent[0].body).not.toContain(secret);
  });

  it("does nothing without a token", async () => {
    const { mock } = recordingFetch();

    await onRequestError(new Error("boom"), REQUEST, CONTEXT);
    await createOnRequestError({ apiHost: HOST })(new Error("boom"), REQUEST, CONTEXT);

    expect(mock).not.toHaveBeenCalled();
    expect((globalThis as Record<symbol, unknown>)[CLIENT_KEY]).toBeUndefined();
  });

  it("reuses one client across calls, keeping the first config", async () => {
    const { sent } = recordingFetch();

    await createOnRequestError({ token: "tok-1", apiHost: HOST })(
      new Error("first"),
      REQUEST,
      CONTEXT,
    );
    const client = (globalThis as Record<symbol, unknown>)[CLIENT_KEY];
    await createOnRequestError({ token: "tok-2", apiHost: HOST })(
      new Error("second"),
      REQUEST,
      CONTEXT,
    );

    expect(client).toBeDefined();
    expect((globalThis as Record<symbol, unknown>)[CLIENT_KEY]).toBe(client);
    expect(sent.map((request) => request.headers["X-Cohorly-Token"])).toEqual([
      "tok-1",
      "tok-1",
    ]);
  });
});
