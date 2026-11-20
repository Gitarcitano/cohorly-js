import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeModuleBag } from "../src/deviceInfo.js";

const native = vi.hoisted(() => ({ bag: {} as Record<string, unknown> }));
vi.mock("../src/deviceInfo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deviceInfo.js")>();
  return { ...actual, loadNativeModules: () => native.bag as NativeModuleBag };
});

import type { CohorlyClient } from "../src/client.js";
import { init, trackNavigation } from "../src/index.js";
import type { CohorlyOptions } from "../src/types.js";
import { createFakeFetch, FakeStorage, requestsTo } from "./helpers.js";
import { fakeReplayModule } from "./replay-helpers.js";

type AnyEvent = { event: string; properties: Record<string, any> };

const clients: CohorlyClient[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
  native.bag = {};
});

function makeClient(extra: Partial<CohorlyOptions> = {}) {
  const { fetchImpl, requests } = createFakeFetch();
  const client = init({
    apiHost: "http://localhost:4000",
    storage: new FakeStorage(),
    fetch: fetchImpl,
    loadFeatureFlags: false,
    captureExceptions: false,
    ...extra,
  });
  clients.push(client);
  return { client, requests };
}

type Route = { name: string; key?: string; params?: unknown };

function makeNav(initial: Route, opts: { ready?: boolean } = {}) {
  let route = initial;
  let ready = opts.ready ?? true;
  const listeners = new Set<() => void>();
  const ref = {
    isReady: () => ready,
    getCurrentRoute: () => route,
    addListener: (_event: "state", cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const fire = () => {
    for (const cb of listeners) cb();
  };
  return {
    ref,
    go(next: Route) {
      route = next;
      fire();
    },
    becomeReady() {
      ready = true;
    },
    fire,
  };
}

async function sent(client: CohorlyClient, requests: ReturnType<typeof createFakeFetch>["requests"]) {
  // a screen reported before the hydration is queued once `ready` resolves
  await client.ready;
  await client.flush();
  return requestsTo(requests, "/track").flatMap((r) => r.body as AnyEvent[]);
}

async function screens(client: CohorlyClient, requests: ReturnType<typeof createFakeFetch>["requests"]) {
  return (await sent(client, requests)).filter((e) => e.event === "$screen");
}

describe("trackScreenViews with trackNavigation", () => {
  it("sends $screen for the initial route when the container is ready", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    const nav = makeNav({ name: "Home", key: "home-1" });
    trackNavigation(nav.ref);
    const events = await screens(client, requests);
    expect(events.map((e) => e.properties.$screen_name)).toEqual(["Home"]);
  });

  it("waits for the first state event when the container is not ready", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    const nav = makeNav({ name: "Home", key: "home-1" }, { ready: false });
    trackNavigation(nav.ref);
    expect(await screens(client, requests)).toHaveLength(0);
    nav.becomeReady();
    nav.fire();
    const events = await screens(client, requests);
    expect(events.map((e) => e.properties.$screen_name)).toEqual(["Home"]);
  });

  it("sends $screen on route changes, back navigation and a new instance of the same screen", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref);
    nav.go({ name: "Cart", key: "c1" });
    nav.go({ name: "Home", key: "h1" }); // back to the previous route
    nav.go({ name: "Product", key: "p1" });
    nav.go({ name: "Product", key: "p2" }); // same name, new instance
    const events = await screens(client, requests);
    expect(events.map((e) => e.properties.$screen_name)).toEqual([
      "Home",
      "Cart",
      "Home",
      "Product",
      "Product",
    ]);
  });

  it("does not repeat for setParams or a repeated state event on the same key", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    const nav = makeNav({ name: "Profile", key: "p1" });
    trackNavigation(nav.ref);
    nav.go({ name: "Profile", key: "p1", params: { tab: "a" } });
    nav.fire();
    const events = await screens(client, requests);
    expect(events).toHaveLength(1);
  });

  it("dedupes by name when the route has no key", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    const nav = makeNav({ name: "Home" });
    trackNavigation(nav.ref);
    nav.go({ name: "Home" });
    nav.go({ name: "Cart" });
    nav.go({ name: "Cart" });
    nav.go({ name: "Home" });
    const events = await screens(client, requests);
    expect(events.map((e) => e.properties.$screen_name)).toEqual(["Home", "Cart", "Home"]);
  });

  it("carries $screen_name and never the route params", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    client.register({ plan: "pro" });
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref);
    nav.go({ name: "Order", key: "o1", params: { email: "jane@example.com", orderId: 991 } });
    const all = await sent(client, requests);
    const events = all.filter((e) => e.event === "$screen");
    expect(events).toHaveLength(2);
    expect(events[1].properties.$screen_name).toBe("Order");
    // goes through the normal track path: default and super props are there
    expect(events[1].properties.plan).toBe("pro");
    expect(events[1].properties.distinct_id).toBe(client.getDistinctId());
    expect(JSON.stringify(events)).not.toContain("jane@example.com");
    expect(JSON.stringify(events)).not.toContain("991");
    expect(Object.keys(events[1].properties)).not.toContain("params");
    expect(Object.keys(events[1].properties)).not.toContain("orderId");
  });

  it("works when trackNavigation runs before init, and does not throw without a client", async () => {
    const nav = makeNav({ name: "Home", key: "h1" });
    // No client yet (clients from earlier tests were stopped but stay shared): must not throw.
    let unsubscribe: () => void = () => {};
    expect(() => {
      unsubscribe = trackNavigation(nav.ref);
    }).not.toThrow();
    const { client, requests } = makeClient({ trackScreenViews: true });
    nav.go({ name: "Cart", key: "c1" });
    const events = await screens(client, requests);
    expect(events.map((e) => e.properties.$screen_name)).toContain("Cart");
    unsubscribe();
  });

  it("reports the current screen when init runs after trackNavigation in a fresh app", async () => {
    vi.resetModules();
    const fresh = await import("../src/index.js");
    const nav = makeNav({ name: "Home", key: "h1" });
    const unsubscribe = fresh.trackNavigation(nav.ref); // no client at all yet
    const { fetchImpl, requests } = createFakeFetch();
    const client = fresh.init({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      loadFeatureFlags: false,
      captureExceptions: false,
      trackScreenViews: true,
    });
    clients.push(client);
    nav.fire();
    const events = await screens(client, requests);
    expect(events.map((e) => e.properties.$screen_name)).toEqual(["Home"]);
    unsubscribe();
  });

  it("does not advance the dedupe marker while no screen was sent", async () => {
    const off = makeClient();
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref);
    expect(await screens(off.client, off.requests)).toHaveLength(0);
    // a new client with the option on: the same route (same key) is still reported
    const on = makeClient({ trackScreenViews: true });
    nav.fire();
    const events = await screens(on.client, on.requests);
    expect(events.map((e) => e.properties.$screen_name)).toEqual(["Home"]);
  });

  it("sends the cold-start screen with the stored identity and super props, never the transient ones", async () => {
    const storage = new FakeStorage();
    storage.store.set("cohorly:distinct_id", "stored-user");
    storage.store.set("cohorly:super_properties", JSON.stringify({ plan: "pro" }));
    const { client, requests } = makeClient({ trackScreenViews: true, storage });
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref); // synchronous, before the hydration finished
    const [event] = await screens(client, requests);
    expect(event.properties.$screen_name).toBe("Home");
    expect(event.properties.distinct_id).toBe("stored-user");
    expect(event.properties.plan).toBe("pro");
  });

  it("drops the cold-start screen when the stored state is opted out", async () => {
    const storage = new FakeStorage();
    storage.store.set("cohorly:opt_out", "1");
    const { client, requests } = makeClient({ trackScreenViews: true, storage });
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref);
    await client.ready;
    client.optInTracking();
    expect(await screens(client, requests)).toHaveLength(0);
  });

  it("drops a screen seen before the hydration when opt-out and opt-in happen before it ends", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref); // before ready
    client.optOutTracking();
    client.optInTracking();
    expect(await screens(client, requests)).toHaveLength(0);
  });

  it("keeps the time the screen was shown, not the hydration's", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { client, requests } = makeClient({ trackScreenViews: true });
      const nav = makeNav({ name: "Home", key: "h1" });
      trackNavigation(nav.ref); // before ready, at t=1_000_000
      vi.setSystemTime(1_005_000);
      await client.ready;
      await client.flush();
      const [event] = requestsTo(requests, "/track")
        .flatMap((r) => r.body as AnyEvent[])
        .filter((e) => e.event === "$screen");
      expect(event.properties.time).toBe(1_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing while opted out and resumes on the next screen after opt-in", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    await client.ready;
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref);
    await client.flush(); // opt-out drops what is still queued
    client.optOutTracking();
    nav.go({ name: "Cart", key: "c1" });
    client.optInTracking();
    nav.go({ name: "Checkout", key: "k1" });
    const events = await screens(client, requests);
    expect(events.map((e) => e.properties.$screen_name)).toEqual(["Home", "Checkout"]);
  });

  it("carries the replay $session_id of the other events", async () => {
    native.bag = { rn: { NativeModules: { CohorlyReactNativeReplay: fakeReplayModule().mod } } };
    const { client, requests } = makeClient({
      trackScreenViews: true,
      sessionReplay: { sampleRate: 1, onErrorSampleRate: 0 },
    });
    await client.ready;
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref);
    client.track("Tapped");
    const all = await sent(client, requests);
    const screen = all.find((e) => e.event === "$screen");
    const tapped = all.find((e) => e.event === "Tapped");
    expect(screen?.properties.$session_id).toEqual(expect.any(String));
    expect(screen?.properties.$session_id).toBe(tapped?.properties.$session_id);
  });

  it("stops after unsubscribe and never throws into navigation", async () => {
    const { client, requests } = makeClient({ trackScreenViews: true });
    const nav = makeNav({ name: "Home", key: "h1" });
    const unsubscribe = trackNavigation(nav.ref);
    unsubscribe();
    nav.go({ name: "Cart", key: "c1" });
    expect((await screens(client, requests)).map((e) => e.properties.$screen_name)).toEqual(["Home"]);

    const throwing = {
      isReady: () => true,
      getCurrentRoute: () => {
        throw new Error("boom");
      },
      addListener: (_e: "state", cb: () => void) => {
        cb();
        return () => {};
      },
    };
    expect(() => trackNavigation(throwing)()).not.toThrow();
  });
});

