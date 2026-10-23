import { afterEach, describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "./client.js";
import { TransportError } from "./transport.js";
import type { CohorlyStorage, CohorlyTransport } from "./types.js";

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

function makeClient(overrides?: {
  storage?: CohorlyStorage;
  transport?: CohorlyTransport;
}) {
  const storage = overrides?.storage ?? makeStorage();
  const calls: { url: string; body: unknown }[] = [];
  const transport: CohorlyTransport =
    overrides?.transport ??
    (async (url, body) => {
      calls.push({ url, body });
    });
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    storage,
    transport,
    flushIntervalMs: 0, // disable auto-flush timer in tests
    batchSize: 20,
  });
  return { client, storage, calls };
}

describe("track", () => {
  it("enqueues an event with the expected shape", () => {
    const { client } = makeClient();
    const evt = client.track("Signed Up", { plan: "pro" });

    expect(evt.event).toBe("Signed Up");
    expect(evt.properties.plan).toBe("pro");
    expect(typeof evt.properties.distinct_id).toBe("string");
    expect(evt.properties.distinct_id.length).toBeGreaterThan(0);
    expect(typeof evt.properties.time).toBe("number");
    expect(typeof evt.properties.$insert_id).toBe("string");
    expect(evt.properties.$insert_id).toMatch(
      /^[0-9a-f-]{36}$|^[0-9a-f]{32}$/i,
    );
    expect(evt.properties.$lib).toBe("core");
  });

  it("merges registered super properties into every event", () => {
    const { client } = makeClient();
    client.register({ app_version: "1.2.3" });
    const evt = client.track("Viewed Page");
    expect(evt.properties.app_version).toBe("1.2.3");

    client.unregister("app_version");
    const evt2 = client.track("Viewed Page 2");
    expect(evt2.properties.app_version).toBeUndefined();
  });

  it("event-level properties override super properties", () => {
    const { client } = makeClient();
    client.register({ plan: "free" });
    const evt = client.track("Upgraded", { plan: "pro" });
    expect(evt.properties.plan).toBe("pro");
  });
});

describe("identify", () => {
  it("sends an alias request when switching from an anonymous id, then persists the new id", async () => {
    const { client, calls, storage } = makeClient();
    const anonId = client.getDistinctId();
    expect(client.isAnonymous()).toBe(true);

    await client.identify("user-42");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:4000/alias");
    expect(calls[0].body).toEqual({ alias: anonId, distinct_id: "user-42" });

    expect(client.getDistinctId()).toBe("user-42");
    expect(client.isAnonymous()).toBe(false);
    expect(storage.get("cohorly_distinct_id")).toBe("user-42");
    expect(storage.get("cohorly_anonymous")).toBe("0");
  });

  it("does not alias again once already identified", async () => {
    const { client, calls } = makeClient();
    await client.identify("user-42");
    await client.identify("user-99");
    // second identify: no longer anonymous, so no new alias call
    expect(calls).toHaveLength(1);
    expect(client.getDistinctId()).toBe("user-99");
  });

  it("switches identity before the alias POST resolves, even when the transport hangs", async () => {
    let resolveAlias: (() => void) | undefined;
    const hangingTransport: CohorlyTransport = () =>
      new Promise((resolve) => {
        resolveAlias = () => resolve(undefined);
      });
    const { client } = makeClient({ transport: hangingTransport });

    const identifyPromise = client.identify("user-42");
    // The alias POST is still in flight (unresolved), but the switch must
    // already be observable - that's the bug this fix closes.
    expect(client.getDistinctId()).toBe("user-42");
    expect(client.isAnonymous()).toBe(false);

    resolveAlias?.();
    await identifyPromise;
  });

  it("does not throw out of identify() when the alias transport rejects", async () => {
    const rejectingTransport: CohorlyTransport = async () => {
      throw new Error("network down");
    };
    const { client } = makeClient({ transport: rejectingTransport });

    await expect(client.identify("user-42")).resolves.toBeUndefined();
    // the identity switch still applies despite the rejection
    expect(client.getDistinctId()).toBe("user-42");
    expect(client.isAnonymous()).toBe(false);
  });

  it("posts the alias body with the old id as alias and the new id as distinct_id", async () => {
    const { client, calls } = makeClient();
    const anonId = client.getDistinctId();
    await client.identify("user-42");

    const aliasCall = calls.find((c) => c.url.endsWith("/alias"));
    expect(aliasCall!.body).toEqual({ alias: anonId, distinct_id: "user-42" });
  });

  it("does not POST /alias when the previous id was already identified", async () => {
    const { client, calls } = makeClient();
    await client.identify("user-42"); // anonymous -> identified: aliases
    await client.identify("user-99"); // already identified: no alias
    expect(calls.filter((c) => c.url.endsWith("/alias"))).toHaveLength(1);
    expect(client.getDistinctId()).toBe("user-99");
    expect(client.isAnonymous()).toBe(false);
  });
});

describe("reset", () => {
  it("generates a fresh anonymous id", () => {
    const { client } = makeClient();
    const before = client.getDistinctId();
    client.reset();
    expect(client.getDistinctId()).not.toBe(before);
    expect(client.isAnonymous()).toBe(true);
  });
});

