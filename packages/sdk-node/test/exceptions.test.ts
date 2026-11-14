import { afterEach, describe, expect, it, vi } from "vitest";
import { CohorlyNode } from "../src/index.js";
import type { CohorlyConfig, CohorlyTransport } from "../src/types.js";
import { createMockTransport, type SentRequest, trackBodies } from "./helpers.js";

type SentEvent = { event: string; properties: Record<string, any> };

const clients: CohorlyNode[] = [];

function makeClient(config: CohorlyConfig = {}): CohorlyNode {
  const client = new CohorlyNode("tok", { flushIntervalMs: 0, ...config });
  clients.push(client);
  return client;
}

afterEach(() => {
  // Not awaited: shutdown() ends in a final flush, and some tests use a
  // transport that never answers. The timer and listeners go synchronously.
  for (const client of clients.splice(0)) void client.shutdown();
  vi.restoreAllMocks();
});

function sent(requests: SentRequest[]): SentEvent[] {
  return trackBodies(requests).flat() as SentEvent[];
}

function sentExceptions(requests: SentRequest[]): SentEvent[] {
  return sent(requests).filter((e) => e.event === "$exception");
}

/** A transport whose status the test flips; 0 = network error. */
function switchableTransport(initial = 200) {
  let status = initial;
  const mock = createMockTransport(() => ({ status }));
  return {
    ...mock,
    setStatus(next: number) {
      status = next;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("captureException", () => {
  it("queues one $exception with the default and context properties", () => {
    const client = makeClient({ transport: createMockTransport().transport });
    const evt = client.captureException(new Error("boom"), { distinctId: "u1" });

    expect(evt).not.toBeNull();
    const p = evt!.properties;
    expect(evt!.event).toBe("$exception");
    expect(p.distinct_id).toBe("u1");
    expect(typeof p.time).toBe("number");
    expect(typeof p.$insert_id).toBe("string");
    expect(p.$lib).toBe("node");
    expect(typeof p.$lib_version).toBe("string");
    expect(p.$exception_level).toBe("error");
    expect(p.runtime).toBe("node");
    expect(p.node_version).toBe(process.version);
    const list = p.$exception_list as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      type: "Error",
      value: "boom",
      mechanism: { handled: true, type: "generic", synthetic: false },
    });
    // Nothing optional is stamped when it was not asked for.
    for (const key of [
      "$exception_fingerprint",
      "$exception_release",
      "$exception_dist",
      "$exception_breadcrumbs",
      "error_title",
      "server_name",
      "$app_version_string",
    ]) {
      expect(p).not.toHaveProperty(key);
    }
  });

  it("stamps fingerprint, title, level, server_name and the cause chain when given", () => {
    const client = makeClient({
      transport: createMockTransport().transport,
      serverName: "api-1",
    });
    const root = new Error("db down");
    const evt = client.captureException(new Error("query failed", { cause: root }), {
      level: "warning",
      fingerprint: "db-outage",
      title: "Query failed",
    });
    const p = evt!.properties;
    expect(p.$exception_level).toBe("warning");
    expect(p.$exception_fingerprint).toBe("db-outage");
    expect(p.error_title).toBe("Query failed");
    expect(p.server_name).toBe("api-1");
    const list = p.$exception_list as Array<{ value: string; mechanism: { type: string } }>;
    expect(list.map((e) => e.value)).toEqual(["query failed", "db down"]);
    expect(list[1].mechanism.type).toBe("chained");
  });

  it("turns an invalid level into error", () => {
    const client = makeClient({ transport: createMockTransport().transport });
    const evt = client.captureException(new Error("x"), { level: "panic" as any });
    expect(evt!.properties.$exception_level).toBe("error");
  });

  it("falls back to serverName, else a fixed 'server' id, never a new id per error", () => {
    const anonymous = makeClient({ transport: createMockTransport().transport });
    const a = anonymous.captureException(new Error("a"))!;
    const b = anonymous.captureException(new Error("b"))!;
    expect(a.properties.distinct_id).toBe("server");
    expect(b.properties.distinct_id).toBe("server");

    const named = makeClient({ transport: createMockTransport().transport, serverName: "worker-7" });
    expect(named.captureException(new Error("c"))!.properties.distinct_id).toBe("worker-7");
    expect(
      named.captureException(new Error("d"), { distinctId: "u9" })!.properties.distinct_id,
    ).toBe("u9");
  });

  it("tags and extra become properties (tags win) but never override reserved keys", () => {
    const client = makeClient({ transport: createMockTransport().transport });
    const evt = client.captureException(new Error("x"), {
      distinctId: "u1",
      title: "Real title",
      tags: {
        plan: "pro",
        $exception_level: "info",
        error_title: "fake",
        distinct_id: "evil",
        time: 1,
        $insert_id: "fixed",
        $lib: "fake",
        $lib_version: "0.0.0",
        token: "stolen",
      },
      extra: { plan: "free", attempt: 3, $exception_list: [], $exception_release: "fake" },
    })!;
    const p = evt.properties;
    expect(p.plan).toBe("pro");
    expect(p.attempt).toBe(3);
    expect(p.$exception_level).toBe("error");
    expect(p.error_title).toBe("Real title");
    expect(p.distinct_id).toBe("u1");
    expect(p.time).not.toBe(1);
    expect(p.$insert_id).not.toBe("fixed");
    expect(p.$lib).toBe("node");
    expect(p.$lib_version).not.toBe("0.0.0");
    expect(p).not.toHaveProperty("token");
    expect(p).not.toHaveProperty("$exception_release");
    expect((p.$exception_list as unknown[]).length).toBe(1);
  });

  it("never throws and returns null for an empty list", () => {
    const client = makeClient({ transport: createMockTransport().transport });
    const hostile = {
      get message(): string {
        throw new Error("getter");
      },
    };
    expect(() => client.captureException(hostile)).not.toThrow();
    expect(client.captureException(undefined)!.properties.$exception_list[0]).toMatchObject({
      mechanism: { synthetic: true },
    });
    expect(client.captureExceptionList([])).toBeNull();
    expect(client.captureExceptionList("nope" as any)).toBeNull();
  });

  it("captureExceptionList queues a caller-built list as is", () => {
    const client = makeClient({ transport: createMockTransport().transport });
    const evt = client.captureExceptionList(
      [{ type: "Timeout", value: "took 30s", mechanism: { handled: false, type: "custom", synthetic: true } }],
      { distinctId: "job-1", level: "fatal" },
    )!;
    expect(evt.properties.$exception_list[0].type).toBe("Timeout");
    expect(evt.properties.$exception_level).toBe("fatal");
    expect(evt.properties.distinct_id).toBe("job-1");
  });

  it("sends right away, without waiting for batchSize", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport }); // batchSize 20, no timer
    client.captureException(new Error("now"));
    await vi.waitFor(() => expect(sentExceptions(requests)).toHaveLength(1));
  });

  it("a tracked event alone still waits for batchSize (the inverse)", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport });
    await client.track("e", { distinct_id: "u" });
    await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(0);
  });
});

