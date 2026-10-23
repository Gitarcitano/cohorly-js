import { describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "../src/client.js";
import {
  createFakeFetch,
  createProgrammableFetch,
  FakeStorage,
  requestsTo,
} from "./helpers.js";

describe("track payload shape", () => {
  it("includes distinct_id, time, $insert_id, $lib and merges super props", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.register({ source: "signup" });
    client.track("Button Clicked", { button: "signup" });
    await client.flush();
    client.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/track");
    const [event] = requests[0].body as any[];
    expect(event.event).toBe("Button Clicked");
    expect(event.properties.button).toBe("signup");
    expect(event.properties.source).toBe("signup");
    expect(event.properties.$lib).toBe("react-native");
    expect(typeof event.properties.distinct_id).toBe("string");
    expect(typeof event.properties.time).toBe("number");
    expect(typeof event.properties.$insert_id).toBe("string");
  });

  it("assigns a unique $insert_id per event", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
    });
    await client.ready;
    client.track("a");
    client.track("b");
    await client.flush();
    client.stop();

    const events = requests[0].body as any[];
    expect(events[0].properties.$insert_id).not.toBe(events[1].properties.$insert_id);
  });
});

describe("batching and auto-flush", () => {
  it("flushes automatically once flushAt is reached", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 3,
      flushInterval: 60_000,
    });
    await client.ready;
    client.track("e1");
    client.track("e2");
    expect(requests).toHaveLength(0);
    client.track("e3");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect((requests[0].body as any[]).length).toBe(3);
    client.stop();
  });

  it("flushes automatically on the flush interval timer", async () => {
    vi.useFakeTimers();
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 20,
      flushInterval: 5000,
    });
    await client.ready;
    client.track("e1");
    await vi.advanceTimersByTimeAsync(5001);
    expect(requests).toHaveLength(1);
    client.stop();
    vi.useRealTimers();
  });

  it("re-queues events on send failure so they are retried", async () => {
    const failing = createFakeFetch({ fail: true });
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: failing.fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.track("e1");
    await client.flush();
    expect(failing.requests).toHaveLength(1);

    const ok = createFakeFetch();
    (client as any).fetchImpl = ok.fetchImpl;
    await client.flush();
    expect(ok.requests).toHaveLength(1);
    expect((ok.requests[0].body as any[])[0].event).toBe("e1");
    client.stop();
  });

  it("persists the queue to storage between flushes", async () => {
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
      flushAt: 100,
    });
    await client.ready;
    client.track("queued-event");
    const raw = await storage.getItem("cohorly:queue");
    expect(JSON.parse(raw as string)).toHaveLength(1);
    client.stop();
  });
});

describe("identify persistence", () => {
  it("persists the distinct id across client instances via shared storage", async () => {
    const storage = new FakeStorage();
    const client1 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
    });
    await client1.ready;
    client1.identify("user-42");
    client1.stop();

    const client2 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
    });
    await client2.ready;
    expect(client2.getDistinctId()).toBe("user-42");
    client2.stop();
  });

  it("reset() assigns a fresh anonymous id and clears super props", async () => {
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
    });
    await client.ready;
    client.identify("user-1");
    client.register({ plan: "pro" });
    const before = client.getDistinctId();
    client.reset();
    expect(client.getDistinctId()).not.toBe(before);
    expect(client.getDistinctId()).not.toBe("user-1");
    client.stop();
  });
});