describe("batching and flush", () => {
  it("auto-flushes once batchSize is reached", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const storage = makeStorage();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport: async (url, body) => {
        calls.push({ url, body });
      },
      flushIntervalMs: 0,
      batchSize: 2,
    });

    client.track("a");
    client.track("b");
    // batchSize reached synchronously triggers an async flush; wait a tick
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("http://localhost:4000/track");
    expect(Array.isArray(calls[0].body)).toBe(true);
    expect((calls[0].body as unknown[]).length).toBe(2);
  });

  it("flush() sends the queued batch to /track", async () => {
    const { client, calls } = makeClient();
    client.track("a");
    client.track("b");
    await client.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:4000/track");
    expect((calls[0].body as unknown[]).length).toBe(2);
  });

  it("persists the queue across client instances via storage", () => {
    const storage = makeStorage();
    const { client: client1 } = makeClient({ storage });
    client1.track("a");

    const { client: client2 } = makeClient({ storage });
    // second client loads persisted queue from storage
    const raw = storage.get("cohorly_queue");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toHaveLength(1);
    void client2;
  });

  it("keeps events in the queue when the transport rejects", async () => {
    const storage = makeStorage();
    const failingTransport: CohorlyTransport = async () => {
      throw new Error("network down");
    };
    const { client } = makeClient({ storage, transport: failingTransport });
    client.track("a");
    await client.flush();

    const raw = storage.get("cohorly_queue");
    expect(JSON.parse(raw!)).toHaveLength(1);
  });
});

describe("token", () => {
  function makeTokenClient(overrides?: { storage?: CohorlyStorage; transport?: CohorlyTransport }) {
    const storage = overrides?.storage ?? makeStorage();
    const calls: { url: string; body: unknown }[] = [];
    const transport: CohorlyTransport =
      overrides?.transport ??
      (async (url, body) => {
        calls.push({ url, body });
      });
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 20,
      token: "proj_abc123",
    });
    return { client, storage, calls };
  }

  it("stamps token onto every tracked event's properties", () => {
    const { client } = makeTokenClient();
    const evt = client.track("Signed Up", { plan: "pro" });
    expect(evt.properties.token).toBe("proj_abc123");
  });

  it("includes token in /engage bodies", async () => {
    const { client, calls } = makeTokenClient();
    await client.people.set({ name: "Ada" });
    const engageCall = calls.find((c) => c.url.endsWith("/engage"));
    expect(engageCall!.body).toMatchObject({ token: "proj_abc123" });
  });

  it("includes token in /alias bodies", async () => {
    const { client, calls } = makeTokenClient();
    await client.identify("user-1");
    const aliasCall = calls.find((c) => c.url.endsWith("/alias"));
    expect(aliasCall!.body).toMatchObject({ token: "proj_abc123" });
  });

  it("omits token entirely when not configured", () => {
    const { client } = makeClient();
    const evt = client.track("No Token Event");
    expect("token" in evt.properties).toBe(false);
  });
});

describe("retry contract", () => {
  const apiHost = "http://localhost:4000";

  // Let a fire-and-forget maybeFlush() settle its microtasks.
  const tick = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  function queueLen(storage: CohorlyStorage): number {
    const raw = storage.get("cohorly_queue");
    return raw ? (JSON.parse(raw) as unknown[]).length : 0;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("429 keeps the queue intact and does not drop events", async () => {
    const storage = makeStorage();
    const calls: unknown[] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      calls.push(body);
      throw new TransportError(429, 60_000);
    };
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 20,
    });
    client.track("a");
    client.track("b");
    await client.flush();

    expect(calls).toHaveLength(1);
    expect(queueLen(storage)).toBe(2);
    client.stop();
  });

  it("respects Retry-After: retryAfter=0 allows immediate auto-retry, a large value blocks it", async () => {
    // retryAfter overrides the computed 2000ms backoff, so a 0 lets the next
    // size-triggered auto-flush proceed while a large value blocks it.
    async function run(retryAfterMs: number): Promise<number> {
      const storage = makeStorage();
      const calls: unknown[] = [];
      const transport: CohorlyTransport = async (_url, body) => {
        calls.push(body);
        throw new TransportError(429, retryAfterMs);
      };
      const client = new CohorlyClient({
        apiHost,
        storage,
        transport,
        flushIntervalMs: 0,
        batchSize: 1,
      });
      client.track("a"); // size trigger -> attempt 1 (fails, sets backoff)
      await tick();
      client.track("b"); // size trigger -> maybeFlush, honored/blocked by backoff
      await tick();
      client.stop();
      return calls.length;
    }

    expect(await run(0)).toBe(2); // backoff elapsed immediately -> retried
    expect(await run(60_000)).toBe(1); // still backing off -> skipped
  });

  it("grows backoff exponentially and resets it on success", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 0

    const storage = makeStorage();
    const calls: unknown[] = [];
    let mode: "fail" | "ok" = "fail";
    const transport: CohorlyTransport = async (_url, body) => {
      calls.push(body);
      if (mode === "fail") throw new TransportError(429); // no Retry-After -> computed backoff
    };
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 1,
    });

    client.track("a"); // attempt 1 fails -> backoff 2000ms
    await tick();
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(1999);
    client.track("b"); // still inside 2000ms backoff -> skipped
    await tick();
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(2); // now past 2000ms
    client.track("c"); // attempt 2 fails -> backoff grows to 4000ms
    await tick();
    expect(calls).toHaveLength(2);

    vi.advanceTimersByTime(2001);
    client.track("d"); // only 2001ms elapsed, backoff is now 4000ms -> skipped
    await tick();
    expect(calls).toHaveLength(2);

    vi.advanceTimersByTime(2000); // past the 4000ms window
    mode = "ok";
    client.track("e"); // attempt 3 succeeds -> resets failures + backoff
    await tick();
    expect(calls).toHaveLength(3);

    // Backoff cleared: a fresh size trigger flushes immediately (no wait).
    client.track("f");
    await tick();
    expect(calls).toHaveLength(4);
    client.stop();
  });

  it("drops the batch permanently on 400 (does not retry forever)", async () => {
    const storage = makeStorage();
    const calls: unknown[] = [];
    const transport: CohorlyTransport = async (_url, body) => {
      calls.push(body);
      throw new TransportError(400);
    };
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 20,
    });
    client.track("a");
    client.track("b");
    await client.flush();

    expect(calls).toHaveLength(1);
    expect(queueLen(storage)).toBe(0); // batch dropped, not re-queued
    client.stop();
  });

  it("halves the effective batch size on 413 without dropping events", async () => {
    const storage = makeStorage();
    const batchLens: number[] = [];
    let fail = true;
    const transport: CohorlyTransport = async (_url, body) => {
      batchLens.push((body as unknown[]).length);
      if (fail) throw new TransportError(413);
    };
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport,
      flushIntervalMs: 0,
      batchSize: 8,
    });
    ["a", "b", "c", "d"].forEach((e) => client.track(e)); // queue=4, below batchSize 8

    await client.flush(); // batch min(8,4)=4, 413 -> halve 8->4
    expect(queueLen(storage)).toBe(4); // nothing dropped
    await client.flush(); // batch min(4,4)=4, 413 -> halve 4->2
    await client.flush(); // batch min(2,4)=2, 413 -> halve 2->1
    fail = false;
    await client.flush(); // batch min(1,4)=1, success

    expect(batchLens).toEqual([4, 4, 2, 1]);
    expect(queueLen(storage)).toBe(3); // one event flushed, three remain
    client.stop();
  });

  it("caps the persisted queue at maxQueueSize, dropping the oldest events", () => {
    const storage = makeStorage();
    const client = new CohorlyClient({
      apiHost,
      storage,
      transport: async () => {},
      flushIntervalMs: 0,
      batchSize: 100_000, // never auto-flush
      maxQueueSize: 3,
    });
    ["a", "b", "c", "d", "e"].forEach((e) => client.track(e));

    const queued = JSON.parse(storage.get("cohorly_queue")!) as {
      event: string;
    }[];
    expect(queued.map((e) => e.event)).toEqual(["c", "d", "e"]);
    client.stop();
  });
});