describe("values that cannot be serialized", () => {
  // Like the real transport, serialize the body: a throw here is what used to wedge the queue.
  const serializingTransport = () => {
    const bodies: string[] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      bodies.push(JSON.stringify(body));
    };
    return { transport, bodies };
  };

  it("a circular extra or tag is kept as a string and the exception is delivered, with the events behind it", async () => {
    const { transport, bodies } = serializingTransport();
    const client = makeClient({ transport });
    const req: Record<string, unknown> = { method: "GET" };
    req.self = req;
    await client.track("later", { distinct_id: "u" });
    client.captureException(new Error("boom"), {
      extra: { req, big: BigInt(1) },
      tags: { origin: "http" },
    });
    expect(await client.flushWithTimeout()).toBe(true);
    const sentBodies = bodies.map((b) => JSON.parse(b) as SentEvent[]).flat();
    const exception = sentBodies.find((e) => e.event === "$exception");
    expect(typeof exception?.properties.req).toBe("string");
    expect(typeof exception?.properties.big).toBe("string");
    expect(exception?.properties.origin).toBe("http");
    expect(sentBodies.some((e) => e.event === "later")).toBe(true);
    expect(client.exceptionQueueSize).toBe(0);
  });

  it("an exception that a beforeSendException hook made circular is dropped, never queued", async () => {
    const { transport, bodies } = serializingTransport();
    const client = makeClient({
      transport,
      beforeSendException: (evt) => {
        (evt.properties as Record<string, unknown>).loop = evt;
        return evt;
      },
    });
    expect(client.captureException(new Error("boom"))).toBeNull();
    expect(client.exceptionQueueSize).toBe(0);
    await client.track("ok", { distinct_id: "u" });
    expect(await client.flushWithTimeout()).toBe(true);
    expect(bodies).toHaveLength(1);
  });
});