describe("identify() aliasing", () => {
  it("posts /alias linking the previous anonymous id to the new one", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      token: "proj_abc123",
      storage: new FakeStorage(),
      fetch: fetchImpl,
    });
    await client.ready;
    const anonId = client.getDistinctId();
    client.identify("user-42");
    await vi.waitFor(() => expect(requestsTo(requests, "/alias")).toHaveLength(1));
    client.stop();

    expect(requestsTo(requests, "/alias")[0].body).toEqual({
      alias: anonId,
      distinct_id: "user-42",
      token: "proj_abc123",
    });
  });

  it("aliases the persisted anonymous id when identify() runs before ready", async () => {
    // A pre-ready identify() captures the transient constructor uuid as the
    // alias source; hydrate() must swap in the persisted anonymous id so the
    // user's historical events get linked, not the throwaway uuid.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class GatedStorage extends FakeStorage {
      override async getItem(key: string): Promise<string | null> {
        const value = this.store.get(key) ?? null;
        await gate;
        return value;
      }
    }
    const storage = new GatedStorage();
    await storage.setItem("cohorly:distinct_id", "anon-old");
    await storage.setItem("cohorly:anonymous", "1");

    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      token: "proj_abc123",
      storage,
      fetch: fetchImpl,
    });
    client.identify("user-42"); // while hydrate() is gated
    release();
    await client.ready;
    await vi.waitFor(() => expect(requestsTo(requests, "/alias")).toHaveLength(1));
    client.stop();

    expect(requestsTo(requests, "/alias")[0].body).toEqual({
      alias: "anon-old",
      distinct_id: "user-42",
      token: "proj_abc123",
    });
    expect(client.getDistinctId()).toBe("user-42");
  });

  it("aliases the post-reset anonymous id when reset()+identify() run before ready", async () => {
    // A pre-ready reset() followed by identify() still owes the new identity
    // an alias - from the fresh anonymous id reset() minted, not the stale
    // stored predecessor it just discarded.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class GatedStorage extends FakeStorage {
      override async getItem(key: string): Promise<string | null> {
        const value = this.store.get(key) ?? null;
        await gate;
        return value;
      }
    }
    const storage = new GatedStorage();
    await storage.setItem("cohorly:distinct_id", "anon-old");
    await storage.setItem("cohorly:anonymous", "1");

    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      token: "proj_abc123",
      storage,
      fetch: fetchImpl,
    });
    client.reset(); // while hydrate() is gated
    const freshAnonId = client.getDistinctId();
    client.identify("user-42");
    release();
    await client.ready;
    await vi.waitFor(() => expect(requestsTo(requests, "/alias")).toHaveLength(1));
    client.stop();

    expect(requestsTo(requests, "/alias")[0].body).toEqual({
      alias: freshAnonId,
      distinct_id: "user-42",
      token: "proj_abc123",
    });
    expect(client.getDistinctId()).toBe("user-42");
  });

  it("does not alias when the previous id was already identified", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
    });
    await client.ready;
    client.identify("user-1");
    await vi.waitFor(() => expect(requestsTo(requests, "/alias")).toHaveLength(1));
    client.identify("user-2");
    client.stop();

    expect(requestsTo(requests, "/alias")).toHaveLength(1);
    expect(client.getDistinctId()).toBe("user-2");
  });

  it("is a no-op when the id is unchanged", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
    });
    await client.ready;
    const anonId = client.getDistinctId();
    client.identify(anonId);
    client.stop();

    expect(requests).toHaveLength(0);
    // Still anonymous: identify() with the current id is not a backdoor for
    // flipping the anonymous flag (which would suppress $user_id forever).
    expect(client.getDistinctId()).toBe(anonId);
  });

  it("aliases the post-reset anonymous id, not the pre-reset one", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
    });
    await client.ready;
    client.identify("user-1");
    await vi.waitFor(() => expect(requestsTo(requests, "/alias")).toHaveLength(1));
    client.reset();
    const newAnonId = client.getDistinctId();
    client.identify("user-2");
    await vi.waitFor(() => expect(requestsTo(requests, "/alias")).toHaveLength(2));
    client.stop();

    expect((requestsTo(requests, "/alias")[1].body as any).alias).toBe(newAnonId);
  });

  it("sends nothing when the client is disabled", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      disabled: true,
    });
    await client.ready;
    client.identify("user-7");
    await client.flush();
    client.stop();

    expect(requests).toHaveLength(0);
    expect(client.getDistinctId()).toBe("user-7");
  });

  it("swallows an /alias failure and keeps the identity switch", async () => {
    const { fetchImpl, requests } = createFakeFetch({ fail: true });
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
    });
    await client.ready;
    client.identify("user-99");
    expect(client.getDistinctId()).toBe("user-99");
    await vi.waitFor(() => expect(requestsTo(requests, "/alias")).toHaveLength(1));
    client.stop();

    // Never retried: still the single attempt.
    expect(requestsTo(requests, "/alias")).toHaveLength(1);
  });
});

