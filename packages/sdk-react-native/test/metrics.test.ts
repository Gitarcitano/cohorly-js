import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "../src/client.js";
import { init, metrics } from "../src/index.js";
import type { CohorlyOptions } from "../src/types.js";
import { type FakeRequest, FakeStorage, requestsTo } from "./helpers.js";

// Aligned to a 60s boundary (60_000 * 28_333_334).
const T0 = 1_700_000_040_000;
const WINDOW = 60_000;
const QUEUE_KEY = "cohorly:queue";

const flag = (enabled: boolean) => ({ enabled, variant: null, payload: null, reason: "test" });

/** AppState fake: `emit()` simulates foreground/background transitions. */
function createFakeAppState() {
  let listener: ((state: string) => void) | undefined;
  return {
    addEventListener: (event: "change", cb: (state: string) => void) => {
      if (event === "change") listener = cb;
    },
    emit: (state: string) => listener?.(state),
  };
}

/**
 * Fetch fake that records every request. `/flags/evaluate` answers at once
 * unless `gated`, in which case it waits for `release()`.
 */
function createFetch(opts: { gated?: boolean; flags?: Record<string, unknown> } = {}) {
  const requests: FakeRequest[] = [];
  const waiting: ((reply: { status: number; flags?: Record<string, unknown> }) => void)[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ path, body });
    if (path === "/flags/evaluate") {
      if (!opts.gated) {
        return new Response(JSON.stringify({ flags: opts.flags ?? {} }), { status: 200 });
      }
      const reply = await new Promise<{ status: number; flags?: Record<string, unknown> }>(
        (resolve) => waiting.push(resolve),
      );
      return new Response(JSON.stringify({ flags: reply.flags ?? {} }), { status: reply.status });
    }
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  };
  const release = (status: number, flags?: Record<string, unknown>) => {
    for (const resolve of waiting.splice(0)) resolve({ status, flags });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests, release };
}

const clients: CohorlyClient[] = [];

function makeClient(
  fetchImpl: typeof fetch,
  options: Partial<CohorlyOptions> & { storage?: FakeStorage } = {},
) {
  const storage = options.storage ?? new FakeStorage();
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "tok-rn",
    storage,
    fetch: fetchImpl,
    // The timer must not flush behind the test's back.
    flushInterval: 3_600_000,
    flushAt: 100,
    loadFeatureFlags: false,
    platformInfo: { os: "iOS" },
    ...options,
  } as CohorlyOptions);
  clients.push(client);
  return { client, storage };
}

const tracked = (requests: FakeRequest[]) =>
  requestsTo(requests, "/track").flatMap((r) => r.body as { event: string; properties: Record<string, any> }[]);
const sentMetrics = (requests: FakeRequest[]) => tracked(requests).filter((e) => e.event === "$metric");
const sentNames = (requests: FakeRequest[]) => tracked(requests).map((e) => e.event);
const queuedMetrics = (storage: FakeStorage) =>
  (JSON.parse(storage.store.get(QUEUE_KEY) ?? "[]") as { event: string }[]).filter(
    (e) => e.event === "$metric",
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers();
});

