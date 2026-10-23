import { describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "../src/client.js";
import type { FlagResult } from "../src/types.js";
import { type FakeRequest, FakeStorage, requestsTo } from "./helpers.js";

const FLAGS = {
  checkout: { enabled: true, variant: null, payload: null, reason: "rule:0" },
  banner: {
    enabled: true,
    variant: "blue",
    payload: { color: "#00f" },
    reason: "rule:0",
  },
};

/** Fake fetch that answers /flags/evaluate with `flags`, everything else 200. */
function createFlagsFetch(flags: unknown = FLAGS, status = 200) {
  const requests: FakeRequest[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ path, body });
    if (path === "/flags/evaluate") {
      return new Response(JSON.stringify({ flags }), { status });
    }
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

function makeClient(
  fetchImpl: typeof fetch,
  storage: FakeStorage,
  options: Record<string, unknown> = {},
) {
  return new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "tok-rn",
    storage,
    fetch: fetchImpl,
    ...options,
  });
}

describe("react-native feature flags", () => {
  it("evaluates flags on init and exposes the results", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const client = makeClient(fetchImpl, new FakeStorage());
    await client.ready;
    await vi.waitFor(() =>
      expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(1),
    );
    client.stop();

    expect(requestsTo(requests, "/flags/evaluate")[0].body).toEqual({
      distinct_id: client.getDistinctId(),
      token: "tok-rn",
    });
    await vi.waitFor(() => expect(client.isFeatureEnabled("checkout")).toBe(true));
    expect(client.getFeatureFlag("banner")).toBe("blue");
    expect(client.getFeatureFlagPayload("banner")).toEqual({ color: "#00f" });
    expect(client.getFeatureFlag("nope")).toBe(false);
    expect(client.isFeatureEnabled("nope")).toBe(false);
    expect(client.getFeatureFlagPayload("nope")).toBeNull();
  });

  it("loadFeatureFlags: false skips the initial evaluation; manual reload still works", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const client = makeClient(fetchImpl, new FakeStorage(), {
      loadFeatureFlags: false,
    });
    await client.ready;
    await new Promise((r) => setTimeout(r, 10));
    expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(0);

    await client.reloadFeatureFlags();
    client.stop();
    expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(1);
    expect(client.isFeatureEnabled("checkout")).toBe(true);
  });

  it("persists the cache scoped by distinct id and rehydrates it on the next launch", async () => {
    const storage = new FakeStorage();
    const first = makeClient(createFlagsFetch().fetchImpl, storage);
    await first.ready;
    await vi.waitFor(() => expect(first.isFeatureEnabled("checkout")).toBe(true));
    first.stop();

    const cached = JSON.parse(storage.store.get("cohorly:flags") as string);
    expect(cached.distinct_id).toBe(first.getDistinctId());

    // Fresh client, same storage, flag endpoint now unreachable: the persisted
    // cache is served immediately.
    const second = makeClient(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage,
    );
    await second.ready;
    second.stop();
    expect(second.isFeatureEnabled("checkout")).toBe(true);
    expect(second.getFeatureFlag("banner")).toBe("blue");
  });

  it("drops a cache belonging to a different distinct id", async () => {
    const storage = new FakeStorage();
    await storage.setItem("cohorly:distinct_id", "user-a");
    await storage.setItem("cohorly:anonymous", "0");
    await storage.setItem(
      "cohorly:flags",
      JSON.stringify({ distinct_id: "someone-else", flags: FLAGS }),
    );

    const client = makeClient(createFlagsFetch({}).fetchImpl, storage, {
      loadFeatureFlags: false,
    });
    await client.ready;
    client.stop();
    expect(client.isFeatureEnabled("checkout")).toBe(false);
    expect(storage.store.has("cohorly:flags")).toBe(false);
  });

  it("re-evaluates on identify() and clears + re-evaluates on reset()", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;

    client.identify("user-1");
    await vi.waitFor(() =>
      expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(1),
    );
    expect(requestsTo(requests, "/flags/evaluate")[0].body).toMatchObject({
      distinct_id: "user-1",
    });
    await vi.waitFor(() => expect(client.isFeatureEnabled("checkout")).toBe(true));

    client.reset();
    // Cleared synchronously, before the refresh lands.
    expect(client.isFeatureEnabled("checkout")).toBe(false);
    await vi.waitFor(() =>
      expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(2),
    );
    client.stop();
    expect(requestsTo(requests, "/flags/evaluate")[1].body).toMatchObject({
      distinct_id: client.getDistinctId(),
    });
  });

  it("keeps the stale cache when a reload fails, and never rejects", async () => {
    const storage = new FakeStorage();
    const client = makeClient(createFlagsFetch().fetchImpl, storage, {
      loadFeatureFlags: false,
    });
    await client.ready;
    await client.reloadFeatureFlags();
    expect(client.isFeatureEnabled("checkout")).toBe(true);

    // Non-2xx, then a network throw, then a malformed body: all swallowed.
    const failing = makeClient(createFlagsFetch(FLAGS, 429).fetchImpl, storage);
    await failing.ready;
    await expect(failing.reloadFeatureFlags()).resolves.toBeUndefined();
    failing.stop();

    const throwing = makeClient(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage,
    );
    await throwing.ready;
    await expect(throwing.reloadFeatureFlags()).resolves.toBeUndefined();
    throwing.stop();
    // The cache written by the successful reload is still served.
    expect(throwing.isFeatureEnabled("checkout")).toBe(true);

    const malformed = makeClient(createFlagsFetch("not-an-object").fetchImpl, storage);
    await malformed.ready;
    await expect(malformed.reloadFeatureFlags()).resolves.toBeUndefined();
    malformed.stop();
    expect(malformed.isFeatureEnabled("checkout")).toBe(true);

    client.stop();
  });

  it("onFeatureFlags fires on reload, immediately when loaded, and unsubscribes", async () => {
    const { fetchImpl } = createFlagsFetch();
    const client = makeClient(fetchImpl, new FakeStorage(), {
      loadFeatureFlags: false,
    });
    await client.ready;

    const seen: Record<string, FlagResult>[] = [];
    const unsubscribe = client.onFeatureFlags((flags) => seen.push(flags));
    expect(seen).toHaveLength(0); // nothing loaded yet

    await client.reloadFeatureFlags();
    expect(seen).toHaveLength(1);
    expect(seen[0].banner.variant).toBe("blue");

    // Already loaded: a late subscriber fires immediately.
    let late = 0;
    const unsubscribeLate = client.onFeatureFlags(() => {
      late += 1;
    });
    expect(late).toBe(1);
    unsubscribeLate();

    unsubscribe();
    await client.reloadFeatureFlags();
    client.stop();
    expect(seen).toHaveLength(1);
  });

  /** The `$feature_flag_called` events queued so far, in order. */
  function exposures(requests: FakeRequest[], storage: FakeStorage) {
    const queued = JSON.parse(storage.store.get("cohorly:queue") ?? "[]") as {
      event: string;
      properties: Record<string, unknown>;
    }[];
    const sent = requestsTo(requests, "/track").flatMap(
      (r) => (r.body as { event: string; properties: Record<string, unknown> }[]) ?? [],
    );
    return [...sent, ...queued].filter((e) => e.event === "$feature_flag_called");
  }

  it("tracks one exposure per flag value, refiring when the value changes", async () => {
    let flags: unknown = FLAGS;
    const requests: FakeRequest[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ path, body });
      if (path === "/flags/evaluate") {
        return new Response(JSON.stringify({ flags }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;

    client.getFeatureFlag("banner"); // not loaded yet: no exposure
    await client.reloadFeatureFlags();

    client.getFeatureFlag("banner");
    client.getFeatureFlag("banner");
    client.isFeatureEnabled("banner");
    client.getFeatureFlagPayload("banner"); // payload reads never expose
    client.getFeatureFlag("nope"); // unknown key never exposes
    expect(exposures(requests, storage)).toHaveLength(1);
    expect(exposures(requests, storage)[0].properties).toMatchObject({
      $feature_flag: "banner",
      $feature_flag_response: "blue",
    });

    flags = {
      banner: { enabled: true, variant: "red", payload: null, reason: "rule:1" },
    };
    await client.reloadFeatureFlags();
    client.getFeatureFlag("banner");
    client.stop();

    const fired = exposures(requests, storage);
    expect(fired).toHaveLength(2);
    expect(fired[1].properties.$feature_flag_response).toBe("red");
  });

  it("clears the exposure dedup on identify() and reset()", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;
    await client.reloadFeatureFlags();
    client.isFeatureEnabled("checkout");
    // Flushed after each read so reset()'s queue clear cannot hide an exposure.
    await client.flush();
    expect(exposures(requests, storage)).toHaveLength(1);

    client.identify("user-1");
    await client.reloadFeatureFlags();
    client.isFeatureEnabled("checkout");
    await client.flush();
    expect(exposures(requests, storage)).toHaveLength(2);

    client.reset();
    await client.reloadFeatureFlags();
    client.isFeatureEnabled("checkout");
    await client.flush();
    client.stop();
    expect(exposures(requests, storage)).toHaveLength(3);
  });

  it("sendExposureEvents: false silences exposures", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, {
      loadFeatureFlags: false,
      sendExposureEvents: false,
    });
    await client.ready;
    await client.reloadFeatureFlags();
    client.getFeatureFlag("banner");
    client.isFeatureEnabled("checkout");
    client.stop();
    expect(exposures(requests, storage)).toHaveLength(0);
  });

  it("makes no flag request when disabled", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const client = makeClient(fetchImpl, new FakeStorage(), { disabled: true });
    await client.ready;
    await client.reloadFeatureFlags();
    client.stop();
    expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(0);
  });
});