describe("trackScreenViews off (default)", () => {
  it("never sends $screen and keeps the navigation breadcrumbs", async () => {
    const { client, requests } = makeClient({ captureExceptions: true });
    await client.exceptionsReady;
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref);
    nav.go({ name: "Cart", key: "c1" });
    nav.go({ name: "Cart", key: "c1", params: { a: 1 } });
    expect(await screens(client, requests)).toHaveLength(0);

    client.captureException(new Error("boom"));
    await client.flush();
    await vi.waitFor(() => {
      const ex = requestsTo(requests, "/track")
        .flatMap((r) => r.body as AnyEvent[])
        .find((e) => e.event === "$exception");
      expect(ex).toBeDefined();
      const crumbs = (ex?.properties.$exception_breadcrumbs ?? []) as Array<{
        category: string;
        message: string;
      }>;
      expect(crumbs.filter((c) => c.category === "navigation").map((c) => c.message)).toEqual([
        "Home -> Cart",
      ]);
    });
  });

  it("is not turned on by sessionReplay", async () => {
    const { client, requests } = makeClient({
      sessionReplay: { sampleRate: 1, onErrorSampleRate: 0 },
    });
    const nav = makeNav({ name: "Home", key: "h1" });
    trackNavigation(nav.ref);
    nav.go({ name: "Cart", key: "c1" });
    expect(await screens(client, requests)).toHaveLength(0);
  });
});
