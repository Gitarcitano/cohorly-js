import { describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "./client.js";
import { TransportError } from "./transport.js";
import type {
  CohorlyClientOptions,
  CohorlyStorage,
  CohorlyTransport,
  ExceptionListEntry,
  TrackedEvent,
} from "./types.js";

function makeStorage(): CohorlyStorage {
  const map = new Map<string, string>();
  return {
    get: (key) => (map.has(key) ? map.get(key)! : null),
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Client over in-memory storage and a fake transport that fails with a
 * network error while `net.online` is false.
 */
function makeClient(options: Partial<CohorlyClientOptions> = {}) {
  const storage = options.storage ?? makeStorage();
  const net = { online: true };
  const batches: TrackedEvent[][] = [];
  const transport: CohorlyTransport =
    options.transport ??
    (async (url, body) => {
      if (!net.online) throw new TypeError("Failed to fetch");
      if (url.endsWith("/track")) batches.push(body as TrackedEvent[]);
    });
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    flushIntervalMs: 0,
    batchSize: 20,
    fetcher: async () => undefined,
    ...options,
    storage,
    transport,
  });
  return { client, storage, net, batches };
}

function storedExceptions(storage: CohorlyStorage): TrackedEvent[] {
  return JSON.parse(storage.get("cohorly_exception_queue") ?? "[]");
}

function firstValue(evt: TrackedEvent): string {
  return (evt.properties.$exception_list as ExceptionListEntry[])[0].value;
}

/** Lets the fire-and-forget auto flush started by a capture settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("captureException - event shape", () => {
  it("matches the ADR-0019 JavaScript fixture", async () => {
    const { client, batches } = makeClient({
      lib: "web",
      token: "tok",
      release: "web@2026.11.3",
      dist: "b71e04",
    });
    const cause = new Error("cart fetch returned an empty body");
    cause.stack = `Error: cart fetch returned an empty body
    at Ur (https://cdn.example.com/assets/app.b71e04.js:1:71804)`;
    const error = new TypeError("Cannot read properties of undefined (reading 'id')", {
      cause,
    });
    error.stack = `TypeError: Cannot read properties of undefined (reading 'id')
    at e.submit (https://cdn.example.com/assets/app.b71e04.js:1:90412)
    at Nt (https://cdn.example.com/assets/app.b71e04.js:1:90337)
    at dispatch (https://cdn.example.com/assets/vendor.3f9a1c.js:1:48211)`;
    client.addBreadcrumb({ category: "navigation", message: "/cart -> /checkout", level: "info" });

    const evt = client.captureException(error, {
      title: "Checkout submit failed",
      mechanism: { type: "onunhandledrejection", handled: false },
      properties: { $os: "Mac OS X", $browser: "Chrome" },
    });
    await settle();

    const app = "https://cdn.example.com/assets/app.b71e04.js";
    const vendor = "https://cdn.example.com/assets/vendor.3f9a1c.js";
    const frame = (filename: string, fn: string, colno: number, inApp: boolean) => ({
      platform: "javascript",
      filename,
      abs_path: filename,
      function: fn,
      lineno: 1,
      colno,
      in_app: inApp,
    });
    expect(evt?.event).toBe("$exception");
    expect(evt?.properties).toMatchObject({
      distinct_id: client.getDistinctId(),
      $lib: "web",
      $device_id: client.getDeviceId(),
      $os: "Mac OS X",
      $browser: "Chrome",
      token: "tok",
      $exception_level: "error",
      $exception_release: "web@2026.11.3",
      $exception_dist: "b71e04",
      error_title: "Checkout submit failed",
      $exception_list: [
        {
          type: "TypeError",
          value: "Cannot read properties of undefined (reading 'id')",
          mechanism: { handled: false, type: "onunhandledrejection", synthetic: false },
          stacktrace: {
            type: "raw",
            frames: [
              // The fixture marks the CDN vendor bundle in_app: false; a
              // filename heuristic cannot tell a vendor chunk on the app's
              // own CDN from app code, so the SDK sends true.
              frame(vendor, "dispatch", 48211, true),
              frame(app, "Nt", 90337, true),
              frame(app, "e.submit", 90412, true),
            ],
          },
        },
        {
          type: "Error",
          value: "cart fetch returned an empty body",
          mechanism: { handled: true, type: "chained", synthetic: false },
          stacktrace: { type: "raw", frames: [frame(app, "Ur", 71804, true)] },
        },
      ],
      $exception_breadcrumbs: [
        { category: "navigation", message: "/cart -> /checkout", level: "info" },
      ],
    });
    expect(typeof evt?.properties.$insert_id).toBe("string");
    expect(typeof evt?.properties.time).toBe("number");
    expect(evt?.properties).not.toHaveProperty("$exception_fingerprint");
    expect(batches[0]).toEqual([evt]);
  });

  it("defaults to a handled generic mechanism and level error", () => {
    const { client } = makeClient();
    const evt = client.captureException(new Error("x"));
    const entry = (evt?.properties.$exception_list as ExceptionListEntry[])[0];
    expect(entry.mechanism).toEqual({ handled: true, type: "generic", synthetic: false });
    expect(evt?.properties.$exception_level).toBe("error");
  });

  it("sends options.fingerprint as $exception_fingerprint and the chosen level", () => {
    const { client } = makeClient();
    const evt = client.captureException(new Error("x"), {
      fingerprint: "checkout-timeout",
      level: "warning",
    });
    expect(evt?.properties.$exception_fingerprint).toBe("checkout-timeout");
    expect(evt?.properties.$exception_level).toBe("warning");
  });
});

describe("captureException - non-Error and cause chains", () => {
  it("builds a synthetic exception without a stacktrace for non-Error values", () => {
    const { client } = makeClient();
    const cases: [unknown, string][] = [
      ["plain string", "plain string"],
      [{ code: 42 }, '{"code":42}'],
      [404, "404"],
      [undefined, "undefined"],
    ];
    for (const [thrown, value] of cases) {
      const evt = client.captureException(thrown);
      const list = evt?.properties.$exception_list as ExceptionListEntry[];
      expect(list).toEqual([
        { type: "Error", value, mechanism: { handled: true, type: "generic", synthetic: true } },
      ]);
    }
  });

  it("truncates a stringified non-Error to 1000 chars and survives a cyclic object", () => {
    const { client } = makeClient();
    const long = client.captureException("x".repeat(5000));
    expect(firstValue(long!)).toHaveLength(1000);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const evt = client.captureException(cyclic);
    expect(firstValue(evt!)).toBe("[object Object]");
  });

  it("lists the cause chain outermost first", () => {
    const { client } = makeClient();
    const error = new Error("outer", {
      cause: new TypeError("middle", { cause: new RangeError("inner") }),
    });
    const list = client.captureException(error)?.properties
      .$exception_list as ExceptionListEntry[];
    expect(list.map((e) => [e.type, e.value])).toEqual([
      ["Error", "outer"],
      ["TypeError", "middle"],
      ["RangeError", "inner"],
    ]);
    expect(list[0].mechanism.type).toBe("generic");
    expect(list[1].mechanism).toEqual({ handled: true, type: "chained", synthetic: false });
    expect(list[2].mechanism).toEqual({ handled: true, type: "chained", synthetic: false });
  });

  it("terminates a cyclic cause chain and caps a deep one at 5 entries", () => {
    const { client } = makeClient();
    const a = new Error("a");
    const b = new Error("b");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    const cyclic = client.captureException(a)?.properties
      .$exception_list as ExceptionListEntry[];
    expect(cyclic.map((e) => e.value)).toEqual(["a", "b"]);

    let deep: Error = new Error("e0");
    for (let i = 1; i < 9; i++) deep = new Error(`e${i}`, { cause: deep });
    const capped = client.captureException(deep)?.properties
      .$exception_list as ExceptionListEntry[];
    expect(capped.map((e) => e.value)).toEqual(["e8", "e7", "e6", "e5", "e4"]);
  });
});

describe("beforeSendException", () => {
  it("returning null drops the exception: nothing queued, nothing sent", async () => {
    const { client, storage, batches } = makeClient({ beforeSendException: () => null });
    expect(client.captureException(new Error("secret"))).toBeNull();
    await client.flush();
    expect(storedExceptions(storage)).toEqual([]);
    expect(batches).toEqual([]);
  });

  it("sends the event the hook returns, not the original", async () => {
    const { client, batches } = makeClient({
      beforeSendException: (evt) => ({
        ...evt,
        properties: { ...evt.properties, $current_url: "https://app.example.com/[redacted]" },
      }),
    });
    client.captureException(new Error("x"), {
      properties: { $current_url: "https://app.example.com/reset?token=secret" },
    });
    await client.flush();
    const sent = batches.flat();
    expect(sent).toHaveLength(1);
    expect(sent[0].properties.$current_url).toBe("https://app.example.com/[redacted]");
  });

  it("a hook that throws drops the exception instead of sending it unscrubbed", async () => {
    const { client, storage, batches } = makeClient({
      beforeSendException: () => {
        throw new Error("scrubber bug");
      },
    });
    expect(client.captureException(new Error("x"))).toBeNull();
    await client.flush();
    expect(storedExceptions(storage)).toEqual([]);
    expect(batches).toEqual([]);
  });
});

describe("exception queue", () => {
  it("1000 ordinary events tracked offline never evict a queued exception, and it ships first", async () => {
    const { client, storage, net, batches } = makeClient();
    net.online = false;
    client.captureException(new Error("checkout crashed"));
    await settle();
    for (let i = 0; i < 1000; i++) client.track("Viewed Page", { i });
    await settle();
    expect(JSON.parse(storage.get("cohorly_queue") ?? "[]")).toHaveLength(1000);
    expect(storedExceptions(storage).map(firstValue)).toEqual(["checkout crashed"]);

    net.online = true;
    await client.flush();
    expect(batches[0].map((e) => e.event)).toEqual(["$exception"]);
    expect(firstValue(batches[0][0])).toBe("checkout crashed");
    expect(batches[1].every((e) => e.event === "Viewed Page")).toBe(true);
  });

  it("caps at 50 by dropping the oldest non-fatal first, keeping a fatal", async () => {
    const { client, storage, net } = makeClient();
    net.online = false;
    client.captureException(new Error("fatal-0"), { level: "fatal" });
    for (let i = 0; i < 50; i++) client.captureException(new Error(`error-${i}`));
    await settle();

    const queued = storedExceptions(storage).map(firstValue);
    expect(queued).toHaveLength(50);
    expect(queued[0]).toBe("fatal-0");
    expect(queued).not.toContain("error-0");
    expect(queued[1]).toBe("error-1");
    expect(queued[49]).toBe("error-49");
  });

  it("drops the oldest fatal only when every queued exception is fatal", async () => {
    const { client, storage, net } = makeClient({ maxExceptionQueueSize: 3 });
    net.online = false;
    client.captureException(new Error("fatal-0"), { level: "fatal" });
    // Let the first send fail, so nothing is in flight when the cap is hit.
    await settle();
    for (let i = 1; i < 4; i++) client.captureException(new Error(`fatal-${i}`), { level: "fatal" });
    await settle();
    expect(storedExceptions(storage).map(firstValue)).toEqual(["fatal-1", "fatal-2", "fatal-3"]);
  });

  it("flushes fatal exceptions before non-fatal ones, and all exceptions before events", async () => {
    const { client, net, batches } = makeClient({ batchSize: 2 });
    net.online = false;
    client.track("Opened Cart");
    client.captureException(new Error("error-1"));
    client.captureException(new Error("fatal-1"), { level: "fatal" });
    client.captureException(new Error("warning-1"), { level: "warning" });
    client.captureException(new Error("fatal-2"), { level: "fatal" });
    client.track("Viewed Page");
    await settle();

    net.online = true;
    await client.flush();
    expect(batches.map((batch) => batch.map((e) => (e.event === "$exception" ? firstValue(e) : e.event)))).toEqual([
      ["fatal-1", "fatal-2"],
      ["error-1", "warning-1"],
      ["Opened Cart", "Viewed Page"],
    ]);
  });

  it("does not attempt the event queue when an exception batch fails, and shares backoff", async () => {
    const attempted: string[] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      attempted.push((body as TrackedEvent[])[0].event);
      throw new TransportError(503);
    };
    const { client, storage } = makeClient({ transport });
    client.track("Viewed Page");
    client.captureException(new Error("boom"));
    await settle();
    expect(attempted).toEqual(["$exception"]);

    client.track("Second", {});
    for (let i = 0; i < 25; i++) client.track("Size trigger");
    await settle();
    expect(attempted).toEqual(["$exception"]);
    expect(storedExceptions(storage)).toHaveLength(1);
  });

  it("drops an exception batch rejected with 400 and then sends the events", async () => {
    let rejectExceptions = true;
    const sent: string[] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      const events = body as TrackedEvent[];
      if (rejectExceptions && events[0].event === "$exception") {
        rejectExceptions = false;
        throw new TransportError(400);
      }
      sent.push(...events.map((e) => e.event));
    };
    const { client, storage } = makeClient({ transport });
    client.captureException(new Error("malformed"));
    await settle();
    client.track("Viewed Page");
    await client.flush();
    expect(storedExceptions(storage)).toEqual([]);
    expect(sent).toEqual(["Viewed Page"]);
  });

  it("is persisted and reloaded by a new client on the same storage", async () => {
    const storage = makeStorage();
    const first = makeClient({ storage });
    first.net.online = false;
    first.client.captureException(new Error("before reload"), { level: "fatal" });
    await settle();

    const second = makeClient({ storage });
    await second.client.flush();
    expect(second.batches[0].map(firstValue)).toEqual(["before reload"]);
    expect(storedExceptions(storage)).toEqual([]);
  });

  it("enforces the cap on load", () => {
    const storage = makeStorage();
    const first = makeClient({ storage });
    first.net.online = false;
    for (let i = 0; i < 5; i++) first.client.captureException(new Error(`e${i}`));
    makeClient({ storage, maxExceptionQueueSize: 2 });
    expect(storedExceptions(storage).map(firstValue)).toEqual(["e3", "e4"]);
  });

  it("reset() keeps queued exceptions", async () => {
    const { client, storage, net } = makeClient();
    net.online = false;
    client.captureException(new Error("before reset"));
    client.reset();
    await settle();
    expect(storedExceptions(storage).map(firstValue)).toEqual(["before reset"]);
  });

  it("flushExceptions(transport, { fatalOnly }) sends only fatal ones, even past an in-flight flush", async () => {
    const hanging: CohorlyTransport = () => new Promise(() => {});
    const { client, storage } = makeClient({ transport: hanging });
    client.captureException(new Error("handled"));
    client.captureException(new Error("crash"), { level: "fatal" });

    const beacon = vi.fn<CohorlyTransport>(async () => {});
    await client.flushExceptions(beacon, { fatalOnly: true });
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0];
    expect(url).toBe("http://localhost:4000/track");
    expect((body as TrackedEvent[]).map(firstValue)).toEqual(["crash"]);
    expect(storedExceptions(storage).map(firstValue)).toEqual(["handled"]);
  });
});

describe("exception queue - retry contract", () => {
  it("an overflow during a send never evicts the exceptions in flight", async () => {
    let fail: (err: unknown) => void = () => {};
    let calls = 0;
    const sent: string[][] = [];
    const transport: CohorlyTransport = (_url, body) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      }
      sent.push((body as TrackedEvent[]).map(firstValue));
      return Promise.resolve();
    };
    const { client, storage } = makeClient({ transport, maxExceptionQueueSize: 3 });
    // The first capture starts a send at once; the next three overflow the cap
    // while it is still pending.
    client.captureException(new Error("in-flight"));
    client.captureException(new Error("idle-1"));
    client.captureException(new Error("idle-2"));
    client.captureException(new Error("idle-3"));
    expect(storedExceptions(storage).map(firstValue)).toEqual(["in-flight", "idle-2", "idle-3"]);

    fail(new TransportError(503));
    await settle();
    await client.flush();
    expect(sent.flat()).toEqual(["in-flight", "idle-2", "idle-3"]);
  });

  it("413 halves the exception batch and keeps every exception", async () => {
    const sizes: number[] = [];
    let tooLarge = true;
    const transport: CohorlyTransport = async (_url, body) => {
      sizes.push((body as TrackedEvent[]).length);
      if (tooLarge) throw new TransportError(413);
    };
    const { client, storage } = makeClient({ transport, batchSize: 4 });
    tooLarge = true;
    for (let i = 0; i < 4; i++) client.captureException(new Error(`e-${i}`));
    await settle();
    expect(storedExceptions(storage)).toHaveLength(4);

    sizes.length = 0;
    tooLarge = false;
    await client.flush();
    expect(sizes[0]).toBe(2);
    expect(storedExceptions(storage)).toEqual([]);
  });

  it("401 backs off at the max delay and keeps the exception", async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      const transport: CohorlyTransport = async () => {
        attempts.push(Date.now());
        throw new TransportError(401);
      };
      const { client, storage } = makeClient({ transport, maxRetryDelayMs: 60_000 });
      client.captureException(new Error("unauthorized"));
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(1);

      client.captureException(new Error("still unauthorized"));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(attempts).toHaveLength(1);
      expect(storedExceptions(storage)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("429 honours Retry-After before retrying the exception", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const sent: string[] = [];
      const transport: CohorlyTransport = async (_url, body) => {
        calls += 1;
        if (calls === 1) throw new TransportError(429, 30_000);
        sent.push(...(body as TrackedEvent[]).map(firstValue));
      };
      const { client, storage } = makeClient({ transport, flushIntervalMs: 1000 });
      client.captureException(new Error("rate limited"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(sent).toEqual([]);
      expect(storedExceptions(storage)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toEqual(["rate limited"]);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sends from memory when storage throws", async () => {
    const storage = makeStorage();
    const failing: CohorlyStorage = {
      ...storage,
      set: (key, value) => {
        if (key === "cohorly_exception_queue") throw new Error("QuotaExceededError");
        storage.set(key, value);
      },
    };
    const { client, batches } = makeClient({ storage: failing });
    expect(client.captureException(new Error("quota"))).not.toBeNull();
    await settle();
    expect(batches.flat().map(firstValue)).toEqual(["quota"]);
  });
});

describe("breadcrumbs", () => {
  it("captured breadcrumb data is a snapshot, independent of the buffer and the input", () => {
    const { client } = makeClient();
    const data = { nested: { status: 500 } };
    client.addBreadcrumb({ category: "fetch", data });
    data.nested.status = 200;
    const first = client.captureException(new Error("a"));
    const firstCrumbs = first?.properties.$exception_breadcrumbs as {
      data: { nested: { status: number } };
    }[];
    expect(firstCrumbs[0].data.nested.status).toBe(500);
    firstCrumbs[0].data.nested.status = 0;
    const second = client.captureException(new Error("b"));
    const secondCrumbs = second?.properties.$exception_breadcrumbs as {
      data: { nested: { status: number } };
    }[];
    expect(secondCrumbs[0].data.nested.status).toBe(500);
  });

  it("keeps the last 50, and every exception carries a copy", () => {
    const { client } = makeClient();
    for (let i = 0; i < 60; i++) client.addBreadcrumb({ category: "test", message: `crumb-${i}` });
    const evt = client.captureException(new Error("x"));
    const crumbs = evt?.properties.$exception_breadcrumbs as { message: string; timestamp: string }[];
    expect(crumbs).toHaveLength(50);
    expect(crumbs[0].message).toBe("crumb-10");
    expect(crumbs[49].message).toBe("crumb-59");
    expect(new Date(crumbs[0].timestamp).toISOString()).toBe(crumbs[0].timestamp);

    client.addBreadcrumb({ category: "test", message: "after capture" });
    crumbs[0].message = "mutated";
    const next = client.captureException(new Error("y"));
    const nextCrumbs = next?.properties.$exception_breadcrumbs as { message: string }[];
    expect(crumbs[49].message).toBe("crumb-59");
    expect(nextCrumbs[0].message).toBe("crumb-11");
    expect(nextCrumbs[49].message).toBe("after capture");
  });

  it("keeps a given timestamp, truncates long messages, and is omitted when empty", () => {
    const { client } = makeClient();
    expect(client.captureException(new Error("x"))?.properties).not.toHaveProperty(
      "$exception_breadcrumbs",
    );
    client.addBreadcrumb({
      category: "console",
      message: "m".repeat(3000),
      timestamp: "2026-11-10T14:03:02.114Z",
    });
    const [crumb] = client.captureException(new Error("y"))?.properties
      .$exception_breadcrumbs as { message: string; timestamp: string }[];
    expect(crumb.timestamp).toBe("2026-11-10T14:03:02.114Z");
    expect(crumb.message).toHaveLength(1000);
  });

  it("reset() clears the breadcrumbs", () => {
    const { client } = makeClient();
    client.addBreadcrumb({ category: "navigation", message: "/a -> /b" });
    client.reset();
    expect(client.captureException(new Error("x"))?.properties).not.toHaveProperty(
      "$exception_breadcrumbs",
    );
  });
});

describe("release, dist and appVersion", () => {
  it("stamps $app_version_string on every event unless the caller passed one", () => {
    const { client } = makeClient({ appVersion: "2026.11.3" });
    expect(client.track("Viewed Page").properties.$app_version_string).toBe("2026.11.3");
    expect(client.captureException(new Error("x"))?.properties.$app_version_string).toBe(
      "2026.11.3",
    );
    expect(
      client.track("Viewed Page", { $app_version_string: "caller" }).properties.$app_version_string,
    ).toBe("caller");
  });

  it("stamps release and dist on exceptions only, and omits them when unset", () => {
    const { client } = makeClient({ release: "web@2026.11.3", dist: "b71e04" });
    const evt = client.captureException(new Error("x"));
    expect(evt?.properties.$exception_release).toBe("web@2026.11.3");
    expect(evt?.properties.$exception_dist).toBe("b71e04");
    expect(client.track("Viewed Page").properties).not.toHaveProperty("$exception_release");

    const bare = makeClient().client;
    const plain = bare.captureException(new Error("x"))?.properties;
    expect(plain).not.toHaveProperty("$exception_release");
    expect(plain).not.toHaveProperty("$exception_dist");
    expect(plain).not.toHaveProperty("$app_version_string");
  });
});

describe("tags and extra", () => {
  it("become top-level properties (tags over extra) but never override a reserved key", async () => {
    const { client } = makeClient({ token: "tok", release: "web@1" });
    await client.identify("user-1");
    client.register({ $exception_fingerprint: "from-super-props" });
    const hostile: Record<string, string | number | boolean> = {
      $exception_level: "info",
      $exception_release: "evil",
      $exception_fingerprint: "evil",
      error_title: "evil",
      distinct_id: "evil",
      time: 1,
      $insert_id: "evil",
      $lib: "evil",
      token: "evil",
      $device_id: "evil",
      $user_id: "evil",
    };
    const evt = client.captureException(new Error("x"), {
      level: "fatal",
      extra: { ...hostile, $exception_list: [], plan: "free", note: "kept" },
      tags: { ...hostile, plan: "pro" },
    });
    const props = evt!.properties;
    expect(props.plan).toBe("pro");
    expect(props.note).toBe("kept");
    expect(props.$exception_level).toBe("fatal");
    expect(props.$exception_release).toBe("web@1");
    expect(props).not.toHaveProperty("$exception_fingerprint");
    expect(props).not.toHaveProperty("error_title");
    expect((props.$exception_list as ExceptionListEntry[])[0].value).toBe("x");
    expect(props.distinct_id).toBe("user-1");
    expect(props.time).not.toBe(1);
    expect(props.$insert_id).not.toBe("evil");
    expect(props.$lib).toBe("core");
    expect(props.token).toBe("tok");
    expect(props.$device_id).toBe(client.getDeviceId());
    expect(props.$user_id).toBe("user-1");
  });
});