describe("serverName", () => {
  it("an empty serverName is not used: the exception falls back to the fixed id and carries no server_name", () => {
    const client = makeClient({ transport: createMockTransport().transport, serverName: "" });
    const evt = client.captureException(new Error("boom"));
    expect(evt?.properties.distinct_id).toBe("server");
    expect(evt?.properties).not.toHaveProperty("server_name");
  });
});

describe("beforeSendException", () => {
  it("drops on null, on a non-object and on a throw; never sends unfiltered", async () => {
    for (const hook of [
      () => null,
      () => 42,
      () => {
        throw new Error("hook");
      },
    ]) {
      const { transport, requests } = createMockTransport();
      const client = makeClient({ transport, beforeSendException: hook as any });
      expect(client.captureException(new Error("secret"))).toBeNull();
      expect(client.exceptionQueueSize).toBe(0);
      await client.flush();
      expect(sentExceptions(requests)).toHaveLength(0);
    }
  });

  it("sends the event the hook returned, not the one it was given", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({
      transport,
      beforeSendException(event) {
        // A new object: the original still carries the secret.
        const { secret_token: _dropped, ...rest } = event.properties;
        return { ...event, properties: { ...rest, scrubbed: true } };
      },
    });
    client.captureException(new Error("x"), { extra: { secret_token: "s3cr3t-value" } });
    await client.flush();
    const body = JSON.stringify(requests.map((r) => r.body));
    expect(body).not.toContain("s3cr3t-value");
    const p = sentExceptions(requests)[0].properties;
    expect(p.scrubbed).toBe(true);
    expect(p).not.toHaveProperty("secret_token");
  });
});

describe("release, dist and appVersion", () => {
  it("release: $exception_release on exceptions only (ADR-0019), $app_version_string on every event", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport, release: "api@1.2.3", dist: "build-9" });
    await client.track("e", { distinct_id: "u" });
    await client.track("e2", { distinct_id: "u", $app_version_string: "mine" });
    client.captureException(new Error("x"));
    await client.flush();

    const events = sent(requests);
    const tracked = events.filter((e) => e.event !== "$exception");
    expect(tracked.map((e) => e.properties.$app_version_string)).toEqual(["api@1.2.3", "mine"]);
    expect(tracked[0].properties).not.toHaveProperty("$exception_release");
    const exception = sentExceptions(requests)[0].properties;
    expect(exception.$exception_release).toBe("api@1.2.3");
    expect(exception.$exception_dist).toBe("build-9");
    expect(exception.$app_version_string).toBe("api@1.2.3");
  });

  it("appVersion overrides only $app_version_string", () => {
    const client = makeClient({
      transport: createMockTransport().transport,
      release: "api@1.2.3",
      appVersion: "1.2",
    });
    const p = client.captureException(new Error("x"))!.properties;
    expect(p.$exception_release).toBe("api@1.2.3");
    expect(p.$app_version_string).toBe("1.2");
  });

  it("stamps nothing without release or appVersion", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport });
    await client.track("e", { distinct_id: "u" });
    await client.flush();
    expect(sent(requests)[0].properties).not.toHaveProperty("$app_version_string");
  });
});