describe("$device_id / $user_id", () => {
  it("stamps $device_id on every event and no $user_id while anonymous", () => {
    const { client } = makeClient();
    const evt = client.track("Anon Event");
    expect(evt.properties.$device_id).toBe(client.getDeviceId());
    expect("$user_id" in evt.properties).toBe(false);
  });

  it("keeps the same $device_id across identify and adds $user_id once identified", async () => {
    const { client } = makeClient();
    const deviceId = client.getDeviceId();
    await client.identify("user-42");
    const evt = client.track("After Identify");
    expect(evt.properties.$device_id).toBe(deviceId); // unchanged
    expect(evt.properties.$user_id).toBe("user-42");
    expect(evt.properties.distinct_id).toBe("user-42");
  });

  it("persists $device_id across client instances (survives identify + reload)", async () => {
    const storage = makeStorage();
    const { client: c1 } = makeClient({ storage });
    const deviceId = c1.getDeviceId();
    await c1.identify("user-7");

    const { client: c2 } = makeClient({ storage });
    expect(c2.getDeviceId()).toBe(deviceId);
    expect(c2.track("x").properties.$device_id).toBe(deviceId);
  });

  it("reset() mints a fresh $device_id", () => {
    const { client } = makeClient();
    const before = client.getDeviceId();
    client.reset();
    expect(client.getDeviceId()).not.toBe(before);
    expect(client.track("y").properties.$device_id).toBe(client.getDeviceId());
  });

  it("does not override caller-supplied $device_id / $user_id", () => {
    const { client } = makeClient();
    const evt = client.track("Custom", {
      $device_id: "custom-device",
      $user_id: "custom-user",
    });
    expect(evt.properties.$device_id).toBe("custom-device");
    expect(evt.properties.$user_id).toBe("custom-user");
  });
});

describe("timed events", () => {
  it("attaches $duration (seconds, 3 decimals) then clears the timer", () => {
    const { client } = makeClient();
    const now = 1_000_000;
    const spy = vi.spyOn(Date, "now");
    spy.mockReturnValue(now);
    client.timeEvent("Checkout");
    spy.mockReturnValue(now + 2500); // 2.5s later
    const evt = client.track("Checkout");
    expect(evt.properties.$duration).toBe(2.5);

    // timer cleared: a second track has no $duration
    spy.mockReturnValue(now + 9999);
    const evt2 = client.track("Checkout");
    expect("$duration" in evt2.properties).toBe(false);
    spy.mockRestore();
  });

  it("only times the matching event name", () => {
    const { client } = makeClient();
    client.timeEvent("A");
    const other = client.track("B");
    expect("$duration" in other.properties).toBe(false);
  });

  it("clearTimedEvent / clearTimedEvents cancel pending timers", () => {
    const { client } = makeClient();
    client.timeEvent("A");
    client.timeEvent("B");
    client.clearTimedEvent("A");
    expect("$duration" in client.track("A").properties).toBe(false);
    expect("$duration" in client.track("B").properties).toBe(true);

    client.timeEvent("C");
    client.clearTimedEvents();
    expect("$duration" in client.track("C").properties).toBe(false);
  });

  it("persists timers across client instances", () => {
    const storage = makeStorage();
    const now = 500_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    const { client: c1 } = makeClient({ storage });
    c1.timeEvent("Reload");

    spy.mockReturnValue(now + 1000);
    const { client: c2 } = makeClient({ storage });
    expect(c2.track("Reload").properties.$duration).toBe(1);
    spy.mockRestore();
  });
});

