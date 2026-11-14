import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOnRequestError,
  onRequestError,
} from "../src/instrumentation.edge.js";
import { withoutReservedKeys } from "../src/request-error.js";
import { LIB_VERSION } from "../src/version.js";
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

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

beforeEach(() => {
  clearCohorlyEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("onRequestError (Edge runtime)", () => {
  it("POSTs the exception to /track before the hook resolves", async () => {
    const { sent } = recordingFetch(30);
    const hook = createOnRequestError({ token: "tok", apiHost: `${HOST}/` });

    await hook(new ServerComponentError("edge boom"), REQUEST, {
      ...CONTEXT,
      routeType: "route",
      revalidateReason: "stale",
      renderType: "dynamic",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${HOST}/track`);
    expect(sent[0].headers).toMatchObject({
      "content-type": "application/json",
      "X-Cohorly-Token": "tok",
    });
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
    expect(list[0].value).toBe("edge boom");
    expect(list[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(list[0].mechanism).toMatchObject({ type: "nextjs.onRequestError", handled: false });
    expect(properties).toMatchObject({
      $exception_level: "error",
      $lib: "nextjs-edge",
      $lib_version: LIB_VERSION,
      runtime: "edge",
      distinct_id: "server",
      route: "/boom",
      method: "GET",
      router_kind: "App Router",
      route_type: "route",
      render_source: "react-server-components",
      revalidate_reason: "stale",
      render_type: "dynamic",
      request_path: "/boom",
      digest: "1234567890",
    });
    expect(typeof properties.time).toBe("number");
    expect(properties.$insert_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(properties).not.toHaveProperty("server_name");
  });

  it("uses serverName as server_name and distinct_id", async () => {
    const { sent } = recordingFetch();

    await createOnRequestError({ token: "tok", apiHost: HOST, serverName: "edge-iad1" })(
      new Error("boom"),
      REQUEST,
      CONTEXT,
    );

    expect(sent[0].events[0].properties).toMatchObject({
      server_name: "edge-iad1",
      distinct_id: "edge-iad1",
    });
  });

  it("never lets a tag overwrite a reserved key", () => {
    expect(
      withoutReservedKeys({
        $exception_level: "x",
        $exception_release: "x",
        $lib: "x",
        $lib_version: "x",
        distinct_id: "x",
        time: "x",
        $insert_id: "x",
        token: "x",
        error_title: "x",
        route: "/a",
      }),
    ).toEqual({ route: "/a" });
  });

  it("reads the token, host and release from the env", async () => {
    vi.stubEnv("COHORLY_TOKEN", "tok-env");
    vi.stubEnv("COHORLY_API_HOST", HOST);
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    const { sent } = recordingFetch();

    await onRequestError(new Error("boom"), REQUEST, CONTEXT);

    expect(sent[0].url).toBe(`${HOST}/track`);
    expect(sent[0].headers["X-Cohorly-Token"]).toBe("tok-env");
    expect(sent[0].events[0].properties).toMatchObject({
      $exception_release: "abc123",
      $app_version_string: "abc123",
    });
  });

  it("prefers options.release and dist over the env", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    const { sent } = recordingFetch();

    await createOnRequestError({ token: "tok", apiHost: HOST, release: "web@1.2.3", dist: "b7" })(
      new Error("boom"),
      REQUEST,
      CONTEXT,
    );

    expect(sent[0].events[0].properties).toMatchObject({
      $exception_release: "web@1.2.3",
      $app_version_string: "web@1.2.3",
      $exception_dist: "b7",
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
    expect(properties).not.toHaveProperty("$exception_dist");
  });

  it("resolves at flushTimeoutMs when the send hangs, aborting it", async () => {
    const mock = hangingFetch();
    const hook = createOnRequestError({ token: "tok", apiHost: HOST, flushTimeoutMs: 50 });

    const started = Date.now();
    await expect(hook(new Error("boom"), REQUEST, CONTEXT)).resolves.toBeUndefined();

    expect(Date.now() - started).toBeLessThan(1000);
    const init = mock.mock.calls[0][1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });

  it("resolves at flushTimeoutMs even when fetch ignores the abort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const hook = createOnRequestError({ token: "tok", apiHost: HOST, flushTimeoutMs: 50 });

    const started = Date.now();
    await expect(hook(new Error("boom"), REQUEST, CONTEXT)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("never rejects", async () => {
    rejectingFetch();
    const hook = createOnRequestError({ token: "tok", apiHost: HOST });
    await expect(hook(new Error("boom"), REQUEST, CONTEXT)).resolves.toBeUndefined();
    await expect(hook("plain string", REQUEST, CONTEXT)).resolves.toBeUndefined();
    await expect(hook(undefined, REQUEST, CONTEXT)).resolves.toBeUndefined();
    await expect(hook({ code: 42 }, REQUEST, CONTEXT)).resolves.toBeUndefined();
    await expect(
      hook(new Error("boom"), undefined as never, null as never),
    ).resolves.toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(hook(new Error("boom"), REQUEST, CONTEXT)).resolves.toBeUndefined();
  });

  it("drops the exception when beforeSendException returns null or throws", async () => {
    const { mock } = recordingFetch();

    await createOnRequestError({ token: "tok", apiHost: HOST, beforeSendException: () => null })(
      new Error("boom"),
      REQUEST,
      CONTEXT,
    );
    await expect(
      createOnRequestError({
        token: "tok",
        apiHost: HOST,
        beforeSendException: () => {
          throw new Error("hook");
        },
      })(new Error("boom"), REQUEST, CONTEXT),
    ).resolves.toBeUndefined();

    expect(mock).not.toHaveBeenCalled();
  });

  it("sends what beforeSendException returns", async () => {
    const { sent } = recordingFetch();

    await createOnRequestError({
      token: "tok",
      apiHost: HOST,
      beforeSendException: (event) => ({
        ...event,
        properties: { ...event.properties, scrubbed: true },
      }),
    })(new Error("boom"), REQUEST, CONTEXT);

    expect(sent[0].events[0].properties.scrubbed).toBe(true);
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
  });
});

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
const NODE_BUILTINS = new Set([
  "fs",
  "fs/promises",
  "path",
  "os",
  "crypto",
  "url",
  "util",
  "stream",
  "buffer",
  "async_hooks",
  "child_process",
  "http",
  "https",
  "net",
  "zlib",
]);

const CORE_ENTRY = resolve(SRC, "../../sdk-core/src/index.ts");

/**
 * Every specifier imported by `entry` and, recursively, by the relative
 * modules it imports, following `@cohorly/core` into its own source.
 */
function importGraph(entry: string) {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const sources: string[] = [];
  const walk = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    sources.push(source);
    for (const [, specifier] of source.matchAll(IMPORT_SPECIFIER)) {
      if (specifier.startsWith(".")) {
        walk(resolve(dirname(file), specifier).replace(/\.js$/, ".ts"));
      } else {
        bare.add(specifier);
        if (specifier === "@cohorly/core") walk(CORE_ENTRY);
      }
    }
  };
  walk(entry);
  return { visited, bare, sources };
}

describe("Edge entry point", () => {
  it("imports no Node.js API, directly or through a relative module", () => {
    const { visited, bare, sources } = importGraph(resolve(SRC, "instrumentation.edge.ts"));

    expect(visited).toContain(resolve(SRC, "request-error.ts"));
    expect(bare).toContain("@cohorly/core");
    for (const specifier of bare) {
      expect(specifier).not.toMatch(/^@cohorly\/node(\/|$)/);
      expect(specifier.startsWith("node:")).toBe(false);
      expect(NODE_BUILTINS.has(specifier)).toBe(false);
    }
    for (const source of sources) {
      expect(source).not.toMatch(/process\.(cwd|version|versions|on|exit)\b/);
    }
  });
});
