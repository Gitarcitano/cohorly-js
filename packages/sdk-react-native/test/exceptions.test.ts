import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeModuleBag } from "../src/deviceInfo.js";

// The optional native modules (expo-updates, expo-application, ...) come from
// literal require() calls; tests swap the loaded bag instead.
const native = vi.hoisted(() => ({ bag: {} as Record<string, unknown> }));
vi.mock("../src/deviceInfo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deviceInfo.js")>();
  return { ...actual, loadNativeModules: () => native.bag as NativeModuleBag };
});

import { CohorlyClient } from "../src/client.js";
import { EXCEPTION_FLUSH_TIMEOUT_MS, EXCEPTION_QUEUE_KEY } from "../src/exceptions/engine.js";
import {
  FATAL_PERSIST_TIMEOUT_MS,
  teardownExceptionCapture,
} from "../src/exceptions/handlers.js";
import {
  addBreadcrumb,
  captureException,
  init,
  trackNavigation,
} from "../src/index.js";
import type { CohorlyOptions } from "../src/types.js";
import {
  createFakeFetch,
  createProgrammableFetch,
  type FakeRequest,
  FakeStorage,
  requestsTo,
} from "./helpers.js";

const API = "http://localhost:4000";
const g = globalThis as Record<string, unknown>;
const realFetch = globalThis.fetch;

type AnyEvent = { event: string; properties: Record<string, any> };

function trackedEvents(requests: FakeRequest[]): AnyEvent[] {
  return requestsTo(requests, "/track").flatMap((r) => r.body as AnyEvent[]);
}

function exceptionEvents(requests: FakeRequest[]): AnyEvent[] {
  return trackedEvents(requests).filter((e) => e.event === "$exception");
}

function persistedExceptions(storage: FakeStorage): AnyEvent[] {
  return JSON.parse(storage.store.get(EXCEPTION_QUEUE_KEY) ?? "[]");
}

/** Fetch that fails like a device without network until `online` is set. */
function createSwitchableFetch() {
  const state = { online: false };
  const requests: FakeRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/flags/evaluate") return new Response(JSON.stringify({ flags: {} }));
    if (!state.online) throw new TypeError("Network request failed");
    requests.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests, state };
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

function installErrorUtils() {
  const previous = vi.fn<GlobalHandler>();
  let handler: GlobalHandler = previous;
  const errorUtils = {
    getGlobalHandler: () => handler,
    setGlobalHandler: vi.fn((next: GlobalHandler) => {
      handler = next;
    }),
  };
  g.ErrorUtils = errorUtils;
  return { previous, errorUtils, current: () => handler };
}

interface TrackerOptions {
  allRejections: boolean;
  onUnhandled: (id: number, rejection: unknown) => void;
  onHandled: (id: number) => void;
}

function installHermes() {
  const enablePromiseRejectionTracker = vi.fn<(options: TrackerOptions) => void>();
  g.HermesInternal = { hasPromise: () => true, enablePromiseRejectionTracker };
  return {
    enablePromiseRejectionTracker,
    tracker: () => enablePromiseRejectionTracker.mock.calls.at(-1)?.[0] as TrackerOptions,
  };
}

function createFakeAppState() {
  const listeners = new Set<(state: string) => void>();
  return {
    addEventListener: vi.fn((_event: "change", cb: (state: string) => void) => {
      listeners.add(cb);
      return { remove: () => listeners.delete(cb) };
    }),
    emit: (state: string) => {
      for (const cb of listeners) cb(state);
    },
    count: () => listeners.size,
  };
}

const clients: CohorlyClient[] = [];

async function makeClient(options: Partial<CohorlyOptions> = {}) {
  const fake = createFakeFetch();
  const storage = (options.storage as FakeStorage | undefined) ?? new FakeStorage();
  const client = new CohorlyClient({
    apiHost: API,
    token: "proj_test",
    storage,
    fetch: fake.fetchImpl,
    flushInterval: 60_000,
    loadFeatureFlags: false,
    appVersion: "1.0.0",
    appBuild: "7",
    platformInfo: { os: "Android" },
    ...options,
  });
  clients.push(client);
  await client.exceptionsReady;
  return { client, storage, requests: fake.requests };
}

