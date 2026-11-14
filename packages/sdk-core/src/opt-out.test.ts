import { describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "./client.js";
import type { CohorlyClientOptions, CohorlyStorage, CohorlyTransport, TrackedEvent } from "./types.js";

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

function makeClient(options: Partial<CohorlyClientOptions> = {}) {
  const storage = options.storage ?? makeStorage();
  const sent: { url: string; body: unknown }[] = [];
  const transport: CohorlyTransport =
    options.transport ??
    (async (url, body) => {
      sent.push({ url, body });
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
  const names = () =>
    sent.filter((s) => s.url.endsWith("/track")).flatMap((s) => (s.body as TrackedEvent[]).map((e) => e.event));
  return { client, storage, sent, names };
}

describe("captureExceptions: false", () => {
  it("queues and sends no $exception, but ordinary events still go out", async () => {
    const { client, names } = makeClient({ captureExceptions: false });
    expect(client.captureException(new Error("boom"))).toBeNull();
    expect(
      client.captureExceptionList([{ type: "Error", value: "x", mechanism: { type: "generic", handled: true } }]),
    ).toBeNull();
    client.track("Page View");
    await client.flush();
    expect(names()).toEqual(["Page View"]);
  });

  it("drops an exception queue a previous session left, without sending it", async () => {
    const storage = makeStorage();
    storage.set("cohorly_exception_queue", JSON.stringify([{ event: "$exception", properties: { distinct_id: "x" } }]));
    const { client, names } = makeClient({ storage, captureExceptions: false });
    expect(storage.get("cohorly_exception_queue")).toBe("[]");
    client.track("Page View");
    await client.flush();
    await client.flushExceptions(client["transport"]);
    expect(names()).toEqual(["Page View"]);
  });
});

describe("optOutTracking", () => {
  it("drops queued exceptions and events at once, and sends nothing while opted out", async () => {
    // The capture triggers a send at once: the first one fails, so the
    // exception (and the event behind it) are still queued at the opt-out.
    let failed = false;
    const sent: { url: string; body: unknown }[] = [];
    const transport: CohorlyTransport = async (url, body) => {
      if (!failed) {
        failed = true;
        throw new Error("network down");
      }
      sent.push({ url, body });
    };
    const { client, storage } = makeClient({ transport });
    const names = () =>
      sent.filter((s) => s.url.endsWith("/track")).flatMap((s) => (s.body as TrackedEvent[]).map((e) => e.event));
    client.track("Before");
    client.captureException(new Error("queued before opt-out"));
    await Promise.resolve();
    expect(failed).toBe(true);
    expect(JSON.parse(storage.get("cohorly_queue") ?? "[]")).toHaveLength(1);
    expect(JSON.parse(storage.get("cohorly_exception_queue") ?? "[]")).toHaveLength(1);

    client.optOutTracking();
    expect(client.hasOptedOutTracking()).toBe(true);
    // Dropped right away, in storage too, not merely never sent.
    expect(JSON.parse(storage.get("cohorly_queue") ?? "[]")).toEqual([]);
    expect(JSON.parse(storage.get("cohorly_exception_queue") ?? "[]")).toEqual([]);

    client.track("After");
    expect(client.captureException(new Error("after"))).toBeNull();
    await client.people.set({ plan: "pro" });
    await client.identify("user-1");
    await client.flush();
    expect(names()).toEqual([]);
    expect(sent).toEqual([]);

    // After opting back in, nothing old comes back.
    client.optInTracking();
    await client.flush();
    expect(sent).toEqual([]);
  });

  it("persists across clients sharing the storage, including a stale exception left in it", async () => {
    const storage = makeStorage();
    const first = makeClient({ storage });
    first.client.optOutTracking();
    storage.set("cohorly_exception_queue", JSON.stringify([{ event: "$exception", properties: {} }]));

    const second = makeClient({ storage });
    expect(second.client.hasOptedOutTracking()).toBe(true);
    second.client.track("Ignored");
    await second.client.flush();
    expect(second.sent).toEqual([]);
    expect(storage.get("cohorly_exception_queue")).toBe("[]");
  });

  it("optInTracking sends again and does not bring back what was discarded", async () => {
    const { client, names } = makeClient();
    client.track("Discarded");
    client.optOutTracking();
    client.optInTracking();
    expect(client.hasOptedOutTracking()).toBe(false);
    client.track("Kept");
    client.captureException(new Error("kept"));
    await client.flush();
    expect(names().sort()).toEqual(["$exception", "Kept"]);
  });
});

describe("isExceptionCaptureEnabled", () => {
  it("is false when opted out or captureExceptions is false, true otherwise", () => {
    const on = makeClient().client;
    expect(on.isExceptionCaptureEnabled()).toBe(true);
    on.optOutTracking();
    expect(on.isExceptionCaptureEnabled()).toBe(false);
    on.optInTracking();
    expect(on.isExceptionCaptureEnabled()).toBe(true);
    expect(makeClient({ captureExceptions: false }).client.isExceptionCaptureEnabled()).toBe(false);
    const both = makeClient({ captureExceptions: false }).client;
    both.optInTracking();
    expect(both.isExceptionCaptureEnabled()).toBe(false);
  });
});

describe("opt-out while a send is on the wire", () => {
  it("removes the sent batch by identity: what was tracked after opt-out/opt-in stays queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: { url: string; body: unknown }[] = [];
    let first = true;
    const transport: CohorlyTransport = async (url, body) => {
      calls.push({ url, body });
      if (first) {
        first = false;
        await gate;
      }
    };
    const { client } = makeClient({ transport });
    client.track("a");
    client.track("b");
    const inFlight = client.flush();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    client.optOutTracking();
    client.optInTracking();
    client.track("c");
    release();
    await inFlight;

    const trackedNames = () =>
      calls.flatMap((c) => (c.body as TrackedEvent[]).map((e) => e.event));
    expect(trackedNames()).toEqual(["a", "b"]);
    await client.flush();
    expect(trackedNames()).toEqual(["a", "b", "c"]);
  });

  it("a send that fails after the opt-out neither re-queues the batch nor starts a backoff", async () => {
    let fail!: () => void;
    const gate = new Promise<void>((_, reject) => {
      fail = () => reject(new Error("network down"));
    });
    const calls: unknown[] = [];
    let first = true;
    const transport: CohorlyTransport = async (_url, body) => {
      calls.push(body);
      if (first) {
        first = false;
        await gate;
      }
    };
    const { client, storage } = makeClient({ transport });
    client.track("old");
    const inFlight = client.flush();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    client.optOutTracking();
    client.optInTracking();
    fail();
    await inFlight;
    expect(JSON.parse(storage.get("cohorly_queue") ?? "[]")).toEqual([]);
    client.track("new");
    await client.flush();
    expect(calls).toHaveLength(2);
    expect((calls[1] as TrackedEvent[]).map((e) => e.event)).toEqual(["new"]);
  });
});

describe("opt-out and feature flags", () => {
  it("makes no flags request while opted out and keeps what is cached", async () => {
    const fetched: string[] = [];
    const fetcher = async (url: string) => {
      fetched.push(url);
      return { flags: { beta: { enabled: true, variant: null, payload: null } } };
    };
    const { client } = makeClient({ fetcher });
    await client.reloadFeatureFlags();
    expect(fetched).toHaveLength(1);

    client.optOutTracking();
    await client.reloadFeatureFlags();
    await client.reloadFeatureFlags();
    client.reset();
    await Promise.resolve();
    expect(fetched).toHaveLength(1);

    client.optInTracking();
    await client.reloadFeatureFlags();
    expect(fetched).toHaveLength(2);
  });
});

describe("opt-out and breadcrumbs", () => {
  it("drops breadcrumbs added before and ignores those added during the opt-out", async () => {
    const { client, sent } = makeClient();
    client.addBreadcrumb({ category: "ui", message: "before" });
    client.optOutTracking();
    client.addBreadcrumb({ category: "ui", message: "during" });
    client.optInTracking();
    client.addBreadcrumb({ category: "ui", message: "after" });
    client.captureException(new Error("boom"));
    await client.flush();

    const evt = (sent[0].body as TrackedEvent[])[0];
    const crumbs = (evt.properties.$exception_breadcrumbs as { message: string }[]).map((c) => c.message);
    expect(crumbs).toEqual(["after"]);
  });
});

describe("opt-out and $metric", () => {
  it("queues no $metric for a window emitted while opted out", async () => {
    const { client, names } = makeClient();
    client.metrics.count("before.optout");
    client.optOutTracking();
    client.metrics.count("during.optout");
    client.metrics.flush();
    client.optInTracking();
    await client.flush();
    expect(names()).toEqual([]);
  });

  it("never sends samples recorded while opted out once back in, and sends new ones", async () => {
    const { client, names } = makeClient();
    client.optOutTracking();
    client.metrics.count("during.optout");
    client.optInTracking();
    client.metrics.flush();
    await client.flush();
    expect(names()).toEqual([]);

    client.metrics.count("after.optin");
    client.metrics.flush();
    await client.flush();
    expect(names()).toEqual(["$metric"]);
  });
});
