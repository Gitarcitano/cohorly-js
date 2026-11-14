import { afterEach, describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "../src/client.js";
import { createFakeFetch, type FakeRequest, FakeStorage, requestsTo } from "./helpers.js";

type AnyEvent = { event: string; properties: Record<string, any> };

/** AsyncStorage whose reads resolve only once `open()` is called (a slow cold start). */
class GatedStorage extends FakeStorage {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  open(): void {
    this.release();
  }

  override async getItem(key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    await this.gate;
    return value;
  }
}

const clients: CohorlyClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
});

function start(storage: GatedStorage) {
  const { fetchImpl, requests } = createFakeFetch();
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    storage,
    fetch: fetchImpl,
    flushInterval: 60_000,
    loadFeatureFlags: false,
    platformInfo: { os: "iOS" },
  });
  clients.push(client);
  return { client, requests };
}

/** Opens the storage, waits for the replay and returns the exceptions by message. */
async function hydrateAndSend(
  storage: GatedStorage,
  client: CohorlyClient,
  requests: FakeRequest[],
  count: number,
): Promise<Record<string, Record<string, any>>> {
  storage.open();
  await client.exceptionsReady;
  await client.flush();
  const exceptions = () =>
    requestsTo(requests, "/track")
      .flatMap((r) => r.body as AnyEvent[])
      .filter((e) => e.event === "$exception");
  await vi.waitFor(() => expect(exceptions()).toHaveLength(count));
  return Object.fromEntries(
    exceptions().map((e) => [e.properties.$exception_list[0].value, e.properties]),
  );
}

async function seeded(identity: { distinctId: string; anonymous: boolean; deviceId: string }) {
  const storage = new GatedStorage();
  await storage.setItem("cohorly:distinct_id", identity.distinctId);
  await storage.setItem("cohorly:anonymous", identity.anonymous ? "1" : "0");
  await storage.setItem("cohorly:device_id", identity.deviceId);
  return storage;
}

describe("exceptions captured before the hydration keep the identity of their moment", () => {
  it("with no identity change, carry the persisted identity and the capture time", async () => {
    const storage = await seeded({ distinctId: "member-7", anonymous: false, deviceId: "dev-7" });
    const { client, requests } = start(storage);

    const before = Date.now();
    client.captureException(new Error("boot"));
    const after = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const byValue = await hydrateAndSend(storage, client, requests, 1);
    expect(byValue.boot).toMatchObject({
      distinct_id: "member-7",
      $device_id: "dev-7",
      $user_id: "member-7",
    });
    expect(byValue.boot.time).toBeGreaterThanOrEqual(before);
    expect(byValue.boot.time).toBeLessThanOrEqual(after);
  });

  it("an anonymous persisted identity gets no $user_id", async () => {
    const storage = await seeded({ distinctId: "anon-1", anonymous: true, deviceId: "anon-1" });
    const { client, requests } = start(storage);

    client.captureException(new Error("boot"));

    const byValue = await hydrateAndSend(storage, client, requests, 1);
    expect(byValue.boot).toMatchObject({ distinct_id: "anon-1", $device_id: "anon-1" });
    expect(byValue.boot).not.toHaveProperty("$user_id");
  });

  it("an identify() during the hydration claims only what is captured after it", async () => {
    const storage = await seeded({ distinctId: "anon-1", anonymous: true, deviceId: "anon-1" });
    const { client, requests } = start(storage);

    client.captureException(new Error("before login"));
    client.identify("u");
    client.captureException(new Error("after login"));

    const byValue = await hydrateAndSend(storage, client, requests, 2);
    expect(byValue["before login"]).toMatchObject({ distinct_id: "anon-1", $device_id: "anon-1" });
    expect(byValue["before login"]).not.toHaveProperty("$user_id");
    // identify() keeps the persisted device.
    expect(byValue["after login"]).toMatchObject({
      distinct_id: "u",
      $user_id: "u",
      $device_id: "anon-1",
    });
  });

  it("a reset() during the hydration splits the captures between the old and the new identity", async () => {
    const storage = await seeded({ distinctId: "member-7", anonymous: false, deviceId: "dev-7" });
    const { client, requests } = start(storage);

    client.captureException(new Error("before reset"));
    client.reset();
    const fresh = client.getDistinctId();
    client.captureException(new Error("after reset"));

    const byValue = await hydrateAndSend(storage, client, requests, 2);
    expect(byValue["before reset"]).toMatchObject({
      distinct_id: "member-7",
      $device_id: "dev-7",
      $user_id: "member-7",
    });
    expect(byValue["after reset"]).toMatchObject({ distinct_id: fresh, $device_id: fresh });
    expect(byValue["after reset"]).not.toHaveProperty("$user_id");
    expect(client.getDistinctId()).toBe(fresh);
  });

  it("a fresh install stamps the anonymous id the hydration persists, even with an identify() after the capture", async () => {
    const storage = new GatedStorage();
    const { client, requests } = start(storage);

    client.captureException(new Error("first launch"));
    client.identify("u");
    client.captureException(new Error("signed in"));

    const byValue = await hydrateAndSend(storage, client, requests, 2);
    const device = storage.store.get("cohorly:device_id");
    expect(device).toBeTruthy();
    expect(byValue["first launch"]).toMatchObject({ distinct_id: device, $device_id: device });
    expect(byValue["first launch"]).not.toHaveProperty("$user_id");
    expect(byValue["signed in"]).toMatchObject({ distinct_id: "u", $user_id: "u", $device_id: device });
    expect(client.getDeviceId()).toBe(device);
  });

  it("a fresh install without identity changes stamps the id the hydration persists", async () => {
    const storage = new GatedStorage();
    const { client, requests } = start(storage);

    client.captureException(new Error("first launch"));

    const byValue = await hydrateAndSend(storage, client, requests, 1);
    const persisted = storage.store.get("cohorly:distinct_id");
    expect(byValue["first launch"]).toMatchObject({ distinct_id: persisted, $device_id: persisted });
    expect(client.getDistinctId()).toBe(persisted);
  });
});

