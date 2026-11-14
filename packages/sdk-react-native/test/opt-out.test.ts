import { afterEach, describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "../src/client.js";
import { EXCEPTION_QUEUE_KEY } from "../src/exceptions/engine.js";
import type { CohorlyOptions } from "../src/types.js";
import { createFakeFetch, type FakeRequest, FakeStorage, requestsTo } from "./helpers.js";

const clients: CohorlyClient[] = [];

function track(options: Partial<CohorlyOptions>) {
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "proj_test",
    flushInterval: 60_000,
    loadFeatureFlags: false,
    appVersion: "1.0.0",
    appBuild: "7",
    platformInfo: { os: "Android" },
    ...options,
  } as CohorlyOptions);
  clients.push(client);
  return client;
}

async function makeClient(options: Partial<CohorlyOptions> = {}) {
  const fake = createFakeFetch();
  const storage = (options.storage as FakeStorage | undefined) ?? new FakeStorage();
  const client = track({ storage, fetch: fake.fetchImpl, ...options });
  await client.exceptionsReady;
  return { client, storage, requests: fake.requests };
}

/** Storage whose reads wait for `release()`, so the hydration can be held back. */
class GatedStorage extends FakeStorage {
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  override async getItem(key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    await this.gate;
    return value;
  }
}

const names = (requests: FakeRequest[]) =>
  requestsTo(requests, "/track").flatMap((r) => (r.body as { event: string }[]).map((e) => e.event));

const queued = (storage: FakeStorage, key: string) => JSON.parse(storage.store.get(key) ?? "[]") as unknown[];

/**
 * A capture is sent at once. This fetch answers 500 to the first `$exception`
 * send, so the exception is still queued when the test opts out.
 */
function failFirstException() {
  const fake = createFakeFetch();
  const state = { failed: false };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!state.failed && typeof init?.body === "string" && init.body.includes('"$exception"')) {
      state.failed = true;
      return new Response("error", { status: 500 });
    }
    return fake.fetchImpl(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests: fake.requests, state };
}

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