describe("react-native custom metrics", () => {
  it("a distribution yields one $metric per tag combination with the flat contract properties", async () => {
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl);
    await client.ready;

    for (const value of [10, 20, 30]) client.metrics.distribution("js_cost", value, { service: "cart" });
    client.metrics.distribution("js_cost", 700, { service: "web" });
    vi.setSystemTime(T0 + 10_000);
    client.metrics.flush();
    await client.flush();

    const events = sentMetrics(requests);
    expect(events).toHaveLength(2);
    const cart = events.find((e) => e.properties.metric_tag_service === "cart");
    expect(cart?.properties).toMatchObject({
      metric_name: "js_cost",
      metric_type: "distribution",
      metric_window_start: T0,
      metric_window_ms: WINDOW,
      metric_count: 3,
      metric_sum: 60,
      metric_min: 10,
      metric_max: 30,
      metric_p50: 20,
      metric_p95: 30,
      metric_bucket: "3: 10-50",
      metric_tag_service: "cart",
      time: T0,
      $lib: "react-native",
    });
    const web = events.find((e) => e.properties.metric_tag_service === "web");
    expect(web?.properties.metric_bucket).toBe("6: 500-1000");
  });

  it("count and gauge use the core event shape, and identify() ships the window under the outgoing identity", async () => {
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl);
    await client.ready;
    const anonId = client.getDistinctId();

    client.metrics.count("taps", 2);
    client.metrics.gauge("queue_length", 7);
    client.identify("user-1");
    client.metrics.count("taps", 1);
    client.metrics.flush();
    // identify() restarts the flag evaluation; the $metric events wait for it.
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));
    await client.flush();

    const events = sentMetrics(requests);
    expect(events).toHaveLength(3);
    const byName = (name: string, id: string) =>
      events.find((e) => e.properties.metric_name === name && e.properties.distinct_id === id);
    expect(byName("taps", anonId)?.properties).toMatchObject({ metric_type: "count", metric_sum: 2 });
    expect(byName("taps", anonId)?.properties.$user_id).toBeUndefined();
    expect(byName("queue_length", anonId)?.properties).toMatchObject({
      metric_type: "gauge",
      metric_last: 7,
    });
    expect(byName("taps", "user-1")?.properties.$user_id).toBe("user-1");
  });

  it("a super prop named metric_* does not leak into an event that did not set it", async () => {
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl);
    await client.ready;
    client.register({ metric_bucket: "stale", plan: "pro" });

    client.metrics.count("taps");
    client.metrics.flush();
    await client.flush();

    const [event] = sentMetrics(requests);
    expect(event.properties.metric_bucket).toBeUndefined();
    expect(event.properties.plan).toBe("pro");
  });

  it("reset() drops the pending window instead of attributing it to the new identity", async () => {
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl);
    await client.ready;

    client.metrics.count("taps");
    client.reset();
    client.metrics.flush();
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(0);
  });

  it("a timed event is not consumed by a $metric", async () => {
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl);
    await client.ready;

    client.timeEvent("$metric");
    client.metrics.count("taps");
    client.metrics.flush();
    client.track("$metric");
    await client.flush();

    const events = tracked(requests);
    expect(events[0].properties.$duration).toBeUndefined();
    expect(events[1].properties.$duration).toBeDefined();
  });
});

describe("react-native metrics kill switch", () => {
  it("sends no $metric once the loaded flags say cohorly_metrics is off", async () => {
    const { fetchImpl, requests } = createFetch({
      flags: { cohorly_metrics: flag(false) },
    });
    const { client } = makeClient(fetchImpl, { loadFeatureFlags: true });
    await client.ready;
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));

    client.metrics.count("taps");
    client.metrics.flush();
    client.track("Open");
    await client.flush();

    expect(sentNames(requests)).toEqual(["Open"]);
  });

  it("a missing flag means on", async () => {
    const { fetchImpl, requests } = createFetch({ flags: { other: flag(false) } });
    const { client } = makeClient(fetchImpl, { loadFeatureFlags: true });
    await client.ready;
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));

    client.metrics.count("taps");
    client.metrics.flush();
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(1);
  });

  it("honors a custom flagKey from the metrics option", async () => {
    const { fetchImpl, requests } = createFetch({
      flags: { cohorly_metrics: flag(false), my_switch: flag(false) },
    });
    const { client } = makeClient(fetchImpl, {
      loadFeatureFlags: true,
      metrics: { flagKey: "my_switch" },
    });
    await client.ready;
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));

    client.metrics.count("taps");
    client.metrics.flush();
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(0);
  });
});