describe("people", () => {
  it("people.set posts a $set engage payload", async () => {
    const { client, calls } = makeClient();
    await client.identify("user-1");
    await client.people.set({ name: "Ada" });

    const engageCall = calls.find((c) => c.url.endsWith("/engage"));
    expect(engageCall).toBeTruthy();
    expect(engageCall!.body).toEqual({
      distinct_id: "user-1",
      $set: { name: "Ada" },
    });
  });

  it("people.increment posts a $add engage payload", async () => {
    const { client, calls } = makeClient();
    await client.people.increment({ logins: 1 });
    const engageCall = calls.find((c) => c.url.endsWith("/engage"));
    expect(engageCall!.body).toMatchObject({ $add: { logins: 1 } });
  });
});

describe("feature flags", () => {
  const flagsResponse = {
    flags: {
      checkout: {
        enabled: true,
        variant: null,
        payload: null,
        reason: "rule:0",
      },
      banner: {
        enabled: true,
        variant: "blue",
        payload: { color: "#00f" },
        reason: "rule:0",
      },
      hidden: { enabled: false, variant: null, payload: null, reason: "no_match" },
    },
  };

  function makeFlagClient(overrides?: {
    storage?: CohorlyStorage;
    respond?: (body: unknown) => unknown;
  }) {
    const storage = overrides?.storage ?? makeStorage();
    const calls: { url: string; body: unknown }[] = [];
    const fetchCalls: { url: string; body: unknown }[] = [];
    const transport: CohorlyTransport = async (url, body) => {
      calls.push({ url, body });
    };
    const respond = overrides?.respond ?? (() => flagsResponse);
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport,
      flushIntervalMs: 0,
      token: "tok-1",
      fetcher: async (url, body) => {
        fetchCalls.push({ url, body });
        return respond(body);
      },
    });
    return { client, storage, calls, fetchCalls };
  }

  it("reload posts distinct_id + token, caches to storage, and answers getters", async () => {
    const { client, storage, fetchCalls } = makeFlagClient();
    expect(client.getFeatureFlag("checkout")).toBe(false);

    await client.reloadFeatureFlags();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://localhost:4000/flags/evaluate");
    expect(fetchCalls[0].body).toEqual({
      distinct_id: client.getDistinctId(),
      token: "tok-1",
    });

    expect(client.isFeatureEnabled("checkout")).toBe(true);
    expect(client.getFeatureFlag("checkout")).toBe(true);
    expect(client.getFeatureFlag("banner")).toBe("blue");
    expect(client.getFeatureFlagPayload("banner")).toEqual({ color: "#00f" });
    expect(client.isFeatureEnabled("hidden")).toBe(false);
    expect(client.getFeatureFlag("nope")).toBe(false);
    expect(client.getFeatureFlagPayload("nope")).toBeNull();

    const cached = JSON.parse(storage.get("chl_flags")!);
    expect(cached.distinct_id).toBe(client.getDistinctId());
    expect(cached.flags.banner.variant).toBe("blue");
  });

  it("loads the persisted cache on construction for the same distinct id", async () => {
    const storage = makeStorage();
    const { client: c1 } = makeFlagClient({ storage });
    await c1.reloadFeatureFlags();

    const { client: c2 } = makeFlagClient({ storage });
    expect(c2.getFeatureFlag("banner")).toBe("blue");
    // Cached flags count as loaded: onFeatureFlags fires immediately.
    let fired = 0;
    c2.onFeatureFlags(() => {
      fired += 1;
    });
    expect(fired).toBe(1);
  });

  it("discards a cache written for a different distinct id", () => {
    const storage = makeStorage();
    storage.set(
      "chl_flags",
      JSON.stringify({ distinct_id: "someone-else", flags: flagsResponse.flags }),
    );
    const { client } = makeFlagClient({ storage });
    expect(client.getFeatureFlag("checkout")).toBe(false);
    expect(storage.get("chl_flags")).toBeNull();
  });

  it("reloads flags on identify() and reset() with the new distinct id", async () => {
    const { client, fetchCalls } = makeFlagClient();
    await client.identify("user-42");
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].body).toMatchObject({ distinct_id: "user-42" });

    client.reset();
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(2));
    expect(fetchCalls[1].body).toMatchObject({
      distinct_id: client.getDistinctId(),
    });
  });

  it("identify() drops the previous identity's flags even when the reload fails", async () => {
    let fail = false;
    const { client, storage } = makeFlagClient({
      respond: () => (fail ? undefined : flagsResponse),
    });
    await client.reloadFeatureFlags();
    expect(client.getFeatureFlag("banner")).toBe("blue");

    fail = true;
    await client.identify("user-42");
    expect(client.getFeatureFlag("banner")).toBe(false);
    expect(storage.get("chl_flags")).toBeNull();
  });

  it("onFeatureFlags fires after each successful reload and unsubscribes", async () => {
    const { client } = makeFlagClient();
    const seen: unknown[] = [];
    const unsubscribe = client.onFeatureFlags((flags) => {
      seen.push(flags);
    });
    expect(seen).toHaveLength(0); // not loaded yet: no immediate fire

    await client.reloadFeatureFlags();
    expect(seen).toHaveLength(1);

    await client.reloadFeatureFlags();
    expect(seen).toHaveLength(2);

    unsubscribe();
    await client.reloadFeatureFlags();
    expect(seen).toHaveLength(2);
  });

  it("a failed reload keeps the stale cache and never throws", async () => {
    let fail = false;
    const { client, storage } = makeFlagClient({
      respond: () => (fail ? undefined : flagsResponse),
    });
    await client.reloadFeatureFlags();
    expect(client.getFeatureFlag("banner")).toBe("blue");

    fail = true;
    await expect(client.reloadFeatureFlags()).resolves.toBeUndefined();
    expect(client.getFeatureFlag("banner")).toBe("blue");
    expect(JSON.parse(storage.get("chl_flags")!).flags.banner.variant).toBe(
      "blue",
    );
  });

  it("explicit fallbacks resolve unknown keys without emitting an exposure", async () => {
    const { client, storage } = makeFlagClient();
    expect(client.getFeatureFlag("nope", "control")).toBe("control");
    expect(client.isFeatureEnabled("nope", true)).toBe(true);
    expect(client.getFeatureFlag("checkout", "control")).toBe("control");

    await client.reloadFeatureFlags();
    expect(client.getFeatureFlag("nope", "control")).toBe("control");
    expect(client.isFeatureEnabled("nope", true)).toBe(true);
    // A known flag ignores the fallback and still counts as an exposure.
    expect(client.getFeatureFlag("banner", "red")).toBe("blue");
    expect(client.isFeatureEnabled("hidden", true)).toBe(false);

    const queued = JSON.parse(storage.get("cohorly_queue") ?? "[]") as {
      event: string;
    }[];
    const fired = queued.filter((e) => e.event === "$feature_flag_called");
    // Exactly two exposures, both reads of known flags (banner + hidden);
    // every read that resolved to the fallback emitted nothing.
    expect(fired).toHaveLength(2);
  });

  it("getFeatureFlagDetails reports the value, payload and source", async () => {
    const { client } = makeFlagClient();
    // Unknown before load: fallback source, caller's fallback as value.
    expect(client.getFeatureFlagDetails("nope", "control")).toEqual({
      key: "nope",
      value: "control",
      enabled: true,
      payload: null,
      source: "fallback",
    });

    await client.reloadFeatureFlags();
    expect(client.getFeatureFlagDetails("banner")).toEqual({
      key: "banner",
      value: "blue",
      enabled: true,
      payload: { color: "#00f" },
      source: "network",
    });
    // Still fallback after load for a key the evaluation did not return.
    expect(client.getFeatureFlagDetails("nope").source).toBe("fallback");
  });
});