describe("optOutTracking", () => {
  it("drops queued events, people ops and exceptions at once (storage too) and sends nothing while opted out", async () => {
    const failing = failFirstException();
    const { client, storage } = await makeClient({ fetch: failing.fetchImpl });
    const requests = failing.requests;
    client.track("Before");
    client.people.set({ plan: "free" });
    client.captureException(new Error("queued before opt-out"));
    expect(queued(storage, "cohorly:queue")).toHaveLength(1);
    expect(queued(storage, "cohorly:engage_queue")).toHaveLength(1);
    await vi.waitFor(() => expect(failing.state.failed).toBe(true));
    await vi.waitFor(() => expect(queued(storage, EXCEPTION_QUEUE_KEY)).toHaveLength(1));

    client.optOutTracking();
    expect(client.hasOptedOutTracking()).toBe(true);
    expect(queued(storage, "cohorly:queue")).toEqual([]);
    expect(queued(storage, "cohorly:engage_queue")).toEqual([]);
    await vi.waitFor(() => expect(queued(storage, EXCEPTION_QUEUE_KEY)).toEqual([]));

    client.track("After");
    client.people.set({ plan: "pro" });
    client.captureException(new Error("after"));
    await client.flush();
    expect(requestsTo(requests, "/track")).toEqual([]);
    expect(requestsTo(requests, "/engage")).toEqual([]);

    // Opting back in does not bring anything old back.
    client.optInTracking();
    await client.flush();
    expect(requests).toEqual([]);
  });

  it("persists across a new client on the same storage and discards a queue left by a previous launch", async () => {
    const storage = new FakeStorage();
    const first = await makeClient({ storage });
    first.client.optOutTracking();
    first.client.stop();
    storage.store.set(EXCEPTION_QUEUE_KEY, JSON.stringify([{ event: "$exception", properties: { distinct_id: "x" } }]));
    storage.store.set("cohorly:queue", JSON.stringify([{ event: "Stale", properties: {} }]));

    const second = await makeClient({ storage });
    await second.client.ready;
    expect(second.client.hasOptedOutTracking()).toBe(true);
    await second.client.flush();
    expect(second.requests).toEqual([]);
    expect(storage.store.get(EXCEPTION_QUEUE_KEY)).toBe("[]");
  });

  it("optInTracking re-enables the internal exception client: an exception captured after it is sent", async () => {
    const failing = failFirstException();
    const { client, storage } = await makeClient({ fetch: failing.fetchImpl });
    const requests = failing.requests;
    client.track("Discarded");
    client.captureException(new Error("discarded"));
    await vi.waitFor(() => expect(failing.state.failed).toBe(true));
    await vi.waitFor(() => expect(queued(storage, EXCEPTION_QUEUE_KEY)).toHaveLength(1));
    client.optOutTracking();
    client.optInTracking();
    expect(client.hasOptedOutTracking()).toBe(false);
    client.track("Kept");
    client.captureException(new Error("kept"));
    await client.flush();
    expect(names(requests).sort()).toEqual(["$exception", "Kept"]);
    const sent = requestsTo(requests, "/track").flatMap((r) => r.body as { event: string; properties: Record<string, unknown> }[]);
    const exceptions = sent.filter((e) => e.event === "$exception");
    expect(exceptions).toHaveLength(1);
    expect(JSON.stringify(exceptions[0].properties.$exception_list)).toContain("kept");
  });

  it("holds a capture made before the hydration and drops it when the stored opt-out is read", async () => {
    const storage = new GatedStorage();
    storage.store.set("cohorly:opt_out", "1");
    const fake = createFakeFetch();
    const client = track({ storage, fetch: fake.fetchImpl });
    client.captureException(new Error("before hydration"));
    client.addBreadcrumb({ category: "ui", message: "before hydration" });
    storage.release();
    await client.exceptionsReady;
    await client.flush();
    expect(fake.requests).toEqual([]);
    await vi.waitFor(() => expect(queued(storage, EXCEPTION_QUEUE_KEY)).toEqual([]));
  });

  it("applies the stored opt-out before the deferred /alias of an identify() made before the hydration", async () => {
    const storage = new GatedStorage();
    storage.store.set("cohorly:opt_out", "1");
    storage.store.set("cohorly:distinct_id", "anon-old");
    storage.store.set("cohorly:anonymous", "1");
    const fake = createFakeFetch();
    const client = track({ storage, fetch: fake.fetchImpl });
    client.identify("user-42");
    storage.release();
    await client.ready;
    await client.flush();
    expect(requestsTo(fake.requests, "/alias")).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("makes no flags request from an identify() made before the stored opt-out is read", async () => {
    const storage = new GatedStorage();
    storage.store.set("cohorly:opt_out", "1");
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(new URL(url).pathname);
      return new Response(JSON.stringify({ flags: {}, status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = track({ storage, fetch: fetchImpl });
    client.identify("user-42");
    const reload = client.reloadFeatureFlags();
    storage.release();
    await client.ready;
    await reload;
    await client.flush();
    expect(urls).toEqual([]);
  });

  it("an opt-out and opt-in before the hydration never brings back the queues it discarded", async () => {
    const storage = new GatedStorage();
    storage.store.set("cohorly:queue", JSON.stringify([{ event: "Old event", properties: { distinct_id: "x" } }]));
    storage.store.set("cohorly:engage_queue", JSON.stringify([{ distinct_id: "x", $set: { old: true } }]));
    storage.store.set(EXCEPTION_QUEUE_KEY, JSON.stringify([{ event: "$exception", properties: { distinct_id: "x", old: true } }]));
    const fake = createFakeFetch();
    const client = track({ storage, fetch: fake.fetchImpl });
    client.optOutTracking();
    client.optInTracking();
    storage.release();
    await client.exceptionsReady;
    client.track("New");
    await client.flush();
    expect(names(fake.requests)).toEqual(["New"]);
    expect(requestsTo(fake.requests, "/engage")).toEqual([]);
  });

  it("captureExceptions: false never sends an exception a previous launch left queued", async () => {
    const storage = new FakeStorage();
    storage.store.set(EXCEPTION_QUEUE_KEY, JSON.stringify([{ event: "$exception", properties: { distinct_id: "x" } }]));
    const { client, requests } = await makeClient({ storage, captureExceptions: false });
    client.track("Event");
    await client.flush();
    expect(names(requests)).toEqual(["Event"]);
  });
});

describe("opt-out while a send is on the wire", () => {
  /** A fetch that holds the first request to `path` until released, then fails. */
  function gatedFetch(path: string, outcome: "reject" | "500") {
    const requests: FakeRequest[] = [];
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const p = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (p === "/flags/evaluate") return new Response(JSON.stringify({ flags: {} }), { status: 200 });
      requests.push({ path: p, body });
      if (p === path && !held) {
        held = true;
        started();
        await gate;
        if (outcome === "reject") throw new Error("network down");
        return new Response("error", { status: 500 });
      }
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    };
    return { fetchImpl: fetchImpl as unknown as typeof fetch, requests, started: startedPromise, release };
  }

  it.each(["reject", "500"] as const)("does not put the old /track batch back after an opt-out (%s)", async (outcome) => {
    const fake = gatedFetch("/track", outcome);
    const { client, storage } = await makeClient({ fetch: fake.fetchImpl });
    client.track("old");
    const inFlight = client.flush();
    await fake.started;
    client.optOutTracking();
    client.optInTracking();
    fake.release();
    await inFlight;
    expect(queued(storage, "cohorly:queue")).toEqual([]);

    client.track("new");
    await client.flush();
    const sent = requestsTo(fake.requests, "/track").flatMap((r) => (r.body as { event: string }[]).map((e) => e.event));
    expect(sent).toEqual(["old", "new"]);
    expect(queued(storage, "cohorly:queue")).toEqual([]);
  });

  it("does not put the old /engage batch back after an opt-out", async () => {
    const fake = gatedFetch("/engage", "reject");
    const { client, storage } = await makeClient({ fetch: fake.fetchImpl });
    client.people.set({ old: true });
    const inFlight = client.flush();
    await fake.started;
    client.optOutTracking();
    client.optInTracking();
    fake.release();
    await inFlight;
    expect(queued(storage, "cohorly:engage_queue")).toEqual([]);

    await client.flush();
    expect(requestsTo(fake.requests, "/engage")).toHaveLength(1);
  });
});

describe("opt-out and feature flags", () => {
  function recordingFetch() {
    const paths: string[] = [];
    const fetchImpl = async (url: string) => {
      paths.push(new URL(url).pathname);
      return new Response(JSON.stringify({ flags: {} }), { status: 200 });
    };
    return { fetchImpl: fetchImpl as unknown as typeof fetch, paths };
  }

  it("makes no /flags/evaluate request while opted out, at startup or on reload, reset or identify", async () => {
    const storage = new FakeStorage();
    storage.store.set("cohorly:opt_out", "1");
    const fake = recordingFetch();
    const client = track({ storage, fetch: fake.fetchImpl, loadFeatureFlags: true });
    await client.ready;
    await client.reloadFeatureFlags();
    client.reset();
    client.identify("user-1");
    await client.reloadFeatureFlags();
    expect(fake.paths).toEqual([]);

    client.optInTracking();
    await client.reloadFeatureFlags();
    expect(fake.paths).toEqual(["/flags/evaluate"]);
  });
});

describe("opt-out and breadcrumbs", () => {
  it("a breadcrumb added before or during the opt-out is not on the first exception after opt-in", async () => {
    const { client, requests } = await makeClient();
    client.addBreadcrumb({ category: "ui", message: "before" });
    client.optOutTracking();
    client.addBreadcrumb({ category: "ui", message: "during" });
    client.optInTracking();
    client.addBreadcrumb({ category: "ui", message: "after" });
    client.captureException(new Error("boom"));
    await client.flush();

    const evt = requestsTo(requests, "/track")
      .flatMap((r) => r.body as { event: string; properties: Record<string, unknown> }[])
      .find((e) => e.event === "$exception");
    const crumbs = (evt?.properties.$exception_breadcrumbs as { message: string }[]).map((c) => c.message);
    expect(crumbs).toEqual(["after"]);
  });
});

describe("captureExceptions: false and isExceptionCaptureEnabled", () => {
  it("blocks the manual captureException but still sends events", async () => {
    const { client, requests } = await makeClient({ captureExceptions: false });
    client.captureException(new Error("manual"));
    client.track("Page View");
    await client.flush();
    expect(names(requests)).toEqual(["Page View"]);
  });

  it("is false until the hydration finishes, with or without a saved opt-out", async () => {
    const fresh = track({ storage: new FakeStorage(), fetch: createFakeFetch().fetchImpl });
    expect(fresh.isExceptionCaptureEnabled()).toBe(false);
    await fresh.ready;
    expect(fresh.isExceptionCaptureEnabled()).toBe(true);

    const savedStorage = new FakeStorage();
    savedStorage.store.set("cohorly:opt_out", "1");
    const saved = track({ storage: savedStorage, fetch: createFakeFetch().fetchImpl });
    expect(saved.isExceptionCaptureEnabled()).toBe(false);
    await saved.ready;
    expect(saved.isExceptionCaptureEnabled()).toBe(false);
  });

  it("is false after opt-out or with captureExceptions: false, true again after opt-in", async () => {
    const { client } = await makeClient();
    expect(client.isExceptionCaptureEnabled()).toBe(true);
    client.optOutTracking();
    expect(client.isExceptionCaptureEnabled()).toBe(false);
    client.optInTracking();
    expect(client.isExceptionCaptureEnabled()).toBe(true);
    const off = (await makeClient({ captureExceptions: false })).client;
    expect(off.isExceptionCaptureEnabled()).toBe(false);
    off.optInTracking();
    expect(off.isExceptionCaptureEnabled()).toBe(false);
  });
});

describe("onExceptionCaptureChange", () => {
  it("fires at the end of the hydration and on each opt-out/opt-in that flips the value, not otherwise", async () => {
    const client = track({ storage: new FakeStorage(), fetch: createFakeFetch().fetchImpl });
    const listener = vi.fn();
    client.onExceptionCaptureChange(listener);
    await client.ready;
    expect(listener.mock.calls).toEqual([[true]]);

    client.optOutTracking();
    client.optOutTracking();
    expect(listener.mock.calls).toEqual([[true], [false]]);
    client.optInTracking();
    client.optInTracking();
    expect(listener.mock.calls).toEqual([[true], [false], [true]]);
  });

  it("does not fire at the hydration with a saved opt-out, only when opting back in", async () => {
    const storage = new FakeStorage();
    storage.store.set("cohorly:opt_out", "1");
    const client = track({ storage, fetch: createFakeFetch().fetchImpl });
    const listener = vi.fn();
    client.onExceptionCaptureChange(listener);
    await client.ready;
    client.optOutTracking();
    expect(listener).not.toHaveBeenCalled();
    client.optInTracking();
    expect(listener.mock.calls).toEqual([[true]]);
  });

  it("never fires with captureExceptions: false, and stops after the unsubscribe", async () => {
    const off = track({ storage: new FakeStorage(), fetch: createFakeFetch().fetchImpl, captureExceptions: false });
    const offListener = vi.fn();
    off.onExceptionCaptureChange(offListener);
    await off.ready;
    off.optOutTracking();
    off.optInTracking();
    expect(offListener).not.toHaveBeenCalled();

    const on = track({ storage: new FakeStorage(), fetch: createFakeFetch().fetchImpl });
    await on.ready;
    const listener = vi.fn();
    const unsubscribe = on.onExceptionCaptureChange(listener);
    unsubscribe();
    on.optOutTracking();
    expect(listener).not.toHaveBeenCalled();
  });
});