describe("frames", () => {
  const stack = [
    "Error: boom",
    "    at handler (file:///srv/app/src/my%20handler.js:10:5)",
    "    at async run (file:///srv/app/node_modules/lib/index.js:3:1)",
    "    at new Promise (<anonymous>)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "    at /srv/app/dist/server.js:7:9",
    "    at /srv/other/x.js:1:1",
  ].join("\n");

  function framesFor(projectRoot: string) {
    const client = makeClient({ transport: createMockTransport().transport, projectRoot });
    const error = new Error("boom");
    error.stack = stack;
    return client.captureException(error)!.properties.$exception_list[0].stacktrace.frames as Array<
      Record<string, unknown>
    >;
  }

  it("relativizes paths inside projectRoot, decodes file:// URLs, keeps the rest as is", () => {
    const frames = framesFor("/srv/app");
    // Oldest call first, crashing frame last.
    expect(frames.map((f) => [f.filename, f.abs_path, f.in_app])).toEqual([
      ["/srv/other/x.js", "/srv/other/x.js", true],
      ["dist/server.js", "dist/server.js", true],
      ["node:internal/process/task_queues", "node:internal/process/task_queues", false],
      ["<anonymous>", "<anonymous>", false],
      ["node_modules/lib/index.js", "node_modules/lib/index.js", false],
      ["src/my handler.js", "src/my handler.js", true],
    ]);
    expect(frames[5]).toMatchObject({ function: "handler", lineno: 10, colno: 5 });
    expect(frames[4]).toMatchObject({ function: "run" });
  });

  it("leaves every path untouched when none is inside projectRoot", () => {
    const frames = framesFor("/elsewhere");
    expect(frames[5].filename).toBe("file:///srv/app/src/my%20handler.js");
    expect(frames[1].filename).toBe("/srv/app/dist/server.js");
    // in_app does not depend on the root.
    expect(frames.map((f) => f.in_app)).toEqual([true, true, false, false, false, true]);
  });
});

describe("breadcrumbs", () => {
  it("keeps the last 50 and truncates long messages like the core", () => {
    const client = makeClient({ transport: createMockTransport().transport });
    for (let i = 0; i < 60; i++) client.addBreadcrumb({ category: "step", message: `m${i}` });
    client.addBreadcrumb({ category: "long", message: "x".repeat(5000), data: { a: 1 } });
    const crumbs = client.captureException(new Error("x"))!.properties.$exception_breadcrumbs;
    expect(crumbs).toHaveLength(50);
    expect(crumbs[0].message).toBe("m11");
    expect(crumbs[49].message).toHaveLength(1000);
    expect(crumbs[49].data).toEqual({ a: 1 });
    expect(typeof crumbs[49].timestamp).toBe("string");
  });

  it("concurrent withCohorly invocations never see each other's breadcrumbs, nor leak them", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport });
    const gateA = deferred();
    const gateB = deferred();
    const handler = client.withCohorly(async (id: string, gate: Promise<void>) => {
      client.addBreadcrumb({ category: "step", message: `${id}-1` });
      await gate;
      client.addBreadcrumb({ category: "step", message: `${id}-2` });
      throw new Error(id);
    }, { distinctId: (id) => id });

    const a = handler("a", gateA.promise).catch((e) => e);
    const b = handler("b", gateB.promise).catch((e) => e);
    gateB.resolve();
    await b;
    gateA.resolve();
    await a;

    const byUser = Object.fromEntries(
      sentExceptions(requests).map((e) => [
        e.properties.distinct_id,
        (e.properties.$exception_breadcrumbs as Array<{ message: string }>).map((c) => c.message),
      ]),
    );
    expect(byUser).toEqual({ a: ["a-1", "a-2"], b: ["b-1", "b-2"] });

    // Nothing reached the client ring.
    const outside = client.captureException(new Error("outside"))!;
    expect(outside.properties).not.toHaveProperty("$exception_breadcrumbs");
  });

  it("outside withCohorly, breadcrumbs go to the client ring (the inverse)", () => {
    const client = makeClient({ transport: createMockTransport().transport });
    client.addBreadcrumb({ category: "boot", message: "ready" });
    const evt = client.captureException(new Error("x"))!;
    expect(evt.properties.$exception_breadcrumbs.map((c: { message: string }) => c.message)).toEqual([
      "ready",
    ]);
  });
});