describe("an install with no stored device id (migration)", () => {
  async function withoutDevice(distinctId: string, anonymous: boolean) {
    const storage = new GatedStorage();
    await storage.setItem("cohorly:distinct_id", distinctId);
    await storage.setItem("cohorly:anonymous", anonymous ? "1" : "0");
    return storage;
  }

  /** A second launch on the same storage, read without a gate. */
  async function relaunchDevice(storage: GatedStorage): Promise<string> {
    const next = new FakeStorage();
    next.store = new Map(storage.store);
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: next,
      fetch: createFakeFetch().fetchImpl,
      flushInterval: 60_000,
      loadFeatureFlags: false,
      platformInfo: { os: "iOS" },
    });
    clients.push(client);
    await client.ready;
    return client.getDeviceId();
  }

  it("anonymous: the anonymous id becomes the device, before and after a pre-ready identify()", async () => {
    const storage = await withoutDevice("anon-2", true);
    const { client, requests } = start(storage);

    client.captureException(new Error("before login"));
    client.identify("u");
    client.captureException(new Error("after login"));

    const byValue = await hydrateAndSend(storage, client, requests, 2);
    expect(byValue["before login"]).toMatchObject({ distinct_id: "anon-2", $device_id: "anon-2" });
    expect(byValue["before login"]).not.toHaveProperty("$user_id");
    expect(byValue["after login"]).toMatchObject({ distinct_id: "u", $user_id: "u", $device_id: "anon-2" });
    expect(storage.store.get("cohorly:device_id")).toBe("anon-2");
    expect(await relaunchDevice(storage)).toBe("anon-2");
  });

  it("identified: a fresh device id, never the distinct id, kept across the identify() and the next launch", async () => {
    const storage = await withoutDevice("member-8", false);
    const { client, requests } = start(storage);

    client.captureException(new Error("before switch"));
    client.identify("v");
    client.captureException(new Error("after switch"));

    const byValue = await hydrateAndSend(storage, client, requests, 2);
    const device = byValue["before switch"].$device_id as string;
    expect(typeof device).toBe("string");
    expect(device).not.toBe("member-8");
    expect(device).not.toBe("v");
    expect(byValue["before switch"]).toMatchObject({ distinct_id: "member-8", $user_id: "member-8" });
    expect(byValue["after switch"]).toMatchObject({ distinct_id: "v", $user_id: "v", $device_id: device });
    expect(storage.store.get("cohorly:device_id")).toBe(device);
    expect(await relaunchDevice(storage)).toBe(device);
  });
});