describe("feature flag persistence", () => {
  const flagsResponse = {
    flags: {
      checkout: { enabled: true, variant: null, payload: null, reason: "rule:0" },
      banner: {
        enabled: true,
        variant: "blue",
        payload: { color: "#00f" },
        reason: "rule:0",
      },
    },
  };

  function makeFlagClient(overrides?: {
    storage?: CohorlyStorage;
    respond?: (body: unknown) => unknown;
    options?: {
      flagPersistence?: "networkOnly" | "networkFirst" | "persistenceUntilNetworkSuccess";
      flagCacheTtlMs?: number;
    };
  }) {
    const storage = overrides?.storage ?? makeStorage();
    const fetchCalls: { url: string; body: unknown }[] = [];
    const respond = overrides?.respond ?? (() => flagsResponse);
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport: async () => {},
      flushIntervalMs: 0,
      token: "tok-1",
      fetcher: async (url, body) => {
        fetchCalls.push({ url, body });
        return respond(body);
      },
      ...overrides?.options,
    });
    return { client, storage, fetchCalls };
  }

  function writeCache(
    storage: CohorlyStorage,
    distinctId: string,
    storedAt: number | undefined,
  ) {
    storage.set(
      "chl_flags",
      JSON.stringify({
        distinct_id: distinctId,
        flags: flagsResponse.flags,
        ...(storedAt !== undefined ? { stored_at: storedAt } : {}),
      }),
    );
  }

  const exposures = (storage: CohorlyStorage) =>
    (JSON.parse(storage.get("cohorly_queue") ?? "[]") as {
      event: string;
      properties: Record<string, unknown>;
    }[]).filter((e) => e.event === "$feature_flag_called");

  it("serves a valid persisted cache on startup while offline (default policy)", async () => {
    const storage = makeStorage();
    const { client: c1 } = makeFlagClient({ storage });
    await c1.reloadFeatureFlags();
    const distinctId = c1.getDistinctId();

    // Second launch, network down: the persisted cache answers immediately.
    const { client: c2, fetchCalls } = makeFlagClient({
      storage,
      respond: () => undefined,
    });
    expect(c2.getDistinctId()).toBe(distinctId);
    expect(c2.getFeatureFlag("banner")).toBe("blue");
    const details = c2.getFeatureFlagDetails("banner");
    expect(details.source).toBe("persistence");
    expect(typeof details.persistedAt).toBe("number");
    expect(details.ttlMs).toBe(24 * 60 * 60 * 1000);

    await c2.reloadFeatureFlags(); // fails: cache keeps serving
    expect(fetchCalls).toHaveLength(1);
    expect(c2.getFeatureFlagDetails("banner").source).toBe("persistence");
  });

  it("flips source to network and re-persists after the first successful reload", async () => {
    const storage = makeStorage();
    const { client: c1 } = makeFlagClient({ storage });
    await c1.reloadFeatureFlags();

    const { client: c2 } = makeFlagClient({ storage });
    expect(c2.getFeatureFlagDetails("banner").source).toBe("persistence");

    await c2.reloadFeatureFlags();
    const details = c2.getFeatureFlagDetails("banner");
    expect(details.source).toBe("network");
    expect(details.persistedAt).toBeUndefined();
    expect(details.ttlMs).toBeUndefined();
    // Re-persisted with a fresh stored_at.
    const cached = JSON.parse(storage.get("chl_flags")!);
    expect(cached.distinct_id).toBe(c2.getDistinctId());
    expect(typeof cached.stored_at).toBe("number");
  });

  it("serves a cache past the TTL but within 7 days under persistenceUntilNetworkSuccess, not under networkFirst", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const storedAt = Date.now() - 2 * DAY; // past the 24 h TTL, inside 7 d
    const storage = makeStorage();
    storage.set("cohorly_distinct_id", "user-1");
    storage.set("cohorly_anonymous", "0");
    writeCache(storage, "user-1", storedAt);

    // Default policy trades freshness for offline availability: the stale
    // cache still serves, and its real age stays observable via persistedAt.
    const { client: puns } = makeFlagClient({
      storage,
      respond: () => undefined,
    });
    const details = puns.getFeatureFlagDetails("banner");
    expect(details.source).toBe("persistence");
    expect(details.value).toBe("blue");
    expect(details.persistedAt).toBe(storedAt);
    expect(details.ttlMs).toBe(DAY);

    // networkFirst is strict: the same expired cache is discarded.
    const storage2 = makeStorage();
    storage2.set("cohorly_distinct_id", "user-1");
    storage2.set("cohorly_anonymous", "0");
    writeCache(storage2, "user-1", storedAt);
    const { client: nf } = makeFlagClient({
      storage: storage2,
      respond: () => undefined,
      options: { flagPersistence: "networkFirst" },
    });
    expect(nf.getFeatureFlag("banner")).toBe(false);
    expect(nf.getFeatureFlagDetails("banner").source).toBe("fallback");
    expect(storage2.get("chl_flags")).toBeNull();
  });

  it("normalizes a future stored_at to now so later adoptions age it honestly", async () => {
    // Clock moved backwards after the write: the raw age is negative and
    // would satisfy every bound indefinitely - the stamp is normalized to
    // now on adoption so the entry ages from here instead of staying
    // fresh until real time catches up.
    const storage = makeStorage();
    storage.set("cohorly_distinct_id", "user-1");
    storage.set("cohorly_anonymous", "0");
    writeCache(storage, "user-1", Date.now() + 365 * 24 * 60 * 60 * 1000);

    const { client } = makeFlagClient({
      storage,
      respond: () => undefined,
      options: { flagPersistence: "networkFirst" },
    });
    expect(client.getFeatureFlagDetails("banner").source).toBe("persistence");
    const rewritten = JSON.parse(storage.get("chl_flags") as string) as {
      stored_at?: number;
    };
    expect(rewritten.stored_at).toBeLessThanOrEqual(Date.now());
  });

  it("discards a cache stale beyond the 7-day window under any persistent policy", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const storedAt = Date.now() - 8 * DAY;

    const storage = makeStorage();
    storage.set("cohorly_distinct_id", "user-1");
    storage.set("cohorly_anonymous", "0");
    writeCache(storage, "user-1", storedAt);
    const { client: puns } = makeFlagClient({
      storage,
      respond: () => undefined,
    });
    expect(puns.getFeatureFlagDetails("banner").source).toBe("fallback");
    expect(storage.get("chl_flags")).toBeNull();

    const storage2 = makeStorage();
    storage2.set("cohorly_distinct_id", "user-1");
    storage2.set("cohorly_anonymous", "0");
    writeCache(storage2, "user-1", storedAt);
    const { client: nf } = makeFlagClient({
      storage: storage2,
      respond: () => undefined,
      options: { flagPersistence: "networkFirst" },
    });
    expect(nf.getFeatureFlagDetails("banner").source).toBe("fallback");
    expect(storage2.get("chl_flags")).toBeNull();
  });

  it("serves a legacy cache without stored_at as persistence, under any persistent policy", async () => {
    const storage = makeStorage();
    storage.set("cohorly_distinct_id", "user-1");
    storage.set("cohorly_anonymous", "0");
    writeCache(storage, "user-1", undefined); // pre-TTL format: no stored_at

    const { client } = makeFlagClient({ storage, respond: () => undefined });
    expect(client.getFeatureFlag("banner")).toBe("blue");
    const details = client.getFeatureFlagDetails("banner");
    expect(details.source).toBe("persistence");
    // Unprovable age: persistedAt stays absent; ttlMs is still reported.
    expect(details.persistedAt).toBeUndefined();
    expect("persistedAt" in details).toBe(false);
    expect(details.ttlMs).toBe(24 * 60 * 60 * 1000);

    // The exposure is stamped persistence, without a persisted-at property.
    const fired = exposures(storage);
    expect(fired).toHaveLength(1);
    expect(fired[0].properties.$feature_flag_source).toBe("persistence");
    expect("$feature_flag_persisted_at" in fired[0].properties).toBe(false);
    expect(fired[0].properties.$feature_flag_ttl_ms).toBe(24 * 60 * 60 * 1000);

    // The legacy cache is served, not removed - a successful reload is what
    // rewrites it in the stamped format.
    expect(storage.get("chl_flags")).toBeTruthy();

    // networkFirst serves it too: no stored_at means no provable age.
    const { client: nf } = makeFlagClient({
      storage,
      respond: () => undefined,
      options: { flagPersistence: "networkFirst" },
    });
    expect(nf.getFeatureFlagDetails("banner").source).toBe("persistence");
    expect(nf.getFeatureFlag("banner")).toBe("blue");
  });

  it("rewrites a legacy cache in the stamped format after a successful reload", async () => {
    const storage = makeStorage();
    storage.set("cohorly_distinct_id", "user-1");
    storage.set("cohorly_anonymous", "0");
    writeCache(storage, "user-1", undefined);

    const { client } = makeFlagClient({ storage });
    await client.reloadFeatureFlags();
    const cached = JSON.parse(storage.get("chl_flags")!);
    expect(typeof cached.stored_at).toBe("number");
    expect(client.getFeatureFlagDetails("banner").source).toBe("network");
  });

  it("networkOnly never reads nor writes the persisted cache", async () => {
    const storage = makeStorage();
    storage.set("cohorly_distinct_id", "user-1");
    storage.set("cohorly_anonymous", "0");
    writeCache(storage, "user-1", Date.now());

    const { client } = makeFlagClient({
      storage,
      options: { flagPersistence: "networkOnly" },
    });
    // Existing cache is ignored, not served.
    expect(client.getFeatureFlag("banner")).toBe(false);
    expect(client.getFeatureFlagDetails("banner").source).toBe("fallback");

    await client.reloadFeatureFlags();
    expect(client.getFeatureFlag("banner")).toBe("blue");
    expect(client.getFeatureFlagDetails("banner").source).toBe("network");
    // The persisted entry is the stale pre-existing one, never rewritten.
    const cached = JSON.parse(storage.get("chl_flags")!);
    expect(cached.distinct_id).toBe("user-1");
  });

  it("networkFirst serves the persisted cache until a network success", async () => {
    const storage = makeStorage();
    const { client: c1 } = makeFlagClient({ storage });
    await c1.reloadFeatureFlags();

    let fail = true;
    const { client: c2 } = makeFlagClient({
      storage,
      respond: () => (fail ? undefined : flagsResponse),
      options: { flagPersistence: "networkFirst" },
    });
    // Valid cache served before any network success.
    expect(c2.getFeatureFlagDetails("banner").source).toBe("persistence");
    await c2.reloadFeatureFlags(); // fails
    expect(c2.getFeatureFlagDetails("banner").source).toBe("persistence");

    fail = false;
    await c2.reloadFeatureFlags();
    expect(c2.getFeatureFlagDetails("banner").source).toBe("network");
  });

  it("identify() removes the outgoing identity's persisted cache before reloading", async () => {
    const storage = makeStorage();
    let fail = false;
    const { client } = makeFlagClient({
      storage,
      respond: () => (fail ? undefined : flagsResponse),
    });
    await client.reloadFeatureFlags(); // persists the anon identity's cache
    expect(storage.get("chl_flags")).toBeTruthy();

    // The post-identify reload fails, so the only way to serve anything would
    // be the stale persisted entry - which must be gone.
    fail = true;
    await client.identify("user-42");
    expect(storage.get("chl_flags")).toBeNull();
    expect(client.getFeatureFlag("banner")).toBe(false);
    expect(client.getFeatureFlagDetails("banner").source).toBe("fallback");
  });

  it("identify()/reset() remove the persisted entry even under networkOnly", async () => {
    const storage = makeStorage();
    const { client } = makeFlagClient({
      storage,
      options: { flagPersistence: "networkOnly" },
    });
    // A cache left by a prior persistent-policy session for the outgoing id.
    writeCache(storage, client.getDistinctId(), Date.now());
    await client.identify("user-9");
    expect(storage.get("chl_flags")).toBeNull();

    writeCache(storage, "user-9", Date.now());
    client.reset();
    expect(storage.get("chl_flags")).toBeNull();
  });

  it("identify() clears in-memory flags even under networkOnly", async () => {
    let fail = false;
    const { client } = makeFlagClient({
      respond: () => (fail ? undefined : flagsResponse),
      options: { flagPersistence: "networkOnly" },
    });
    await client.reloadFeatureFlags();
    expect(client.getFeatureFlag("banner")).toBe("blue");

    // The post-identify reload fails, so only a cleared memory state (never
    // the persisted cache, which networkOnly ignores) explains a false read.
    fail = true;
    await client.identify("user-9");
    expect(client.getFeatureFlag("banner")).toBe(false);
    expect(client.getFeatureFlagDetails("banner").source).toBe("fallback");
  });

  it("areFeatureFlagsLoaded() tracks the served set across identity changes", async () => {
    let fail = false;
    const { client } = makeFlagClient({
      respond: () => (fail ? undefined : flagsResponse),
    });
    expect(client.areFeatureFlagsLoaded()).toBe(false);

    await client.reloadFeatureFlags();
    expect(client.areFeatureFlagsLoaded()).toBe(true);

    // Cleared synchronously by the identity switch; back to true once the
    // new identity's evaluation lands (identify() does not await it).
    const switch1 = client.identify("user-9");
    expect(client.areFeatureFlagsLoaded()).toBe(false);
    await switch1;
    await vi.waitFor(() => expect(client.areFeatureFlagsLoaded()).toBe(true));

    fail = true;
    await client.identify("user-10");
    // The reload failed, so the cleared set stays unloaded - subscribers
    // must see "loading", not getter fallbacks.
    await new Promise((r) => setTimeout(r, 10));
    expect(client.areFeatureFlagsLoaded()).toBe(false);
    expect(client.getFeatureFlagDetails("banner").source).toBe("fallback");
  });

  it("marks exposures served from persistence, without duplicating on recovery", async () => {
    const storage = makeStorage();
    const { client: c1 } = makeFlagClient({ storage });
    await c1.reloadFeatureFlags();

    // Restart offline: serve + expose from persistence.
    let fail = true;
    const { client: c2 } = makeFlagClient({
      storage,
      respond: () => (fail ? undefined : flagsResponse),
    });
    c2.getFeatureFlag("banner");
    let fired = exposures(storage);
    expect(fired).toHaveLength(1);
    expect(fired[0].properties.$feature_flag_source).toBe("persistence");
    expect(fired[0].properties.$feature_flag_persisted_at).toEqual(
      expect.any(Number),
    );
    expect(fired[0].properties.$feature_flag_ttl_ms).toBe(24 * 60 * 60 * 1000);

    // Network recovers: same (key, value) does not re-emit; a different value does.
    fail = false;
    await c2.reloadFeatureFlags();
    c2.getFeatureFlag("banner");
    c2.getFeatureFlag("checkout");
    fired = exposures(storage);
    expect(fired).toHaveLength(2);
    expect(fired[1].properties.$feature_flag).toBe("checkout");
    expect(fired[1].properties.$feature_flag_source).toBe("network");
    expect("$feature_flag_persisted_at" in fired[1].properties).toBe(false);
  });
});