describe("exception queue", () => {
  it("is capped at 50: the oldest non-fatal goes, the oldest fatal stays", async () => {
    const t = switchableTransport(503);
    const client = makeClient({ transport: t.transport });
    // Put the client into backoff so nothing leaves while we fill it.
    await client.track("seed", { distinct_id: "u" });
    await client.flush().catch(() => undefined);

    client.captureException(new Error("fatal-0"), { level: "fatal" });
    for (let i = 1; i <= 60; i++) client.captureException(new Error(`error-${i}`));
    expect(client.exceptionQueueSize).toBe(50);

    t.setStatus(200);
    await client.flushExceptions();
    // flushExceptions may resend an exception another flush has in flight (the
    // server dedups by $insert_id), so count each $insert_id once.
    const unique = new Map(
      sentExceptions(t.requests).map((e) => [e.properties.$insert_id, e] as const),
    );
    const values = [...unique.values()].map((e) => e.properties.$exception_list[0].value);
    expect(values[0]).toBe("fatal-0");
    expect(values).toHaveLength(50);
    expect(values).not.toContain("error-11");
    expect(values).toContain("error-12");
    expect(values.at(-1)).toBe("error-60");
  });

  it("a fatal exception never loses its place to a non-fatal one that is being sent", async () => {
    const gate = deferred();
    const bodies: SentEvent[][] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      bodies.push(body as SentEvent[]);
      if (bodies.length === 1) await gate.promise;
    };
    const client = makeClient({ transport, maxExceptionQueueSize: 1 });
    client.captureException(new Error("ordinary"));
    await vi.waitFor(() => expect(bodies).toHaveLength(1)); // the ordinary one is in flight
    client.captureException(new Error("crash"), { level: "fatal" });
    gate.resolve();
    await client.flushExceptions();
    const values = bodies.flat().map((e) => e.properties.$exception_list[0].value);
    expect(values).toContain("crash");
  });

  it("drops the oldest fatal only when every queued exception is fatal", async () => {
    const t = switchableTransport(503);
    const client = makeClient({ transport: t.transport, maxExceptionQueueSize: 3 });
    await client.track("seed", { distinct_id: "u" });
    await client.flush().catch(() => undefined);

    for (let i = 0; i < 4; i++) client.captureException(new Error(`fatal-${i}`), { level: "fatal" });
    t.setStatus(200);
    await client.flushExceptions();
    expect(sentExceptions(t.requests).map((e) => e.properties.$exception_list[0].value)).toEqual([
      "fatal-1",
      "fatal-2",
      "fatal-3",
    ]);
  });

  it("with 1000 events queued, a flush sends fatal, then errors, then events, and events never evict exceptions", async () => {
    const t = switchableTransport(503);
    const client = makeClient({ transport: t.transport });
    await client.trackBatch(
      Array.from({ length: 1000 }, (_, i) => ({ event: `e${i}`, properties: { distinct_id: "u" } })),
    );
    await client.flush().catch(() => undefined); // backoff, queue full
    expect(client.queueSize).toBe(1000);

    client.captureException(new Error("err-1"));
    client.captureException(new Error("fatal-1"), { level: "fatal" });
    await client.track("one-more", { distinct_id: "u" }); // event queue overflows
    expect(client.queueSize).toBe(1000);
    expect(client.exceptionQueueSize).toBe(2);

    const before = t.requests.length;
    t.setStatus(200);
    await client.flush();
    const first = t.requests[before].body as SentEvent[];
    expect(first.map((e) => e.event)).toEqual(["$exception", "$exception"]);
    expect(first.map((e) => e.properties.$exception_level)).toEqual(["fatal", "error"]);
    const after = t.requests.slice(before + 1).flatMap((r) => r.body as SentEvent[]);
    expect(after.every((e) => e.event !== "$exception")).toBe(true);
    expect(after.at(-1)?.event).toBe("one-more");
  });

  it("an exception captured while an event batch is in flight goes before the remaining event batches", async () => {
    const held = deferred();
    let calls = 0;
    const order: string[][] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      order.push((body as SentEvent[]).map((e) => e.event));
      calls += 1;
      if (calls === 1) await held.promise;
    };
    const client = makeClient({ transport, batchSize: 2 });
    // Six events = three batches; the size trigger starts the flush.
    await client.trackBatch(
      Array.from({ length: 6 }, (_, i) => ({ event: `e${i}`, properties: { distinct_id: "u" } })),
    );
    for (let i = 0; i < 50 && calls === 0; i++) await new Promise((r) => setImmediate(r));
    expect(order).toEqual([["e0", "e1"]]); // first event batch in flight

    client.captureException(new Error("mid-flush"));
    held.resolve();
    await client.flush();
    expect(order).toEqual([["e0", "e1"], ["$exception"], ["e2", "e3"], ["e4", "e5"]]);
  });

  it("a failed exception batch holds the event batch back in that flush", async () => {
    const t = switchableTransport(200);
    const client = makeClient({ transport: t.transport });
    await client.track("e", { distinct_id: "u" });
    t.setStatus(500);
    client.captureException(new Error("x"));
    await expect(client.flush()).rejects.toThrow();
    // Every request so far carried only the exception.
    expect(sent(t.requests).every((e) => e.event === "$exception")).toBe(true);
    expect(client.queueSize).toBe(1);
    expect(client.exceptionQueueSize).toBe(1);

    t.setStatus(200);
    await client.flush();
    expect(client.queueSize).toBe(0);
    expect(client.exceptionQueueSize).toBe(0);
  });

  it("follows the retry contract: 413 halves, 400 drops", async () => {
    let calls = 0;
    const statuses = [413, 200, 200];
    const { transport, requests } = createMockTransport(() => ({ status: statuses[calls++] ?? 200 }));
    const client = makeClient({ transport, batchSize: 2 });
    client.captureException(new Error("a"));
    client.captureException(new Error("b"));
    await client.flush();
    expect(requests.map((r) => (r.body as unknown[]).length)).toEqual([2, 1, 1]);

    const rejected = createMockTransport(() => ({ status: 400 }));
    const dropping = makeClient({ transport: rejected.transport });
    dropping.captureException(new Error("bad"));
    await dropping.flush();
    expect(dropping.exceptionQueueSize).toBe(0);
  });

  it("honors backoff for the automatic flush, while flushExceptions ignores it and sends only exceptions", async () => {
    const t = switchableTransport(429);
    const client = makeClient({ transport: t.transport });
    await client.track("e", { distinct_id: "u" });
    await client.flush().catch(() => undefined); // now in backoff
    const before = t.requests.length;

    t.setStatus(200);
    client.captureException(new Error("non-fatal"));
    client.captureException(new Error("fatal"), { level: "fatal" });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.requests.length).toBe(before); // automatic flush waited

    await client.flushExceptions({ fatalOnly: true });
    expect(t.requests.slice(before).flatMap((r) => r.body as SentEvent[]).map((e) => e.properties.$exception_level)).toEqual(["fatal"]);
    await client.flushExceptions();
    expect(client.exceptionQueueSize).toBe(0);
    expect(client.queueSize).toBe(1); // events untouched
  });

  it("flushExceptions never rejects", async () => {
    const client = makeClient({ transport: createMockTransport(() => ({ status: 500 })).transport });
    client.captureException(new Error("x"));
    await expect(client.flushExceptions()).resolves.toBeUndefined();
    expect(client.exceptionQueueSize).toBe(1);
  });
});

