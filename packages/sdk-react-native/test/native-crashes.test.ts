import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeModuleBag } from "../src/deviceInfo.js";

// The native module comes from a literal require("react-native"); tests swap
// the loaded bag instead (same pattern as exceptions.test.ts).
const native = vi.hoisted(() => ({ bag: {} as Record<string, unknown> }));
vi.mock("../src/deviceInfo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deviceInfo.js")>();
  return { ...actual, loadNativeModules: () => native.bag as NativeModuleBag };
});

import { CohorlyClient } from "../src/client.js";
import { buildNativeCrashConfig, writeNativeCrashConfig } from "../src/exceptions/native-crashes.js";
import { init, setNativeCrashReporting } from "../src/index.js";
import type { CohorlyOptions } from "../src/types.js";
import { createFakeFetch, FakeStorage } from "./helpers.js";

const clients: CohorlyClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  native.bag = {};
});

/** A linked `CohorlyReactNative` module recording every config it is handed. */
function linkNativeModule(extra: Record<string, unknown> = {}) {
  const configureNativeCrashes = vi.fn<(json: string) => void>();
  native.bag = {
    rn: { NativeModules: { CohorlyReactNative: { configureNativeCrashes } } },
    expoApplication: { applicationId: "com.example.shop" },
    ...extra,
  };
  return {
    configureNativeCrashes,
    // biome-ignore lint/suspicious/noExplicitAny: parsed JSON.
    configs: (): any[] => configureNativeCrashes.mock.calls.map(([json]) => JSON.parse(json)),
  };
}

async function makeClient(options: Partial<CohorlyOptions> = {}) {
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "proj_test",
    storage: new FakeStorage(),
    fetch: createFakeFetch().fetchImpl,
    flushInterval: 60_000,
    loadFeatureFlags: false,
    appVersion: "3.8.1",
    appBuild: "415",
    platformInfo: { os: "iOS" },
    ...options,
  });
  clients.push(client);
  await client.exceptionsReady;
  return client;
}