describe("react-native $metric hold until the flags load", () => {
  async function coldStart(options: Partial<CohorlyOptions> = {}) {
    const fake = createFetch({ gated: true });
    const made = makeClient(fake.fetchImpl, { loadFeatureFlags: true, ...options });
    await made.client.ready;
    await vi.waitFor(() => expect(requestsTo(fake.requests, "/flags/evaluate")).toHaveLength(1));
    return { ...fake, ...made };
  }

  /** Samples, identify() (which queues the window and restarts the evaluation), then manual flushes. */
  async function sampleIdentifyFlush(client: CohorlyClient) {
    client.metrics.count("taps", 2);
    client.track("Open");
    client.identify("user-1");
    await client.flush();
    client.metrics.flush();
    await client.flush();
  }

  it("flag off: no $metric is sent before or after the flags arrive, and none stays persisted", async () => {
    const { client, requests, release, storage } = await coldStart();
    await sampleIdentifyFlush(client);
    expect(sentMetrics(requests)).toHaveLength(0);
    expect(sentNames(requests)).toEqual(["Open"]);
    expect(queuedMetrics(storage).length).toBeGreaterThan(0);

    release(200, { cohorly_metrics: flag(false) });
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(0);
    expect(queuedMetrics(storage)).toHaveLength(0);
  });

  it("flag on: the $metric is sent after the flags arrive, not before", async () => {
    const { client, requests, release } = await coldStart();
    await sampleIdentifyFlush(client);
    expect(sentMetrics(requests)).toHaveLength(0);

    release(200, { cohorly_metrics: flag(true) });
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(1);
    expect(sentNames(requests).filter((name) => name === "Open")).toHaveLength(1);
  });

  it("flag missing: the $metric is sent after the flags arrive", async () => {
    const { client, requests, release } = await coldStart();
    await sampleIdentifyFlush(client);
    release(200, {});
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(1);
  });

  it("a failed evaluation (500) releases the $metric", async () => {
    const { client, requests, release } = await coldStart();
    await sampleIdentifyFlush(client);
    expect(sentMetrics(requests)).toHaveLength(0);

    release(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(1);
  });

  it("loadFeatureFlags: false holds nothing back", async () => {
    const { fetchImpl, requests } = createFetch({ gated: true });
    const { client } = makeClient(fetchImpl, { loadFeatureFlags: false });
    await client.ready;

    client.metrics.count("taps");
    client.metrics.flush();
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(1);
    expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(0);
  });

  it("holds before the first evaluation even starts, then releases when it fails", async () => {
    const { fetchImpl, requests, release } = createFetch({ gated: true });
    const { client } = makeClient(fetchImpl, { loadFeatureFlags: true });

    client.metrics.count("taps");
    client.metrics.flush();
    await client.ready;
    await client.flush();
    expect(sentMetrics(requests)).toHaveLength(0);

    await vi.waitFor(() => expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(1));
    release(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(1);
  });
});

describe("react-native metrics and the app lifecycle", () => {
  it("going to background sends the pending window; coming back to active sends nothing", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl, { appState });
    await client.ready;

    client.metrics.count("taps", 3);
    expect(sentMetrics(requests)).toHaveLength(0);

    appState.emit("background");
    await client.flush();
    expect(sentMetrics(requests)).toHaveLength(1);
    expect(sentMetrics(requests)[0].properties.metric_sum).toBe(3);

    appState.emit("active");
    await client.flush();
    expect(sentMetrics(requests)).toHaveLength(1);
  });

  it("going to background without a pending window sends no $metric", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl, { appState });
    await client.ready;

    client.track("Open");
    appState.emit("background");
    appState.emit("inactive");
    await client.flush();

    expect(sentNames(requests)).toEqual(["Open"]);
  });

  it("opt-out discards the window and sends no $metric; opt-in does not bring old samples back", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl, { appState });
    await client.ready;

    // No flush between the calls: only discard() can keep the older samples out.
    client.metrics.count("before_optout");
    client.optOutTracking();
    client.metrics.count("during_optout");
    client.optInTracking();
    client.metrics.count("after_optin");
    client.metrics.flush();
    await client.flush();
    expect(sentMetrics(requests).map((e) => e.properties.metric_name)).toEqual(["after_optin"]);
  });

  it("opted out, a window never ships: background and flush send no $metric", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl, { appState });
    await client.ready;

    client.optOutTracking();
    client.metrics.count("during_optout");
    appState.emit("background");
    client.metrics.flush();
    await client.flush();
    expect(sentMetrics(requests)).toHaveLength(0);
  });
});

describe("react-native $metric and the queue", () => {
  it("a full queue drops $metric events before product events", async () => {
    const { fetchImpl } = createFetch();
    const { client, storage } = makeClient(fetchImpl, { maxQueueSize: 3 });
    await client.ready;

    client.track("A");
    client.metrics.count("m");
    client.metrics.flush();
    client.track("B");
    client.track("C");

    const names = (JSON.parse(storage.store.get(QUEUE_KEY) ?? "[]") as { event: string }[]).map(
      (e) => e.event,
    );
    expect(names).toEqual(["A", "B", "C"]);
  });

  it("a failed send does not put back $metric events the kill switch turned off meanwhile", async () => {
    const requests: FakeRequest[] = [];
    let flagsOff = false;
    let failTrack: ((res: Response) => void) | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (path === "/flags/evaluate") {
        const flags = flagsOff ? { cohorly_metrics: flag(false) } : {};
        return new Response(JSON.stringify({ flags }), { status: 200 });
      }
      return new Promise<Response>((resolve) => {
        failTrack = resolve;
      });
    }) as unknown as typeof fetch;
    const { client, storage } = makeClient(fetchImpl, { loadFeatureFlags: true });
    await client.ready;
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));

    client.metrics.count("m");
    client.metrics.flush();
    const flushing = client.flush();
    await vi.waitFor(() => expect(failTrack).toBeDefined());

    flagsOff = true;
    await client.reloadFeatureFlags();
    failTrack?.(new Response("error", { status: 500 }));
    await flushing;

    expect(queuedMetrics(storage)).toHaveLength(0);
  });
});