describe("flushWithTimeout", () => {
  it("resolves true once both queues drained", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport });
    await client.track("e", { distinct_id: "u" });
    client.captureException(new Error("x"));
    await expect(client.flushWithTimeout(1000)).resolves.toBe(true);
    expect(sent(requests)).toHaveLength(2);
  });

  it("resolves false on failure and on timeout, never rejects", async () => {
    const failing = makeClient({ transport: createMockTransport(() => ({ status: 500 })).transport });
    failing.captureException(new Error("x"));
    await expect(failing.flushWithTimeout(1000)).resolves.toBe(false);

    const hanging: CohorlyTransport = () => new Promise(() => undefined);
    const stuck = makeClient({ transport: hanging });
    stuck.captureException(new Error("x"));
    const start = Date.now();
    await expect(stuck.flushWithTimeout(30)).resolves.toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("aborts the hung request at the deadline: the event stays queued and the next flush sends it", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const delivered: unknown[] = [];
    let hangNext = true;
    // Honors the signal like fetch: a hung request rejects once aborted.
    const transport: CohorlyTransport = (_url, body, _headers, signal) => {
      signals.push(signal);
      if (!hangNext) {
        delivered.push(body);
        return Promise.resolve();
      }
      hangNext = false;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const client = makeClient({ transport });
    await client.track("e", { distinct_id: "u" });

    await expect(client.flushWithTimeout(50)).resolves.toBe(false);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(client.queueSize).toBe(1); // kept for retry

    // The flush chain is free again; without the abort this would wait forever.
    await client.flush();
    expect(client.queueSize).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it("also aborts a flush that was already running ahead of it in the queue", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const transport: CohorlyTransport = (_url, _body, _headers, signal) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const client = makeClient({ transport });
    client.captureException(new Error("x")); // starts an automatic flush, which hangs
    for (let i = 0; i < 50 && signals.length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(signals).toHaveLength(1);

    await expect(client.flushWithTimeout(50)).resolves.toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    // The deadline-bound flush behind it never started a request of its own.
    await new Promise((r) => setTimeout(r, 20));
    expect(signals).toHaveLength(1);
    expect(client.exceptionQueueSize).toBe(1);
  });

  it("does not keep the process alive with its timer", async () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const handle = realSetTimeout(fn, ms);
      const original = handle.unref.bind(handle);
      handle.unref = () => {
        unref();
        return original();
      };
      return handle;
    }) as typeof setTimeout);
    const client = makeClient({ transport: createMockTransport().transport });
    await client.flushWithTimeout(50);
    expect(unref).toHaveBeenCalled();
  });
});