describe("native crash config", () => {
  it("writes enabled:false and metricKit:false on every launch when neither option is set", async () => {
    const mod = linkNativeModule();
    const client = await makeClient();
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0]).toEqual({
      enabled: false,
      metricKit: false,
      release: "com.example.shop@3.8.1+415",
      dist: null,
      distinctId: client.getDistinctId(),
      deviceId: client.getDeviceId(),
      build: "415",
    });
  });

  it("writes enabled:true, metricKit:true by default, with release, OTA dist and identity when turned on", async () => {
    const mod = linkNativeModule({ expoUpdates: { updateId: "update-7", isEmbeddedLaunch: false } });
    const client = await makeClient({ nativeCrashReporting: true });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0]).toEqual({
      enabled: true,
      metricKit: true,
      release: "com.example.shop@3.8.1+415",
      dist: "update-7",
      distinctId: client.getDistinctId(),
      deviceId: client.getDeviceId(),
      build: "415",
    });
  });

  it("uses the explicit release and dist options", async () => {
    const mod = linkNativeModule();
    await makeClient({ nativeCrashReporting: true, release: "shop-rt-7", dist: "hotfix-2" });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalled());
    expect(mod.configs()[0]).toMatchObject({ release: "shop-rt-7", dist: "hotfix-2" });
  });

  it("writes the MetricKit-only mode: nativeCrashReporting false, metricKitDiagnostics true", async () => {
    const mod = linkNativeModule();
    await makeClient({ nativeCrashReporting: false, metricKitDiagnostics: true });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0]).toMatchObject({ enabled: false, metricKit: true });
  });

  it("writes KSCrash without MetricKit: nativeCrashReporting true, metricKitDiagnostics false", async () => {
    const mod = linkNativeModule();
    await makeClient({ nativeCrashReporting: true, metricKitDiagnostics: false });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0]).toMatchObject({ enabled: true, metricKit: false });
  });

  it("is off with captureExceptions: false even when asked for", async () => {
    const mod = linkNativeModule();
    await makeClient({ nativeCrashReporting: true, metricKitDiagnostics: true, captureExceptions: false });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalled());
    expect(mod.configs()[0]).toMatchObject({ enabled: false, metricKit: false });
  });

  it("is off with disabled: true, which forbids every network call", async () => {
    const mod = linkNativeModule();
    await makeClient({ nativeCrashReporting: true, metricKitDiagnostics: true, disabled: true });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalled());
    expect(mod.configs()[0]).toMatchObject({ enabled: false, metricKit: false });
  });

  it("optOutTracking() turns MetricKit off too, even with metricKitDiagnostics: true", async () => {
    const mod = linkNativeModule();
    const client = await makeClient({ nativeCrashReporting: false, metricKitDiagnostics: true });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0].metricKit).toBe(true);
    client.optOutTracking();
    expect(mod.configs().at(-1)).toMatchObject({ enabled: false, metricKit: false });
    client.optInTracking();
    expect(mod.configs().at(-1)).toMatchObject({ enabled: false, metricKit: true });
  });

  it("setNativeCrashReporting() after ready rewrites the config with the new value, keeping an omitted key", async () => {
    const mod = linkNativeModule();
    const client = await makeClient({ nativeCrashReporting: false, metricKitDiagnostics: true });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    const distinctId = client.getDistinctId();

    client.setNativeCrashReporting({ nativeCrashReporting: true });
    expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(2);
    expect(mod.configs().at(-1)).toMatchObject({ enabled: true, metricKit: true, distinctId });

    // Kill switch: KSCrash off on the next launch, MetricKit kept.
    client.setNativeCrashReporting({ nativeCrashReporting: false, metricKitDiagnostics: undefined });
    expect(mod.configs().at(-1)).toMatchObject({ enabled: false, metricKit: true });

    client.setNativeCrashReporting({ metricKitDiagnostics: false });
    expect(mod.configs().at(-1)).toMatchObject({ enabled: false, metricKit: false });
    // The new values survive the next rewrite (identify).
    client.identify("user-42");
    expect(mod.configs().at(-1)).toMatchObject({ enabled: false, metricKit: false, distinctId: "user-42" });
  });

  it("setNativeCrashReporting() keeps metricKit derived from nativeCrashReporting while it was never set", async () => {
    const mod = linkNativeModule();
    const client = await makeClient();
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    client.setNativeCrashReporting({ nativeCrashReporting: true });
    expect(mod.configs().at(-1)).toMatchObject({ enabled: true, metricKit: true });
    client.setNativeCrashReporting({ nativeCrashReporting: false });
    expect(mod.configs().at(-1)).toMatchObject({ enabled: false, metricKit: false });
  });

  it("setNativeCrashReporting() before ready writes nothing, and the first write carries its value", async () => {
    const mod = linkNativeModule();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      token: "proj_test",
      storage: new FakeStorage(),
      fetch: createFakeFetch().fetchImpl,
      flushInterval: 60_000,
      loadFeatureFlags: false,
      appVersion: "3.8.1",
      appBuild: "415",
      platformInfo: { os: "iOS" },
      nativeCrashReporting: true,
    });
    clients.push(client);
    client.setNativeCrashReporting({ nativeCrashReporting: false, metricKitDiagnostics: true });
    expect(mod.configureNativeCrashes).not.toHaveBeenCalled();
    await client.exceptionsReady;
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalled());
    expect(mod.configs().map((c) => [c.enabled, c.metricKit])).toEqual([[false, true]]);
  });

  it("the next launch starts from the persisted setter choice, so a launch dying before its flags never writes the init default", async () => {
    const storage = new FakeStorage();
    let mod = linkNativeModule();
    const first = await makeClient({ storage });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    first.setNativeCrashReporting({ nativeCrashReporting: true, metricKitDiagnostics: true });
    first.stop();

    mod = linkNativeModule();
    await makeClient({ storage });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0]).toMatchObject({ enabled: true, metricKit: true });

    // Kill switch persisted too, keeping the other key.
    const second = clients.at(-1) as CohorlyClient;
    second.setNativeCrashReporting({ nativeCrashReporting: false });
    second.stop();
    mod = linkNativeModule();
    await makeClient({ storage });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0]).toMatchObject({ enabled: false, metricKit: true });
  });

  it("an explicit init option wins over the persisted choice, and a setter call before ready is persisted with the stored keys", async () => {
    const storage = new FakeStorage();
    await storage.setItem("cohorly:native_crash", JSON.stringify({ nativeCrashReporting: true, metricKitDiagnostics: true }));
    let mod = linkNativeModule();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      token: "proj_test",
      storage,
      fetch: createFakeFetch().fetchImpl,
      flushInterval: 60_000,
      loadFeatureFlags: false,
      appVersion: "3.8.1",
      appBuild: "415",
      platformInfo: { os: "iOS" },
      metricKitDiagnostics: false,
    });
    clients.push(client);
    client.setNativeCrashReporting({ nativeCrashReporting: false });
    await client.exceptionsReady;
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalled());
    expect(mod.configs()[0]).toMatchObject({ enabled: false, metricKit: false });
    await vi.waitFor(() =>
      expect(JSON.parse(storage.store.get("cohorly:native_crash") as string)).toEqual({
        nativeCrashReporting: false,
        metricKitDiagnostics: true,
      }),
    );
    client.stop();

    mod = linkNativeModule();
    await makeClient({ storage });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0]).toMatchObject({ enabled: false, metricKit: true });
  });

  it("rewrites the config with the new identity on identify and reset", async () => {
    const mod = linkNativeModule();
    const client = await makeClient({ nativeCrashReporting: true });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    const deviceId = client.getDeviceId();

    client.identify("user-42");
    expect(mod.configs().at(-1)).toMatchObject({ enabled: true, distinctId: "user-42", deviceId });

    client.reset();
    const after = mod.configs().at(-1);
    expect(after.distinctId).toBe(client.getDistinctId());
    expect(after.distinctId).not.toBe("user-42");
    expect(after.deviceId).toBe(client.getDeviceId());
    expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(3);
  });

  it("optOutTracking() turns it off and optInTracking() back on, re-sent with each change", async () => {
    const mod = linkNativeModule();
    const client = await makeClient({ nativeCrashReporting: true });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    expect(mod.configs()[0].enabled).toBe(true);
    client.optOutTracking();
    expect(mod.configs().at(-1).enabled).toBe(false);
    client.identify("user-42");
    expect(mod.configs().at(-1)).toMatchObject({ enabled: false, distinctId: "user-42" });
    client.optInTracking();
    expect(mod.configs().at(-1)).toMatchObject({ enabled: true, distinctId: "user-42" });
  });

  it("a persisted opt-out is never written as enabled, and nothing is written before it is read", async () => {
    const mod = linkNativeModule();
    const storage = new FakeStorage();
    await storage.setItem("cohorly:opt_out", "1");
    const client = await makeClient({ nativeCrashReporting: true, storage });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalled());
    expect(mod.configs().map((c) => c.enabled)).toEqual([false]);
    client.optInTracking();
    expect(mod.configs().at(-1).enabled).toBe(true);
  });

  it("never writes the transient false of a not-yet-hydrated client", async () => {
    const mod = linkNativeModule();
    await makeClient({ nativeCrashReporting: true });
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalled());
    // A premature write would show up as a leading enabled:false.
    expect(mod.configs().map((c) => c.enabled)).toEqual([true]);
  });

  it("does nothing and never throws without the native method", async () => {
    native.bag = { rn: { NativeModules: {} } };
    const client = await makeClient({ nativeCrashReporting: true });
    expect(() => client.identify("user-42")).not.toThrow();
    expect(() => client.reset()).not.toThrow();

    native.bag = {};
    const bare = await makeClient({ nativeCrashReporting: true });
    expect(() => bare.identify("user-42")).not.toThrow();
  });

  it("swallows a throwing or rejecting native method", () => {
    const config = buildNativeCrashConfig({
      nativeCrashReporting: true,
      captureEnabled: true,
      release: undefined,
      dist: undefined,
      distinctId: "a",
      deviceId: "a",
      build: undefined,
    });
    expect(() =>
      writeNativeCrashConfig(
        {
          configureNativeCrashes: () => {
            throw new Error("bridge down");
          },
        },
        config,
      ),
    ).not.toThrow();
    expect(() =>
      writeNativeCrashConfig({ configureNativeCrashes: () => Promise.reject(new Error("bridge down")) }, config),
    ).not.toThrow();
  });
});