describe("react-native flag persistence", () => {
  const TTL_MS = 24 * 60 * 60 * 1000;

  function writeCache(
    storage: FakeStorage,
    distinctId: string,
    storedAt: number | undefined,
  ) {
    return storage.setItem(
      "cohorly:flags",
      JSON.stringify({
        distinct_id: distinctId,
        flags: FLAGS,
        ...(storedAt !== undefined ? { stored_at: storedAt } : {}),
      }),
    );
  }

  function exposures(requests: FakeRequest[], storage: FakeStorage) {
    const queued = JSON.parse(storage.store.get("cohorly:queue") ?? "[]") as {
      event: string;
      properties: Record<string, unknown>;
    }[];
    const sent = requestsTo(requests, "/track").flatMap(
      (r) => (r.body as { event: string; properties: Record<string, unknown> }[]) ?? [],
    );
    return [...sent, ...queued].filter((e) => e.event === "$feature_flag_called");
  }

  it("serves a valid persisted cache offline and reports source persistence", async () => {
    const storage = new FakeStorage();
    const first = makeClient(createFlagsFetch().fetchImpl, storage);
    await first.ready;
    await vi.waitFor(() => expect(first.isFeatureEnabled("checkout")).toBe(true));
    first.stop();

    // Relaunch with the network down: the persisted cache answers.
    const second = makeClient(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage,
    );
    await second.ready;
    second.stop();

    const details = second.getFeatureFlagDetails("banner");
    expect(details).toMatchObject({
      key: "banner",
      value: "blue",
      enabled: true,
      source: "persistence",
      ttlMs: TTL_MS,
    });
    expect(typeof details.persistedAt).toBe("number");
  });

  it("flips source to network and re-persists after the first successful reload", async () => {
    const storage = new FakeStorage();
    const first = makeClient(createFlagsFetch().fetchImpl, storage);
    await first.ready;
    await vi.waitFor(() => expect(first.isFeatureEnabled("checkout")).toBe(true));
    first.stop();

    const second = makeClient(createFlagsFetch().fetchImpl, storage, {
      loadFeatureFlags: false,
    });
    await second.ready;
    expect(second.getFeatureFlagDetails("banner").source).toBe("persistence");

    await second.reloadFeatureFlags();
    second.stop();
    const details = second.getFeatureFlagDetails("banner");
    expect(details.source).toBe("network");
    expect(details.persistedAt).toBeUndefined();
    expect(details.ttlMs).toBeUndefined();
    expect(JSON.parse(storage.store.get("cohorly:flags") as string).stored_at).toEqual(
      expect.any(Number),
    );
  });

  it("serves a cache past the TTL but within 7 days under persistenceUntilNetworkSuccess, not under networkFirst", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const storedAt = Date.now() - 2 * DAY; // past the 24 h TTL, inside 7 d

    // Default policy trades freshness for offline availability: the stale
    // cache still serves, and its real age stays observable via persistedAt.
    const storage = new FakeStorage();
    await storage.setItem("cohorly:distinct_id", "user-1");
    await storage.setItem("cohorly:anonymous", "0");
    await writeCache(storage, "user-1", storedAt);
    const puns = makeClient(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage,
      { loadFeatureFlags: false },
    );
    await puns.ready;
    puns.stop();
    const details = puns.getFeatureFlagDetails("banner");
    expect(details.source).toBe("persistence");
    expect(details.value).toBe("blue");
    expect(details.persistedAt).toBe(storedAt);
    expect(details.ttlMs).toBe(DAY);

    // networkFirst is strict: the same expired cache is discarded.
    const storage2 = new FakeStorage();
    await storage2.setItem("cohorly:distinct_id", "user-1");
    await storage2.setItem("cohorly:anonymous", "0");
    await writeCache(storage2, "user-1", storedAt);
    const nf = makeClient(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage2,
      { loadFeatureFlags: false, flagPersistence: "networkFirst" },
    );
    await nf.ready;
    nf.stop();
    expect(nf.getFeatureFlag("banner")).toBe(false);
    expect(nf.getFeatureFlagDetails("banner").source).toBe("fallback");
    expect(storage2.store.has("cohorly:flags")).toBe(false);
  });

  it("discards a cache stale beyond the 7-day window under any persistent policy", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const storedAt = Date.now() - 8 * DAY;
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const storage = new FakeStorage();
    await storage.setItem("cohorly:distinct_id", "user-1");
    await storage.setItem("cohorly:anonymous", "0");
    await writeCache(storage, "user-1", storedAt);
    const puns = makeClient(offline, storage, { loadFeatureFlags: false });
    await puns.ready;
    puns.stop();
    expect(puns.getFeatureFlagDetails("banner").source).toBe("fallback");
    expect(storage.store.has("cohorly:flags")).toBe(false);

    const storage2 = new FakeStorage();
    await storage2.setItem("cohorly:distinct_id", "user-1");
    await storage2.setItem("cohorly:anonymous", "0");
    await writeCache(storage2, "user-1", storedAt);
    const nf = makeClient(offline, storage2, {
      loadFeatureFlags: false,
      flagPersistence: "networkFirst",
    });
    await nf.ready;
    nf.stop();
    expect(nf.getFeatureFlagDetails("banner").source).toBe("fallback");
    expect(storage2.store.has("cohorly:flags")).toBe(false);
  });

  it("serves a legacy cache without stored_at as persistence, under any persistent policy", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const storage = new FakeStorage();
    await storage.setItem("cohorly:distinct_id", "user-1");
    await storage.setItem("cohorly:anonymous", "0");
    await writeCache(storage, "user-1", undefined); // pre-TTL format

    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;
    expect(client.getFeatureFlag("banner")).toBe("blue");
    const details = client.getFeatureFlagDetails("banner");
    expect(details.source).toBe("persistence");
    // Unprovable age: persistedAt stays absent; ttlMs is still reported.
    expect(details.persistedAt).toBeUndefined();
    expect("persistedAt" in details).toBe(false);
    expect(details.ttlMs).toBe(TTL_MS);

    // The exposure is stamped persistence, without a persisted-at property.
    const fired = exposures(requests, storage);
    expect(fired).toHaveLength(1);
    expect(fired[0].properties.$feature_flag_source).toBe("persistence");
    expect("$feature_flag_persisted_at" in fired[0].properties).toBe(false);
    expect(fired[0].properties.$feature_flag_ttl_ms).toBe(TTL_MS);

    // The legacy cache is served, not removed - a successful reload is what
    // rewrites it in the stamped format.
    expect(storage.store.has("cohorly:flags")).toBe(true);
    client.stop();

    // networkFirst serves it too: no stored_at means no provable age.
    const nf = makeClient(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      storage,
      { loadFeatureFlags: false, flagPersistence: "networkFirst" },
    );
    await nf.ready;
    nf.stop();
    expect(nf.getFeatureFlagDetails("banner").source).toBe("persistence");
    expect(nf.getFeatureFlag("banner")).toBe("blue");
  });

  it("rewrites a legacy cache in the stamped format after a successful reload", async () => {
    const storage = new FakeStorage();
    await storage.setItem("cohorly:distinct_id", "user-1");
    await storage.setItem("cohorly:anonymous", "0");
    await writeCache(storage, "user-1", undefined);

    const client = makeClient(createFlagsFetch().fetchImpl, storage, {
      loadFeatureFlags: false,
    });
    await client.ready;
    await client.reloadFeatureFlags();
    client.stop();
    const cached = JSON.parse(storage.store.get("cohorly:flags") as string);
    expect(typeof cached.stored_at).toBe("number");
    expect(client.getFeatureFlagDetails("banner").source).toBe("network");
  });

  it("networkOnly never reads nor writes the persisted cache", async () => {
    const storage = new FakeStorage();
    await storage.setItem("cohorly:distinct_id", "user-1");
    await storage.setItem("cohorly:anonymous", "0");
    await writeCache(storage, "user-1", Date.now());

    const client = makeClient(createFlagsFetch().fetchImpl, storage, {
      loadFeatureFlags: false,
      flagPersistence: "networkOnly",
    });
    await client.ready;
    // The pre-existing cache is ignored, not served.
    expect(client.getFeatureFlag("banner")).toBe(false);
    expect(client.getFeatureFlagDetails("banner").source).toBe("fallback");

    await client.reloadFeatureFlags();
    client.stop();
    expect(client.getFeatureFlag("banner")).toBe("blue");
    expect(client.getFeatureFlagDetails("banner").source).toBe("network");
    // The persisted entry is the stale pre-existing one, never rewritten.
    expect(JSON.parse(storage.store.get("cohorly:flags") as string).flags).toEqual(FLAGS);
  });

  it("networkFirst serves the persisted cache until a network success", async () => {
    const storage = new FakeStorage();
    const first = makeClient(createFlagsFetch().fetchImpl, storage);
    await first.ready;
    await vi.waitFor(() => expect(first.isFeatureEnabled("checkout")).toBe(true));
    first.stop();

    let offline = true;
    const fetchImpl = (async (url: string, _init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/flags/evaluate") {
        if (offline) throw new Error("offline");
        return new Response(JSON.stringify({ flags: FLAGS }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const second = makeClient(fetchImpl, storage, {
      loadFeatureFlags: false,
      flagPersistence: "networkFirst",
    });
    await second.ready;
    expect(second.getFeatureFlagDetails("banner").source).toBe("persistence");
    await second.reloadFeatureFlags(); // fails
    expect(second.getFeatureFlagDetails("banner").source).toBe("persistence");

    offline = false;
    await second.reloadFeatureFlags();
    second.stop();
    expect(second.getFeatureFlagDetails("banner").source).toBe("network");
  });

  it("identify() removes the outgoing identity's persisted cache before reloading", async () => {
    const storage = new FakeStorage();
    const requests: FakeRequest[] = [];
    let offline = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ path, body });
      if (path === "/flags/evaluate") {
        if (offline) throw new Error("offline");
        return new Response(JSON.stringify({ flags: FLAGS }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;
    await client.reloadFeatureFlags(); // persists the anon identity's cache
    await vi.waitFor(() => expect(storage.store.has("cohorly:flags")).toBe(true));

    // The post-identify reload fails, so the only way to serve anything would
    // be the stale persisted entry - which must be gone.
    offline = true;
    client.identify("user-42");
    await vi.waitFor(() =>
      expect(requestsTo(requests, "/flags/evaluate")).toHaveLength(2),
    );
    client.stop();
    expect(client.getFeatureFlag("banner")).toBe(false);
    expect(client.getFeatureFlagDetails("banner").source).toBe("fallback");
    expect(storage.store.has("cohorly:flags")).toBe(false);
  });

  it("identify()/reset() remove the persisted entry even under networkOnly", async () => {
    const storage = new FakeStorage();
    const client = makeClient(createFlagsFetch().fetchImpl, storage, {
      loadFeatureFlags: false,
      flagPersistence: "networkOnly",
    });
    await client.ready;
    // A cache left by a prior persistent-policy session for the outgoing id.
    await writeCache(storage, client.getDistinctId(), Date.now());
    client.identify("user-9");
    await vi.waitFor(() => expect(storage.store.has("cohorly:flags")).toBe(false));

    await writeCache(storage, "user-9", Date.now());
    client.reset();
    await vi.waitFor(() => expect(storage.store.has("cohorly:flags")).toBe(false));
    client.stop();
  });

  it("identify() clears in-memory flags even under networkOnly", async () => {
    const requests: FakeRequest[] = [];
    let offline = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ path, body });
      if (path === "/flags/evaluate") {
        if (offline) throw new Error("offline");
        return new Response(JSON.stringify({ flags: FLAGS }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl, new FakeStorage(), {
      loadFeatureFlags: false,
      flagPersistence: "networkOnly",
    });
    await client.ready;
    await client.reloadFeatureFlags();
    expect(client.getFeatureFlag("banner")).toBe("blue");

    // The post-identify reload fails, so only a cleared memory state (never
    // the persisted cache, which networkOnly ignores) explains a false read.
    offline = true;
    client.identify("user-9");
    client.stop();
    expect(client.getFeatureFlag("banner")).toBe(false);
    expect(client.getFeatureFlagDetails("banner").source).toBe("fallback");
  });

  it("fallback getters resolve unknown keys without emitting an exposure", async () => {
    const { fetchImpl, requests } = createFlagsFetch();
    const storage = new FakeStorage();
    const client = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await client.ready;

    expect(client.getFeatureFlag("nope", "control")).toBe("control");
    expect(client.isFeatureEnabled("nope", true)).toBe(true);
    expect(client.getFeatureFlagDetails("nope", "control")).toEqual({
      key: "nope",
      value: "control",
      enabled: true,
      payload: null,
      source: "fallback",
    });

    await client.reloadFeatureFlags();
    client.getFeatureFlag("banner", "red");
    client.stop();
    const fired = exposures(requests, storage);
    // Only the known-flag read exposed; every fallback read emitted nothing.
    expect(fired).toHaveLength(1);
    expect(fired[0].properties.$feature_flag).toBe("banner");
  });

  it("marks exposures served from persistence, without duplicating on recovery", async () => {
    const storage = new FakeStorage();
    const first = makeClient(createFlagsFetch().fetchImpl, storage);
    await first.ready;
    await vi.waitFor(() => expect(first.isFeatureEnabled("checkout")).toBe(true));
    // Drain the queue so first's own exposure is not still sitting in the
    // shared persisted queue when the relaunched client hydrates it.
    await first.flush();
    first.stop();

    // Relaunch offline: serve + expose from persistence.
    const requests: FakeRequest[] = [];
    let offline = true;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ path, body });
      if (path === "/flags/evaluate") {
        if (offline) throw new Error("offline");
        return new Response(JSON.stringify({ flags: FLAGS }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const second = makeClient(fetchImpl, storage, { loadFeatureFlags: false });
    await second.ready;
    second.getFeatureFlag("banner");
    let fired = exposures(requests, storage);
    expect(fired).toHaveLength(1);
    expect(fired[0].properties.$feature_flag_source).toBe("persistence");
    expect(fired[0].properties.$feature_flag_persisted_at).toEqual(expect.any(Number));
    expect(fired[0].properties.$feature_flag_ttl_ms).toBe(TTL_MS);

    // Network recovers: same (key, value) does not re-emit; a different
    // key does, marked as network-sourced.
    offline = false;
    await second.reloadFeatureFlags();
    second.getFeatureFlag("banner");
    second.getFeatureFlag("checkout");
    second.stop();
    fired = exposures(requests, storage);
    expect(fired).toHaveLength(2);
    expect(fired[1].properties.$feature_flag).toBe("checkout");
    expect(fired[1].properties.$feature_flag_source).toBe("network");
    expect("$feature_flag_persisted_at" in fired[1].properties).toBe(false);
  });

  it("drops a network result evaluated for the transient id and adopts the real identity's cache", async () => {
    // Hydration reads AsyncStorage asynchronously; a caller may fire
    // reloadFeatureFlags() before `ready` resolves. That request is
    // evaluated for the transient constructor uuid, not the persisted
    // identity - its result must be discarded when the real distinct id
    // resolves, and the persisted cache belonging to that identity adopted
    // instead.
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
    await storage.setItem("cohorly:distinct_id", "user-1");
    await storage.setItem("cohorly:anonymous", "0");
    await storage.setItem(
      "cohorly:flags",
      JSON.stringify({
        distinct_id: "user-1",
        flags: { banner: { enabled: true, variant: "red", payload: null } },
        stored_at: Date.now(),
      }),
    );

    const { fetchImpl, requests } = createFlagsFetch();
    const client = makeClient(fetchImpl, storage, {
      loadFeatureFlags: false,
    });
    await client.reloadFeatureFlags(); // lands while hydrate() is gated
    release();
    await client.ready;
    client.stop();
    // The pre-ready request carried the transient constructor id, so its
    // result never belongs to user-1.
    expect(requestsTo(requests, "/flags/evaluate")[0].body.distinct_id).not.toBe(
      "user-1",
    );
    expect(client.getFeatureFlag("banner")).toBe("red");
    expect(client.getFeatureFlagDetails("banner").source).toBe("persistence");
  });
});