describe("withCohorly", () => {
  it("the $exception already reached the transport when the caller's catch runs, below batchSize", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport }); // batchSize 20, flushIntervalMs 0
    const boom = new Error("boom");
    const handler = client.withCohorly(async (_req: unknown) => {
      throw boom;
    });

    let seenInCatch = -1;
    let caught: unknown;
    try {
      await handler({});
    } catch (error) {
      seenInCatch = sentExceptions(requests).length;
      caught = error;
    }
    expect(seenInCatch).toBe(1);
    expect(caught).toBe(boom);
    const p = sentExceptions(requests)[0].properties;
    expect(p.$exception_level).toBe("error");
    expect(p.$exception_list[0].mechanism).toMatchObject({ type: "serverless", handled: false });
  });

  it("holds the rethrow until the transport has acknowledged the exception", async () => {
    // A serverless runtime freezes after the response: "request started" is
    // not enough, the delivery has to be confirmed before the error escapes.
    let acknowledged = 0;
    const transport: CohorlyTransport = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      acknowledged += 1;
    };
    const client = makeClient({ transport });
    const boom = new Error("boom");
    const handler = client.withCohorly(async () => {
      throw boom;
    });

    let acknowledgedInCatch = -1;
    let caught: unknown;
    try {
      await handler();
    } catch (error) {
      acknowledgedInCatch = acknowledged;
      caught = error;
    }
    expect(caught).toBe(boom);
    expect(acknowledgedInCatch).toBe(1);
  });

  it("works for a sync handler that throws: same error, already sent", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport });
    const boom = new TypeError("sync");
    const handler = client.withCohorly(() => {
      throw boom;
    });
    let seenInCatch = -1;
    await handler().catch((error) => {
      seenInCatch = sentExceptions(requests).length;
      expect(error).toBe(boom);
    });
    expect(seenInCatch).toBe(1);
  });

  it("rethrows the original error within the deadline when the transport hangs", async () => {
    const client = makeClient({ transport: () => new Promise(() => undefined) });
    const boom = new Error("boom");
    const handler = client.withCohorly(
      async () => {
        throw boom;
      },
      { flushTimeoutMs: 30 },
    );
    const start = Date.now();
    await expect(handler()).rejects.toBe(boom);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("rethrows the original error when the flush fails", async () => {
    const client = makeClient({ transport: createMockTransport(() => ({ status: 500 })).transport });
    const boom = new Error("boom");
    await expect(client.withCohorly(() => Promise.reject(boom))()).rejects.toBe(boom);
  });

  it("returns the value of a handler that succeeds, with no capture and no forced flush", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport });
    const flushSpy = vi.spyOn(client, "flushWithTimeout");
    await client.track("inside", { distinct_id: "u" });

    await expect(client.withCohorly(async (a: number, b: number) => a + b)(2, 3)).resolves.toBe(5);
    await expect(client.withCohorly((s: string) => s.toUpperCase())("ok")).resolves.toBe("OK");
    expect(flushSpy).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(client.exceptionQueueSize).toBe(0);
  });

  it("passes the handler's arguments to distinctId and preserves this", async () => {
    const { transport, requests } = createMockTransport();
    const client = makeClient({ transport });
    const target = {
      name: "svc",
      run: client.withCohorly(
        function (this: { name: string }, request: { auth?: { uid: string } }) {
          throw new Error(`${this.name}:${request.auth?.uid}`);
        },
        { distinctId: (request) => request.auth?.uid },
      ),
    };
    await expect(target.run({ auth: { uid: "user-42" } })).rejects.toThrow("svc:user-42");
    expect(sentExceptions(requests)[0].properties.distinct_id).toBe("user-42");
  });
});