describe("buildNativeCrashConfig", () => {
  const base = { captureEnabled: true, release: "r", dist: "d", distinctId: "a", deviceId: "b", build: "415" };

  it("derives metricKit from nativeCrashReporting unless metricKitDiagnostics is given", () => {
    const pick = (input: Partial<Parameters<typeof buildNativeCrashConfig>[0]>) => {
      const config = buildNativeCrashConfig({ ...base, ...input });
      return [config.enabled, config.metricKit];
    };
    expect(pick({})).toEqual([false, false]);
    expect(pick({ nativeCrashReporting: true })).toEqual([true, true]);
    expect(pick({ nativeCrashReporting: false })).toEqual([false, false]);
    expect(pick({ nativeCrashReporting: false, metricKitDiagnostics: true })).toEqual([false, true]);
    expect(pick({ metricKitDiagnostics: true })).toEqual([false, true]);
    expect(pick({ nativeCrashReporting: true, metricKitDiagnostics: false })).toEqual([true, false]);
    expect(pick({ nativeCrashReporting: true, metricKitDiagnostics: true, captureEnabled: false })).toEqual([false, false]);
  });

  it("is enabled only with nativeCrashReporting: true while exception capture is enabled", () => {
    expect(buildNativeCrashConfig({ ...base, nativeCrashReporting: true }).enabled).toBe(true);
    expect(buildNativeCrashConfig({ ...base }).enabled).toBe(false);
    expect(buildNativeCrashConfig({ ...base, nativeCrashReporting: false }).enabled).toBe(false);
    expect(buildNativeCrashConfig({ ...base, nativeCrashReporting: true, captureEnabled: false }).enabled).toBe(false);
  });

  it("uses null for a missing release, dist or build", () => {
    expect(
      buildNativeCrashConfig({ ...base, release: undefined, dist: undefined, build: undefined, nativeCrashReporting: true }),
    ).toEqual({ enabled: true, metricKit: true, release: null, dist: null, distinctId: "a", deviceId: "b", build: null });
  });
});

describe("setNativeCrashReporting module function", () => {
  it("is a no-op before init() and drives the shared client after it", async () => {
    const mod = linkNativeModule();
    expect(() => setNativeCrashReporting({ nativeCrashReporting: true })).not.toThrow();
    const client = init({
      apiHost: "http://localhost:4000",
      token: "proj_test",
      storage: new FakeStorage(),
      fetch: createFakeFetch().fetchImpl,
      flushInterval: 60_000,
      loadFeatureFlags: false,
      appVersion: "3.8.1",
      appBuild: "415",
      platformInfo: { os: "iOS" },
    });
    clients.push(client);
    await client.exceptionsReady;
    await vi.waitFor(() => expect(mod.configureNativeCrashes).toHaveBeenCalledTimes(1));
    // The call before init() did not leak into the new client.
    expect(mod.configs()[0]).toMatchObject({ enabled: false, metricKit: false });
    setNativeCrashReporting({ metricKitDiagnostics: true });
    expect(mod.configs().at(-1)).toMatchObject({ enabled: false, metricKit: true });
  });
});