describe("feature flag exposure events", () => {
  const flagsResponse = {
    flags: {
      checkout: { enabled: true, variant: null, payload: null, reason: "rule:0" },
      banner: {
        enabled: true,
        variant: "blue",
        payload: { color: "#00f" },
        reason: "rule:0",
      },
    },
  };

  function makeExposureClient(options: { sendExposureEvents?: boolean } = {}) {
    const storage = makeStorage();
    let flags: Record<string, unknown> = flagsResponse.flags;
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport: async () => {},
      flushIntervalMs: 0,
      fetcher: async () => ({ flags }),
      ...options,
    });
    const queued = () => JSON.parse(storage.get("cohorly_queue") ?? "[]");
    const exposures = () =>
      queued().filter(
        (e: { event: string }) => e.event === "$feature_flag_called",
      );
    return {
      client,
      exposures,
      setFlags: (next: Record<string, unknown>) => {
        flags = next;
      },
    };
  }

  it("fires once per flag despite repeated reads, with key + response", async () => {
    const { client, exposures } = makeExposureClient();
    await client.reloadFeatureFlags();

    client.getFeatureFlag("banner");
    client.getFeatureFlag("banner");
    client.isFeatureEnabled("banner");
    client.isFeatureEnabled("checkout");
    client.getFeatureFlag("checkout");

    const fired = exposures();
    expect(fired).toHaveLength(2);
    expect(fired[0].properties.$feature_flag).toBe("banner");
    expect(fired[0].properties.$feature_flag_response).toBe("blue");
    expect(fired[1].properties.$feature_flag).toBe("checkout");
    expect(fired[1].properties.$feature_flag_response).toBe(true);
  });

  it("refires when the flag's value changes", async () => {
    const { client, exposures, setFlags } = makeExposureClient();
    await client.reloadFeatureFlags();
    client.getFeatureFlag("banner");
    expect(exposures()).toHaveLength(1);

    setFlags({
      banner: { enabled: true, variant: "red", payload: null, reason: "rule:1" },
    });
    await client.reloadFeatureFlags();
    client.getFeatureFlag("banner");

    const fired = exposures();
    expect(fired).toHaveLength(2);
    expect(fired[1].properties.$feature_flag_response).toBe("red");
  });

  it("clears the dedup set on identify() and reset()", async () => {
    const { client, exposures } = makeExposureClient();
    await client.reloadFeatureFlags();
    client.getFeatureFlag("checkout");
    expect(exposures()).toHaveLength(1);

    await client.identify("user-9");
    await client.reloadFeatureFlags();
    client.getFeatureFlag("checkout");
    expect(exposures()).toHaveLength(2);

    client.reset();
    await client.reloadFeatureFlags();
    client.getFeatureFlag("checkout");
    expect(exposures()).toHaveLength(3);
  });

  it("sends nothing for payload reads, unknown keys, or before flags load", async () => {
    const { client, exposures } = makeExposureClient();
    client.getFeatureFlag("checkout"); // not loaded yet
    expect(exposures()).toHaveLength(0);

    await client.reloadFeatureFlags();
    client.getFeatureFlagPayload("banner");
    client.getFeatureFlag("nope");
    client.isFeatureEnabled("nope");
    expect(exposures()).toHaveLength(0);
  });

  it("sendExposureEvents: false silences exposures", async () => {
    const { client, exposures } = makeExposureClient({ sendExposureEvents: false });
    await client.reloadFeatureFlags();
    client.getFeatureFlag("banner");
    client.isFeatureEnabled("checkout");
    expect(exposures()).toHaveLength(0);
  });
});