describe("$device_id / $user_id stamping", () => {
  it("stamps $device_id on every event and it survives identify()", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
    });
    await client.ready;
    const deviceId = client.getDeviceId();
    expect(deviceId).toBeTruthy();

    client.track("before");
    client.identify("user-1");
    client.track("after");
    await client.flush();
    client.stop();

    const events = requestsTo(requests, "/track")[0].body as any[];
    expect(events[0].properties.$device_id).toBe(deviceId);
    expect(events[1].properties.$device_id).toBe(deviceId);
    // Device id is preserved across identify().
    expect(client.getDeviceId()).toBe(deviceId);
  });

  it("stamps $user_id only once identified (equal to distinct_id)", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
    });
    await client.ready;
    client.track("anon");
    client.identify("user-42");
    client.track("known");
    await client.flush();
    client.stop();

    const events = requestsTo(requests, "/track")[0].body as any[];
    expect(events[0].properties.$user_id).toBeUndefined();
    expect(events[1].properties.$user_id).toBe("user-42");
    expect(events[1].properties.distinct_id).toBe("user-42");
  });

  it("caller-supplied $device_id / $user_id win over the stamped values", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.identify("user-1");
    client.track("Custom", { $device_id: "my-device", $user_id: "my-user" });
    await client.flush();
    client.stop();

    const [event] = requestsTo(requests, "/track")[0].body as any[];
    expect(event.properties.$device_id).toBe("my-device");
    expect(event.properties.$user_id).toBe("my-user");
  });

  it("reset() mints a new device id (matching the new anon distinct id) and clears timers", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
    });
    await client.ready;
    const beforeDevice = client.getDeviceId();

    // A pending timed event must be dropped by reset().
    client.timeEvent("Purchase");
    client.reset();

    const afterDevice = client.getDeviceId();
    expect(afterDevice).not.toBe(beforeDevice);
    expect(afterDevice).toBe(client.getDistinctId());

    client.track("Purchase");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect(event.properties.$duration).toBeUndefined();
    expect(event.properties.$device_id).toBe(afterDevice);
  });

  it("persists the device id across client instances (survives relaunch)", async () => {
    const storage = new FakeStorage();
    const client1 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
    });
    await client1.ready;
    const deviceId = client1.getDeviceId();
    client1.identify("user-7");
    client1.stop();

    const client2 = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
    });
    await client2.ready;
    expect(client2.getDeviceId()).toBe(deviceId);
    client2.stop();
  });

  it("treats a migrating install without the anonymous flag as anonymous", async () => {
    // Pre-seed only a distinct id (install predating the anonymous/device_id
    // keys): must stay anonymous (no false $user_id) and reuse the distinct id
    // as the device id, self-healing on the next identify().
    const storage = new FakeStorage();
    await storage.setItem("cohorly:distinct_id", "legacy-user");
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    expect(client.getDistinctId()).toBe("legacy-user");
    expect(client.getDeviceId()).toBe("legacy-user");

    client.track("migrated");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect(event.properties.$user_id).toBeUndefined();
    expect(event.properties.$device_id).toBe("legacy-user");
  });
});

describe("token", () => {
  it("stamps token onto every tracked event's properties", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      token: "proj_abc123",
    });
    await client.ready;
    client.track("Signed Up");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect(event.properties.token).toBe("proj_abc123");
  });

  it("includes token as a top-level field on /engage payloads", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      token: "proj_abc123",
    });
    await client.ready;
    client.identify("user-9");
    client.people.set({ plan: "pro" });
    await client.flush();
    client.stop();

    const engageCall = requests.find((r) => r.path === "/engage");
    const [payload] = engageCall!.body as any[];
    expect(payload.token).toBe("proj_abc123");
  });

  it("omits token entirely when not configured", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.track("No Token Event");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect("token" in event.properties).toBe(false);
  });
});