describe("captureUncaught listeners", () => {
  it("installs one pair of listeners however many clients ask, and shutdown removes them", async () => {
    const baseUncaught = process.listenerCount("uncaughtException");
    const baseRejection = process.listenerCount("unhandledRejection");

    const a = new CohorlyNode("tok", { flushIntervalMs: 0, captureUncaught: true, transport: createMockTransport().transport });
    const b = new CohorlyNode("tok", { flushIntervalMs: 0, captureUncaught: true, transport: createMockTransport().transport });
    expect(process.listenerCount("uncaughtException")).toBe(baseUncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(baseRejection + 1);

    await a.shutdown();
    expect(process.listenerCount("uncaughtException")).toBe(baseUncaught + 1);
    await b.shutdown();
    expect(process.listenerCount("uncaughtException")).toBe(baseUncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(baseRejection);
  });

  it("installs nothing by default", async () => {
    const base = process.listenerCount("uncaughtException");
    makeClient({ transport: createMockTransport().transport });
    expect(process.listenerCount("uncaughtException")).toBe(base);
  });
});

describe("captureExceptions: false", () => {
  it("captures nothing and registers no uncaught handlers, but events still go out", async () => {
    const before = process.listenerCount("uncaughtException");
    const mock = createMockTransport();
    const client = makeClient({ transport: mock.transport, captureExceptions: false, captureUncaught: true });

    expect(process.listenerCount("uncaughtException")).toBe(before);
    expect(client.captureException(new Error("boom"), { distinctId: "u1" })).toBeNull();
    await client.track("Signed Up", { distinct_id: "u1" });
    await client.flush();

    expect(sentExceptions(mock.requests)).toEqual([]);
    expect(sent(mock.requests).map((e) => e.event)).toEqual(["Signed Up"]);
  });
});