/** Captures a probe exception and returns the breadcrumbs it carried. */
async function breadcrumbsOf(client: CohorlyClient, requests: FakeRequest[]) {
  client.captureException(new Error("probe"));
  await vi.waitFor(() =>
    expect(exceptionEvents(requests).some((e) => e.properties.$exception_list[0].value === "probe")).toBe(
      true,
    ),
  );
  const probe = exceptionEvents(requests).find((e) => e.properties.$exception_list[0].value === "probe");
  return (probe?.properties.$exception_breadcrumbs ?? []) as Array<Record<string, unknown>>;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  teardownExceptionCapture();
  delete g.ErrorUtils;
  delete g.HermesInternal;
  delete g.__DEV__;
  globalThis.fetch = realFetch;
  native.bag = {};
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("module API before init", () => {
  it("captureException and addBreadcrumb never throw", () => {
    expect(() => captureException(new Error("x"))).not.toThrow();
    expect(() => addBreadcrumb({ category: "x" })).not.toThrow();
  });
});

describe("captureExceptions: false (A)", () => {
  it("installs nothing global", async () => {
    const { errorUtils, current, previous } = installErrorUtils();
    const hermes = installHermes();
    const appFetch = vi.fn();
    globalThis.fetch = appFetch as unknown as typeof fetch;
    const appState = createFakeAppState();

    await makeClient({ appState });

    expect(errorUtils.setGlobalHandler).not.toHaveBeenCalled();
    expect(current()).toBe(previous);
    expect(hermes.enablePromiseRejectionTracker).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(appFetch);
    // The client's own lifecycle listener only, no breadcrumb listener.
    expect(appState.addEventListener).toHaveBeenCalledTimes(1);
  });

  it("still captures exceptions passed to captureException()", async () => {
    const { client, requests } = await makeClient();
    client.captureException(new Error("manual"));
    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    expect(exceptionEvents(requests)[0].properties).toMatchObject({
      $lib: "react-native",
      $exception_level: "error",
      $exception_release: "android@1.0.0+7",
      $app_version_string: "1.0.0",
      $app_build_number: "7",
      $os: "Android",
      token: "proj_test",
    });
  });
});

describe("global error handler (B)", () => {
  it("captures a fatal and calls the previous handler once with the same arguments", async () => {
    const { previous, current } = installErrorUtils();
    const { requests } = await makeClient({ captureExceptions: true });
    const error = new Error("render crashed");

    current()(error, true);

    await vi.waitFor(() => expect(previous).toHaveBeenCalledTimes(1));
    expect(previous).toHaveBeenCalledWith(error, true);
    await vi.waitFor(() => expect(exceptionEvents(requests).length).toBeGreaterThan(0));
    const [event] = exceptionEvents(requests);
    expect(event.properties.$exception_level).toBe("fatal");
    expect(event.properties.$exception_list[0].mechanism).toEqual({
      type: "onerror",
      handled: false,
      synthetic: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it("captures a non-fatal error as level error", async () => {
    const { previous, current } = installErrorUtils();
    const { requests } = await makeClient({ captureExceptions: true });
    const error = new Error("soft");

    current()(error, false);

    await vi.waitFor(() => expect(previous).toHaveBeenCalledTimes(1));
    expect(previous).toHaveBeenCalledWith(error, false);
    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    expect(exceptionEvents(requests)[0].properties.$exception_level).toBe("error");
    expect(exceptionEvents(requests)[0].properties.$exception_list[0].mechanism.handled).toBe(false);
  });

  it("calls the previous handler once even when capturing throws", async () => {
    const { previous, current } = installErrorUtils();
    const { client } = await makeClient({ captureExceptions: true });
    vi.spyOn(client, "captureException").mockImplementation(() => {
      throw new Error("capture broke");
    });
    const error = new Error("boom");

    expect(() => current()(error, true)).not.toThrow();

    await vi.waitFor(() => expect(previous).toHaveBeenCalledTimes(1));
    expect(previous).toHaveBeenCalledWith(error, true);
  });

  it("stops waiting for a persistence that never finishes at the timeout", async () => {
    class HangingStorage extends FakeStorage {
      override setItem(key: string, value: string): Promise<void> {
        if (key === EXCEPTION_QUEUE_KEY) return new Promise(() => {});
        return super.setItem(key, value);
      }
    }
    const { previous, current } = installErrorUtils();
    await makeClient({ captureExceptions: true, storage: new HangingStorage() });
    vi.useFakeTimers();
    const error = new Error("boom");

    current()(error, true);
    await vi.advanceTimersByTimeAsync(FATAL_PERSIST_TIMEOUT_MS - 1);
    expect(previous).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(FATAL_PERSIST_TIMEOUT_MS).toBe(1500);
  });
});

describe("fatal persisted across launches (C)", () => {
  it("is in AsyncStorage before the previous handler runs, and the next launch sends it with the crash release", async () => {
    const storage = new FakeStorage();
    const { previous, current } = installErrorUtils();
    let storedWhenPreviousRan: string | undefined;
    previous.mockImplementation(() => {
      storedWhenPreviousRan = storage.store.get(EXCEPTION_QUEUE_KEY);
    });
    const offline = createSwitchableFetch();
    const first = new CohorlyClient({
      apiHost: API,
      storage,
      fetch: offline.fetchImpl,
      loadFeatureFlags: false,
      captureExceptions: true,
      appVersion: "1.0.0",
      appBuild: "7",
      platformInfo: { os: "Android" },
    });
    clients.push(first);
    await first.exceptionsReady;

    current()(new Error("crash on launch 1"), true);
    await vi.waitFor(() => expect(previous).toHaveBeenCalledTimes(1));
    first.stop();

    const atCrash = JSON.parse(storedWhenPreviousRan ?? "[]") as AnyEvent[];
    expect(atCrash).toHaveLength(1);
    expect(atCrash[0].properties).toMatchObject({
      $exception_level: "fatal",
      $exception_release: "android@1.0.0+7",
    });

    // Next launch: updated app, same storage.
    const { client: second, requests } = await makeClient({
      storage,
      appVersion: "2.0.0",
      appBuild: "8",
    });
    await vi.waitFor(() => expect(requestsTo(requests, "/track").length).toBeGreaterThan(0));
    const [sent] = requestsTo(requests, "/track")[0].body as AnyEvent[];
    expect(sent.event).toBe("$exception");
    expect(sent.properties.$exception_list[0].value).toBe("crash on launch 1");
    expect(sent.properties.$exception_release).toBe("android@1.0.0+7");
    expect(sent.properties.$app_version_string).toBe("1.0.0");

    await vi.waitFor(() => expect(storage.store.get(EXCEPTION_QUEUE_KEY)).toBe("[]"));
    second.track("Opened");
    await second.flush();
    await second.flush();
    expect(exceptionEvents(requests)).toHaveLength(1);
  });
});

describe("delivery order (D)", () => {
  it("sends the exception in the first request of a flush, before queued events", async () => {
    const net = createSwitchableFetch();
    const { client, storage } = await makeClient({ fetch: net.fetchImpl, flushAt: 5000 });

    client.captureException(new Error("offline error"));
    for (let i = 0; i < 1010; i += 1) client.track("Offline Event", { i });
    await vi.waitFor(() => expect(persistedExceptions(storage)).toHaveLength(1));

    net.state.online = true;
    await client.flush();

    const tracks = requestsTo(net.requests, "/track");
    expect(tracks.length).toBeGreaterThanOrEqual(2);
    const firstBatch = tracks[0].body as AnyEvent[];
    expect(firstBatch.map((e) => e.event)).toEqual(["$exception"]);
    expect(firstBatch[0].properties.$exception_list[0].value).toBe("offline error");
    const events = trackedEvents(net.requests).filter((e) => e.event === "Offline Event");
    // The event queue capped itself at 1000 without touching the exception.
    expect(events).toHaveLength(1000);
  });
});

describe("expo-updates (E)", () => {
  async function captureWith(bag: Record<string, unknown>, options: Partial<CohorlyOptions> = {}) {
    native.bag = bag;
    const { client, requests } = await makeClient(options);
    client.captureException(new Error("ota"));
    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    return exceptionEvents(requests)[0].properties;
  }

  it("uses the downloaded update as dist and stamps the expo_* properties", async () => {
    const props = await captureWith({
      expoUpdates: {
        updateId: "0c5e7a1b-4d2f",
        channel: "production",
        runtimeVersion: "1.4.0",
        isEmbeddedLaunch: false,
      },
    });
    expect(props).toMatchObject({
      $exception_dist: "0c5e7a1b-4d2f",
      expo_update_id: "0c5e7a1b-4d2f",
      expo_channel: "production",
      expo_runtime_version: "1.4.0",
      expo_is_embedded_launch: false,
    });
  });

  it("has no dist on an embedded launch", async () => {
    const props = await captureWith({
      expoUpdates: { updateId: "emb", runtimeVersion: "1.4.0", isEmbeddedLaunch: true },
    });
    expect(props).not.toHaveProperty("$exception_dist");
    expect(props.expo_is_embedded_launch).toBe(true);
  });

  it("stamps nothing expo-related without the module or when it throws", async () => {
    const absent = await captureWith({});
    expect(Object.keys(absent).filter((k) => k.startsWith("expo_"))).toEqual([]);
    expect(absent).not.toHaveProperty("$exception_dist");

    const throwing = await captureWith({
      expoUpdates: {
        get updateId(): string {
          throw new Error("no native module");
        },
        get isEmbeddedLaunch(): boolean {
          throw new Error("no native module");
        },
      },
    });
    expect(Object.keys(throwing).filter((k) => k.startsWith("expo_"))).toEqual([]);
    expect(throwing).not.toHaveProperty("$exception_dist");
  });

  it("lets an explicit dist win over the update id", async () => {
    const props = await captureWith(
      { expoUpdates: { updateId: "u-1", isEmbeddedLaunch: false } },
      { dist: "release-flavor" },
    );
    expect(props.$exception_dist).toBe("release-flavor");
  });
});

describe("release (F)", () => {
  it("prefixes the bundle id from expo-application", async () => {
    native.bag = { expoApplication: { applicationId: "com.example.shop" } };
    const { client, requests } = await makeClient({ appVersion: "3.8.1", appBuild: "415" });
    client.captureException(new Error("x"));
    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    expect(exceptionEvents(requests)[0].properties.$exception_release).toBe("com.example.shop@3.8.1+415");
  });

  it("omits the release without a version and uses an explicit one as given", async () => {
    const noVersion = await makeClient({ appVersion: undefined, appBuild: undefined });
    noVersion.client.captureException(new Error("x"));
    await vi.waitFor(() => expect(exceptionEvents(noVersion.requests)).toHaveLength(1));
    expect(exceptionEvents(noVersion.requests)[0].properties).not.toHaveProperty("$exception_release");

    const explicit = await makeClient({ release: "shop@rt-7" });
    explicit.client.captureException(new Error("x"));
    await vi.waitFor(() => expect(exceptionEvents(explicit.requests)).toHaveLength(1));
    expect(exceptionEvents(explicit.requests)[0].properties.$exception_release).toBe("shop@rt-7");
  });
});

describe("unhandled promise rejections (H)", () => {
  it("installs the Hermes tracker for all rejections and captures them as unhandled errors", async () => {
    const hermes = installHermes();
    const { requests } = await makeClient({ captureExceptions: true });

    expect(hermes.enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);
    expect(hermes.tracker().allRejections).toBe(true);
    hermes.tracker().onUnhandled(1, new Error("request failed"));

    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    const props = exceptionEvents(requests)[0].properties;
    expect(props.$exception_level).toBe("error");
    expect(props.$exception_list[0]).toMatchObject({
      type: "Error",
      value: "request failed",
      mechanism: { type: "onunhandledrejection", handled: false, synthetic: false },
    });
  });

  it("turns a non-Error reason into a synthetic UnhandledRejection, like the web SDK", async () => {
    const hermes = installHermes();
    const { requests } = await makeClient({ captureExceptions: true });
    hermes.tracker().onUnhandled(2, { code: "E_TIMEOUT" });
    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    expect(exceptionEvents(requests)[0].properties.$exception_list[0]).toEqual({
      type: "UnhandledRejection",
      value: 'Non-Error promise rejection captured with value: {"code":"E_TIMEOUT"}',
      mechanism: { type: "onunhandledrejection", handled: false, synthetic: true },
    });
  });

  it("does nothing and does not throw without Hermes", async () => {
    g.HermesInternal = { hasPromise: () => false, enablePromiseRejectionTracker: vi.fn() };
    await expect(makeClient({ captureExceptions: true })).resolves.toBeDefined();
    expect((g.HermesInternal as { enablePromiseRejectionTracker: () => void }).enablePromiseRejectionTracker)
      .not.toHaveBeenCalled();
    delete g.HermesInternal;
    await expect(makeClient({ captureExceptions: true })).resolves.toBeDefined();
  });

  it("keeps React Native's dev warning in __DEV__ only", async () => {
    const hermes = installHermes();
    await makeClient({ captureExceptions: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    hermes.tracker().onUnhandled(3, new Error("quiet"));
    expect(warn).not.toHaveBeenCalled();

    g.__DEV__ = true;
    hermes.tracker().onUnhandled(7, new Error("loud"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^Possible Unhandled Promise Rejection \(id: 7\):\nError: loud/);
  });
});

describe("automatic breadcrumbs (I)", () => {
  it("records AppState changes", async () => {
    const appState = createFakeAppState();
    const { client, requests } = await makeClient({ captureExceptions: true, appState });
    appState.emit("background");
    appState.emit("active");
    const crumbs = await breadcrumbsOf(client, requests);
    expect(crumbs.filter((c) => c.category === "app.lifecycle").map((c) => c.message)).toEqual([
      "background",
      "active",
    ]);
  });

  it("records failed and rejected app fetches without query or fragment, and never the SDK's own", async () => {
    const serverError = new Response("nope", { status: 500 });
    const ok = new Response("{}", { status: 200 });
    const networkError = new TypeError("Network request failed");
    const appFetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/ok")) return ok;
      if (url.includes("/offline")) throw networkError;
      return serverError;
    });
    globalThis.fetch = appFetch as unknown as typeof fetch;
    const { client, requests } = await makeClient({ captureExceptions: true });

    const res = await globalThis.fetch("https://api.example.com/v1/cart?token=s3cr3t#frag", {
      method: "post",
    });
    expect(res).toBe(serverError);
    expect(await globalThis.fetch("https://api.example.com/ok")).toBe(ok);
    await expect(globalThis.fetch("https://api.example.com/offline?q=1")).rejects.toBe(networkError);
    await globalThis.fetch(`${API}/track`, { method: "POST" });
    await globalThis.fetch(`${API}/v1/orders`);
    expect(appFetch).toHaveBeenCalledTimes(5);
    expect(appFetch.mock.calls[0]).toEqual([
      "https://api.example.com/v1/cart?token=s3cr3t#frag",
      { method: "post" },
    ]);

    const fetchCrumbs = (await breadcrumbsOf(client, requests)).filter((c) => c.category === "fetch");
    expect(fetchCrumbs.map((c) => c.message)).toEqual([
      "POST https://api.example.com/v1/cart 500",
      "GET https://api.example.com/offline failed",
      `GET ${API}/v1/orders 500`,
    ]);
    expect(fetchCrumbs[0].data).toEqual({
      method: "POST",
      url: "https://api.example.com/v1/cart",
      status_code: 500,
    });
    expect(JSON.stringify(fetchCrumbs)).not.toContain("s3cr3t");
    expect(JSON.stringify(fetchCrumbs)).not.toContain("frag");
  });

  it("records navigation with route names only, and stops after unsubscribe", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = init({
      apiHost: API,
      storage: new FakeStorage(),
      fetch: fetchImpl,
      loadFeatureFlags: false,
      captureExceptions: true,
    });
    clients.push(client);
    await client.exceptionsReady;

    let route: { name: string; params?: unknown } = { name: "Home" };
    const listeners = new Set<() => void>();
    const navigationRef = {
      isReady: () => true,
      getCurrentRoute: () => route,
      addListener: (_event: "state", cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const go = (name: string, params?: unknown) => {
      route = { name, params };
      for (const cb of listeners) cb();
    };

    const unsubscribe = trackNavigation(navigationRef);
    go("Cart", { email: "jane@example.com", orderId: 991 });
    unsubscribe();
    go("Profile", { email: "jane@example.com" });
    expect(listeners.size).toBe(0);

    const nav = (await breadcrumbsOf(client, requests)).filter((c) => c.category === "navigation");
    expect(nav).toEqual([
      expect.objectContaining({ message: "Home -> Cart", data: { from: "Home", to: "Cart" } }),
    ]);
    expect(JSON.stringify(nav)).not.toContain("jane@example.com");
    expect(JSON.stringify(nav)).not.toContain("991");
    expect(() => trackNavigation(null)()).not.toThrow();
    expect(() => trackNavigation({})()).not.toThrow();
  });
});

describe("beforeSendException and identity (J)", () => {
  it("drops an exception when the hook returns null or throws", async () => {
    const { client, storage, requests } = await makeClient({
      beforeSendException: (event) => {
        if (event.properties.$exception_list) {
          const [first] = event.properties.$exception_list as Array<{ value: string }>;
          if (first.value === "drop") return null;
          if (first.value === "throw") throw new Error("hook bug");
        }
        event.properties.scrubbed = true;
        return event;
      },
    });
    client.captureException(new Error("drop"));
    client.captureException(new Error("throw"));
    client.captureException(new Error("keep"));
    await client.flush();
    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    expect(exceptionEvents(requests)[0].properties.$exception_list[0].value).toBe("keep");
    expect(exceptionEvents(requests)[0].properties.scrubbed).toBe(true);
    await vi.waitFor(() => expect(persistedExceptions(storage)).toEqual([]));
  });

  it("stamps the React Native identity at capture time, before the app hook sees it", async () => {
    const net = createSwitchableFetch();
    const seen: string[] = [];
    const { client } = await makeClient({
      fetch: net.fetchImpl,
      beforeSendException: (event) => {
        seen.push(String(event.properties.distinct_id));
        return event;
      },
    });
    const anonId = client.getDistinctId();
    const deviceId = client.getDeviceId();

    client.captureException(new Error("before login"));
    client.identify("user-42");
    client.captureException(new Error("after login"));
    net.state.online = true;
    await client.flush();

    expect(seen).toEqual([anonId, "user-42"]);
    const byValue = Object.fromEntries(
      exceptionEvents(net.requests).map((e) => [e.properties.$exception_list[0].value, e.properties]),
    );
    expect(byValue["before login"].distinct_id).toBe(anonId);
    expect(byValue["before login"]).not.toHaveProperty("$user_id");
    expect(byValue["before login"].$device_id).toBe(deviceId);
    expect(byValue["after login"].distinct_id).toBe("user-42");
    expect(byValue["after login"].$user_id).toBe("user-42");
    expect(byValue["after login"].$device_id).toBe(deviceId);
  });

  it("carries super properties but never lets them overwrite exception fields", async () => {
    const { client, requests } = await makeClient();
    client.register({ plan: "pro", $exception_level: "info", error_title: "spoofed" });
    client.captureException(new Error("x"), { level: "warning" });
    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    const props = exceptionEvents(requests)[0].properties;
    expect(props.plan).toBe("pro");
    expect(props.$exception_level).toBe("warning");
    expect(props).not.toHaveProperty("error_title");
  });
});

describe("captures before the client is ready (K)", () => {
  it("are held and queued once ready, keeping level, mechanism and breadcrumbs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    class GatedStorage extends FakeStorage {
      override async getItem(key: string): Promise<string | null> {
        const value = this.store.get(key) ?? null;
        await gate;
        return value;
      }
    }
    const storage = new GatedStorage();
    await storage.setItem("cohorly:distinct_id", "anon-stored");
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: API,
      storage,
      fetch: fetchImpl,
      loadFeatureFlags: false,
      platformInfo: { os: "iOS" },
    });
    clients.push(client);

    client.addBreadcrumb({ category: "checkout", message: "opened" });
    client.captureException(new Error("early"), {
      level: "warning",
      mechanism: { type: "custom.boot", handled: false },
    });
    expect(exceptionEvents(requests)).toHaveLength(0);

    release();
    await client.exceptionsReady;
    await vi.waitFor(() => expect(exceptionEvents(requests)).toHaveLength(1));
    const props = exceptionEvents(requests)[0].properties;
    expect(props.$exception_level).toBe("warning");
    expect(props.$exception_list[0].mechanism).toEqual({
      type: "custom.boot",
      handled: false,
      synthetic: false,
    });
    expect(props.$exception_breadcrumbs).toEqual([
      expect.objectContaining({ category: "checkout", message: "opened" }),
    ]);
    // Stamped with the stored identity, not the transient constructor id.
    expect(props.distinct_id).toBe("anon-stored");
  });
});

describe("disabled (M)", () => {
  it("sends nothing and keeps the exception persisted", async () => {
    const { client, storage, requests } = await makeClient({ disabled: true });
    client.captureException(new Error("offline by config"));
    client.track("Event");
    await client.flush();
    await new Promise((r) => setTimeout(r, 10));

    expect(requests).toHaveLength(0);
    expect(persistedExceptions(storage).map((e) => e.properties.$exception_list[0].value)).toEqual([
      "offline by config",
    ]);
  });
});

describe("reset", () => {
  it("clears breadcrumbs and keeps queued exceptions", async () => {
    const net = createSwitchableFetch();
    const { client, storage } = await makeClient({ fetch: net.fetchImpl });
    client.addBreadcrumb({ category: "old-session" });
    client.captureException(new Error("queued"));
    client.reset();
    client.captureException(new Error("after reset"));
    await vi.waitFor(() => expect(persistedExceptions(storage)).toHaveLength(2));

    net.state.online = true;
    await client.flush();
    const byValue = Object.fromEntries(
      exceptionEvents(net.requests).map((e) => [e.properties.$exception_list[0].value, e.properties]),
    );
    expect(byValue.queued.$exception_breadcrumbs).toEqual([
      expect.objectContaining({ category: "old-session" }),
    ]);
    expect(byValue["after reset"]).not.toHaveProperty("$exception_breadcrumbs");
  });
});

describe("stop and re-init (N)", () => {
  it("stop() restores the previous handler and fetch and stops capturing rejections", async () => {
    const { previous, current } = installErrorUtils();
    const hermes = installHermes();
    const appFetch = vi.fn(async () => new Response("", { status: 500 }));
    globalThis.fetch = appFetch as unknown as typeof fetch;
    const appState = createFakeAppState();
    const { client, requests } = await makeClient({ captureExceptions: true, appState });
    expect(current()).not.toBe(previous);
    expect(globalThis.fetch).not.toBe(appFetch);
    expect(appState.count()).toBe(2);

    client.stop();

    expect(current()).toBe(previous);
    expect(globalThis.fetch).toBe(appFetch);
    expect(appState.count()).toBe(1);
    hermes.tracker().onUnhandled(9, new Error("after stop"));
    await new Promise((r) => setTimeout(r, 10));
    expect(exceptionEvents(requests)).toHaveLength(0);
  });

  it("init() twice does not stack handlers: one capture, by the new client, one previous call", async () => {
    const { previous, current } = installErrorUtils();
    const hermes = installHermes();
    const appFetch = vi.fn(async () => new Response("", { status: 503 }));
    globalThis.fetch = appFetch as unknown as typeof fetch;
    const base = {
      apiHost: API,
      loadFeatureFlags: false,
      captureExceptions: true,
      platformInfo: { os: "Android" },
    };
    const one = createFakeFetch();
    const first = init({ ...base, storage: new FakeStorage(), fetch: one.fetchImpl });
    clients.push(first);
    await first.exceptionsReady;
    const two = createFakeFetch();
    const second = init({ ...base, storage: new FakeStorage(), fetch: two.fetchImpl });
    clients.push(second);
    await second.exceptionsReady;

    await globalThis.fetch("https://api.example.com/v1/cart");
    const error = new Error("after reinit");
    current()(error, false);
    hermes.tracker().onUnhandled(4, new Error("rejected after reinit"));

    await vi.waitFor(() => expect(previous).toHaveBeenCalledTimes(1));
    // A capture made while another send is in flight waits for the next flush.
    await vi.waitFor(async () => {
      await second.flush();
      expect(exceptionEvents(two.requests)).toHaveLength(2);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, false);
    expect(exceptionEvents(one.requests)).toHaveLength(0);
    expect(exceptionEvents(two.requests)).toHaveLength(2);
    expect(hermes.enablePromiseRejectionTracker).toHaveBeenCalledTimes(2);
    const crumbs = exceptionEvents(two.requests)[0].properties.$exception_breadcrumbs as Array<{
      category: string;
    }>;
    expect(crumbs.filter((c) => c.category === "fetch")).toHaveLength(1);
    expect(appFetch).toHaveBeenCalledTimes(1);
  });
});

describe("review hardening", () => {
  it("keeps a fatal captured before ready when more than the buffer size of errors follow", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    class GatedStorage extends FakeStorage {
      override async getItem(key: string): Promise<string | null> {
        const value = this.store.get(key) ?? null;
        await gate;
        return value;
      }
    }
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: API,
      storage: new GatedStorage(),
      fetch: fetchImpl,
      flushInterval: 60_000,
      loadFeatureFlags: false,
      platformInfo: { os: "iOS" },
    });
    clients.push(client);

    client.captureException(new Error("the crash"), { level: "fatal" });
    for (let i = 0; i < 60; i++) client.captureException(new Error(`noise ${i}`));
    release();
    await client.exceptionsReady;
    await client.flush();

    const sent = exceptionEvents(requests).map((e) => e.properties.$exception_list[0].value);
    expect(sent).toContain("the crash");
    expect(sent[0]).toBe("the crash");
    expect(sent).not.toContain("noise 0");
  });

  it("a repeated init() retires the first client: it can no longer overwrite the shared queue", async () => {
    const storage = new FakeStorage();
    const base = {
      apiHost: API,
      storage,
      loadFeatureFlags: false,
      flushInterval: 60_000,
      platformInfo: { os: "Android" },
    };
    const offline = createSwitchableFetch();
    const first = init({ ...base, fetch: offline.fetchImpl });
    clients.push(first);
    await first.exceptionsReady;
    first.captureException(new Error("from the first client"));
    await vi.waitFor(() => expect(persistedExceptions(storage)).toHaveLength(1));

    const online = createFakeFetch();
    const second = init({ ...base, fetch: online.fetchImpl });
    clients.push(second);
    await second.exceptionsReady;
    first.captureException(new Error("late, from the retired client"));
    offline.state.online = true;
    await first.flush();
    await second.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(exceptionEvents(offline.requests)).toEqual([]);

    const sent = exceptionEvents(online.requests).map((e) => e.properties.$exception_list[0].value);
    expect(sent).toEqual(["from the first client"]);
    expect(persistedExceptions(storage)).toEqual([]);
  });

  /** Requests after a rejected exception and a background flush `afterMs` later. */
  it("a send of the retired client that lands later does not erase the queue its successor holds", async () => {
    const storage = new FakeStorage();
    const base = { apiHost: API, storage, loadFeatureFlags: false, flushInterval: 60_000 };
    let landed!: () => void;
    const gate = new Promise<void>((r) => {
      landed = r;
    });
    const slow = (async (url: string) => {
      if (new URL(url).pathname === "/flags/evaluate") return new Response("{}");
      await gate;
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const first = init({ ...base, fetch: slow });
    clients.push(first);
    await first.exceptionsReady;
    first.captureException(new Error("in flight"));
    await vi.waitFor(() => expect(persistedExceptions(storage)).toHaveLength(1));

    const offline = createSwitchableFetch();
    const second = init({ ...base, fetch: offline.fetchImpl });
    clients.push(second);
    await second.exceptionsReady;
    landed();
    await new Promise((r) => setTimeout(r, 20));

    expect(persistedExceptions(storage)).toHaveLength(1);
  });

  it("a successor hydrates only after the retired client's pending writes landed", async () => {
    class SlowWrites extends FakeStorage {
      override async setItem(key: string, value: string): Promise<void> {
        await new Promise((r) => setTimeout(r, 25));
        this.store.set(key, value);
      }
    }
    const storage = new SlowWrites();
    const base = { apiHost: API, storage, loadFeatureFlags: false, flushInterval: 60_000 };
    const offlineA = createSwitchableFetch();
    const first = init({ ...base, fetch: offlineA.fetchImpl });
    clients.push(first);
    await first.exceptionsReady;
    first.captureException(new Error("old"));

    const offlineB = createSwitchableFetch();
    const second = init({ ...base, fetch: offlineB.fetchImpl });
    clients.push(second);
    await second.exceptionsReady;
    second.captureException(new Error("new"));
    await vi.waitFor(() =>
      expect(persistedExceptions(storage).map((e) => e.properties.$exception_list[0].value)).toEqual([
        "old",
        "new",
      ]),
    );
  });

  it("events wait when the exceptions could not be delivered, and go out with the next flush that can", async () => {
    const down = createProgrammableFetch(() => ({ status: 500 }));
    const { client } = await makeClient({ fetch: down.fetchImpl });
    client.captureException(new Error("stuck"));
    client.track("Opened");
    await client.flush();
    const sentEvents = (reqs: FakeRequest[]) =>
      trackedEvents(reqs).filter((e) => e.event === "Opened");
    expect(sentEvents(down.requests)).toEqual([]);

    const up = createFakeFetch();
    const { client: healthy } = await makeClient({ fetch: up.fetchImpl });
    healthy.captureException(new Error("fine"));
    healthy.track("Opened");
    await healthy.flush();
    await vi.waitFor(() => expect(sentEvents(up.requests)).toHaveLength(1));
  });

  it("a stalled exception request does not hold analytics back forever", async () => {
    const requests: FakeRequest[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/flags/evaluate") return new Response("{}");
      const body = JSON.parse(String(init?.body)) as AnyEvent[];
      if (body[0]?.event === "$exception") return new Promise<Response>(() => {});
      requests.push({ path, body });
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const { client } = await makeClient({ fetch: fetchImpl });
    client.captureException(new Error("never answered"));
    client.track("Opened");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const flushing = client.flush();
      await vi.advanceTimersByTimeAsync(EXCEPTION_FLUSH_TIMEOUT_MS + 1);
      await flushing;
    } finally {
      vi.useRealTimers();
    }
    expect(trackedEvents(requests).map((e) => e.event)).toContain("Opened");
  });

  async function backgroundFlushCount(status: number, afterMs = 0): Promise<number> {
    const prog = createProgrammableFetch(() => ({ status }));
    const appState = createFakeAppState();
    const { client } = await makeClient({ fetch: prog.fetchImpl, appState });
    client.captureException(new Error("rejected"));
    await vi.waitFor(() => expect(requestsTo(prog.requests, "/track")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 5));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + afterMs);
      appState.emit("background");
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      vi.useRealTimers();
    }
    return requestsTo(prog.requests, "/track").length;
  }

  it("401 and 5xx hold the next automatic flush back, 413 retries at once with a smaller batch", async () => {
    const fiveMinutes = 5 * 60_000;
    expect(await backgroundFlushCount(401, fiveMinutes)).toBe(1);
    expect(await backgroundFlushCount(500, fiveMinutes)).toBe(2);
    expect(await backgroundFlushCount(500, 0)).toBe(1);
    expect(await backgroundFlushCount(413)).toBe(2);
  });
});