describe("retry contract", () => {
  async function queueLen(storage: FakeStorage): Promise<number> {
    const raw = await storage.getItem("cohorly:queue");
    return raw ? (JSON.parse(raw) as unknown[]).length : 0;
  }

  it("keeps the queue intact on 429 and does not drop events", async () => {
    const { fetchImpl, requests } = createProgrammableFetch(() => ({
      status: 429,
      retryAfter: "60",
    }));
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: fetchImpl,
      flushAt: 20,
    });
    await client.ready;
    client.track("a");
    client.track("b");
    await client.flush();

    expect(requests).toHaveLength(1);
    expect(await queueLen(storage)).toBe(2);
    client.stop();
  });

  it("drops the batch permanently on 400", async () => {
    const { fetchImpl, requests } = createProgrammableFetch(() => ({ status: 400 }));
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: fetchImpl,
      flushAt: 20,
    });
    await client.ready;
    client.track("a");
    client.track("b");
    await client.flush();

    expect(requests).toHaveLength(1);
    expect(await queueLen(storage)).toBe(0);
    client.stop();
  });

  it("halves the effective batch size on 413 without dropping events", async () => {
    let fail = true;
    const { fetchImpl, requests } = createProgrammableFetch(() => ({
      status: fail ? 413 : 200,
    }));
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: fetchImpl,
      flushAt: 8,
    });
    await client.ready;
    ["a", "b", "c", "d"].forEach((e) => client.track(e)); // queue=4, below flushAt 8

    await client.flush(); // batch 4, 413 -> halve 8->4
    expect(await queueLen(storage)).toBe(4); // nothing dropped
    await client.flush(); // batch 4, 413 -> halve 4->2
    await client.flush(); // batch 2, 413 -> halve 2->1
    fail = false;
    await client.flush(); // batch 1, success

    const trackReqs = requests.filter((r) => r.path === "/track");
    expect(trackReqs.map((r) => (r.body as unknown[]).length)).toEqual([4, 4, 2, 1]);
    client.stop();
  });

  it("respects Retry-After: retryAfter=0 allows the next auto-flush, a large value blocks it", async () => {
    async function run(retryAfter: string): Promise<number> {
      const { fetchImpl, requests } = createProgrammableFetch(() => ({
        status: 429,
        retryAfter,
      }));
      const storage = new FakeStorage();
      const client = new CohorlyClient({
        apiHost: "http://localhost:4000",
        storage,
        fetch: fetchImpl,
        flushAt: 1,
      });
      await client.ready;
      client.track("a"); // size trigger -> attempt 1 fails, sets backoff
      await vi.waitFor(() => expect(requests.length).toBe(1));
      await new Promise((r) => setTimeout(r, 10)); // let the flush settle + backoff set
      client.track("b"); // size trigger honored/blocked by backoff
      await new Promise((r) => setTimeout(r, 20));
      client.stop();
      return requests.length;
    }

    expect(await run("0")).toBe(2); // backoff elapsed -> retried
    expect(await run("60")).toBe(1); // still backing off -> skipped
  });

  it("caps the persisted queue at maxQueueSize, dropping the oldest", async () => {
    const storage = new FakeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      fetch: createFakeFetch().fetchImpl,
      flushAt: 100_000, // never auto-flush
      maxQueueSize: 3,
    });
    await client.ready;
    ["a", "b", "c", "d", "e"].forEach((e) => client.track(e));

    const raw = await storage.getItem("cohorly:queue");
    const queued = JSON.parse(raw as string) as { event: string }[];
    expect(queued.map((e) => e.event)).toEqual(["c", "d", "e"]);
    client.stop();
  });
});

describe("people (engage) queue", () => {
  it("sends $set payloads to /engage", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.identify("user-9");
    client.people.set({ plan: "pro" });
    await client.flush();
    client.stop();

    const engage = requestsTo(requests, "/engage");
    expect(engage).toHaveLength(1);
    const [payload] = engage[0].body as any[];
    expect(payload.distinct_id).toBe("user-9");
    expect(payload.$set).toEqual({ plan: "pro" });
  });
});