describe("react-native metrics module helpers", () => {
  // Runs first, while the module has no shared client yet.
  it("do nothing and never throw before init()", () => {
    expect(() => {
      metrics.count("taps");
      metrics.gauge("queue_length", 1);
      metrics.distribution("js_cost", 1, { service: "cart" });
      metrics.flush();
    }).not.toThrow();
  });

  it("drive the shared client after init()", async () => {
    const { fetchImpl, requests } = createFetch();
    const client = init({
      apiHost: "http://localhost:4000",
      token: "tok-rn",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushInterval: 3_600_000,
      loadFeatureFlags: false,
      platformInfo: { os: "iOS" },
    });
    clients.push(client);
    await client.ready;

    metrics.count("taps", 2, { screen: "home" });
    metrics.flush();
    await client.flush();

    const [event] = sentMetrics(requests);
    expect(event.properties).toMatchObject({
      metric_name: "taps",
      metric_sum: 2,
      metric_tag_screen: "home",
    });
  });
});

describe("react-native $metric before the hydration and after stop()", () => {
  it("a window closed before the hydration is stamped with the persisted identity", async () => {
    const storage = new FakeStorage();
    storage.store.set("cohorly:distinct_id", "user-9");
    storage.store.set("cohorly:anonymous", "0");
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl, { storage });

    client.metrics.count("early");
    client.metrics.flush();
    await client.ready;
    await client.flush();

    const events = sentMetrics(requests);
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({ distinct_id: "user-9", $user_id: "user-9" });
  });

  it("a stopped client no longer rewrites the persisted queue when its late flags disable metrics", async () => {
    const { fetchImpl, release } = createFetch({ gated: true });
    const { client, storage } = makeClient(fetchImpl, { loadFeatureFlags: true });
    await client.ready;
    client.metrics.count("m");
    client.metrics.flush();
    expect(queuedMetrics(storage)).toHaveLength(1);

    client.stop();
    release(200, { cohorly_metrics: flag(false) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queuedMetrics(storage)).toHaveLength(1);
  });
});

describe("react-native deferred $metric replay", () => {
  const seed = (extra: Record<string, string> = {}) => {
    const storage = new FakeStorage();
    storage.store.set("cohorly:distinct_id", "user-9");
    storage.store.set("cohorly:anonymous", "0");
    for (const [k, v] of Object.entries(extra)) storage.store.set(k, v);
    return storage;
  };

  it("a window closed before the hydration is dropped when the cached flags turn metrics off", async () => {
    const cache = JSON.stringify({
      distinct_id: "user-9",
      flags: { cohorly_metrics: flag(false) },
      stored_at: Date.now(),
    });
    const storage = seed({ "cohorly:flags": cache });
    const { fetchImpl, requests } = createFetch({ flags: { cohorly_metrics: flag(false) } });
    const { client } = makeClient(fetchImpl, { storage });

    client.metrics.count("early");
    client.metrics.flush();
    await client.ready;
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(0);
    expect(queuedMetrics(storage)).toHaveLength(0);
  });

  it("a window closed before the hydration is dropped when the identity changes before it", async () => {
    const storage = seed();
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl, { storage });

    client.metrics.count("early");
    client.metrics.flush();
    client.identify("user-10");
    await client.ready;
    await client.flush();

    expect(sentMetrics(requests)).toHaveLength(0);
    expect(queuedMetrics(storage)).toHaveLength(0);
  });

  it("a window closed before the hydration is dropped after stop()", async () => {
    const storage = seed();
    const { fetchImpl } = createFetch();
    const { client } = makeClient(fetchImpl, { storage });

    client.metrics.count("early");
    client.metrics.flush();
    client.stop();
    await client.ready;

    expect(queuedMetrics(storage)).toHaveLength(0);
  });

  it("queuing a window never starts a flush on its own, so background sends all of it", async () => {
    const appState = createFakeAppState();
    const { fetchImpl, requests } = createFetch();
    const { client } = makeClient(fetchImpl, { appState, flushAt: 2 });
    await client.ready;

    for (const name of ["a", "b", "c"]) client.metrics.count(name);
    client.metrics.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requestsTo(requests, "/track")).toHaveLength(0);

    appState.emit("background");
    await vi.waitFor(() => expect(requestsTo(requests, "/track").length).toBeGreaterThan(0));
  });
});