describe("people profile default properties", () => {
  it("merges $android_* defaults into people.set on Android, user keys winning", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      appVersion: "3.4.5",
      appBuild: "99",
      platformInfo: {
        os: "Android",
        osVersion: 34,
        model: "Pixel 8",
        manufacturer: "Google",
        brand: "google",
      },
    });
    await client.ready;
    client.people.set({ plan: "pro", $android_brand: "custom" });
    await client.flush();
    client.stop();

    const [payload] = requests[0].body as any[];
    expect(payload.$set.plan).toBe("pro");
    expect(payload.$set.$android_os).toBe("Android");
    expect(payload.$set.$android_os_version).toBe("34");
    expect(payload.$set.$android_app_version).toBe("3.4.5");
    expect(payload.$set.$android_model).toBe("Pixel 8");
    expect(payload.$set.$android_manufacturer).toBe("Google");
    expect(typeof payload.$set.$android_lib_version).toBe("string");
    // user key wins over the derived default
    expect(payload.$set.$android_brand).toBe("custom");
    // iOS keys are not attached on Android
    expect("$ios_version" in payload.$set).toBe(false);
  });

  it("merges $ios_* defaults into people.setOnce on iOS with correct app-release/version mapping", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      appVersion: "1.2.3",
      appBuild: "42",
      platformInfo: { os: "iOS", osVersion: "17.0", model: "iPhone15,3" },
    });
    await client.ready;
    client.people.setOnce({ first_seen: "2026-01-01", $ios_device_model: "custom" });
    await client.flush();
    client.stop();

    const [payload] = requests[0].body as any[];
    expect(payload.$set_once.first_seen).toBe("2026-01-01");
    expect(payload.$set_once.$ios_version).toBe("17.0");
    expect(payload.$set_once.$ios_app_release).toBe("1.2.3"); // app version
    expect(payload.$set_once.$ios_app_version).toBe("42"); // build number
    expect(typeof payload.$set_once.$ios_lib_version).toBe("string");
    // user key wins over the derived default
    expect(payload.$set_once.$ios_device_model).toBe("custom");
    // android keys are not attached on iOS
    expect("$android_os" in payload.$set_once).toBe(false);
  });

  it("does not attach profile defaults to people.increment", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
      appVersion: "3.4.5",
      platformInfo: { os: "Android", osVersion: 34 },
    });
    await client.ready;
    client.people.increment({ logins: 1 });
    await client.flush();
    client.stop();

    const [payload] = requests[0].body as any[];
    expect(payload.$add).toEqual({ logins: 1 });
    expect("$android_os" in payload.$add).toBe(false);
  });
});

describe("timed events ($duration)", () => {
  it("attaches $duration (seconds, 3 decimals) on the next track and clears the timer", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
    });
    await client.ready;

    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      client.timeEvent("Checkout");
      now += 2500; // 2.5s elapsed
      client.track("Checkout", { total: 42 });
      // Second track of the same event has no active timer -> no $duration.
      now += 5000;
      client.track("Checkout");
    } finally {
      Date.now = originalNow;
    }
    await client.flush();
    client.stop();

    const events = requests.flatMap((r) => r.body as any[]).filter((e) => e.event === "Checkout");
    expect(events).toHaveLength(2);
    expect(events[0].properties.$duration).toBe(2.5);
    expect(events[0].properties.total).toBe(42);
    expect("$duration" in events[1].properties).toBe(false);
  });

  it("clearTimedEvent cancels a pending timer so no $duration is attached", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 1,
    });
    await client.ready;
    client.timeEvent("Flow");
    client.clearTimedEvent("Flow");
    client.track("Flow");
    await client.flush();
    client.stop();

    const [event] = requests[0].body as any[];
    expect("$duration" in event.properties).toBe(false);
  });

  it("clearTimedEvents cancels all pending timers", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushAt: 100,
    });
    await client.ready;
    client.timeEvent("A");
    client.timeEvent("B");
    client.clearTimedEvents();
    client.track("A");
    client.track("B");
    await client.flush();
    client.stop();

    const events = requests.flatMap((r) => r.body as any[]);
    expect(events.every((e) => !("$duration" in e.properties))).toBe(true);
  });
});
