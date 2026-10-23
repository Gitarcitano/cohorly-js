import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cohorly, init } from "../src/index.js";

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

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function flagCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith("/flags/evaluate"),
  );
}

describe("web feature flags", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock = vi.fn(async () => jsonResponse(flagsResponse));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("init() loads flags by default and the singleton delegates to the client", async () => {
    init({ apiHost: "http://localhost:4000", token: "tok-w" });

    await vi.waitFor(() => expect(flagCalls(fetchMock)).toHaveLength(1));
    const [url, req] = flagCalls(fetchMock)[0];
    expect(url).toBe("http://localhost:4000/flags/evaluate");
    expect(JSON.parse(req.body)).toEqual({
      distinct_id: cohorly.getDistinctId(),
      token: "tok-w",
    });

    await vi.waitFor(() => expect(cohorly.isFeatureEnabled("checkout")).toBe(true));
    expect(cohorly.getFeatureFlag("banner")).toBe("blue");
    expect(cohorly.getFeatureFlagPayload("banner")).toEqual({ color: "#00f" });
    expect(cohorly.getFeatureFlag("nope")).toBe(false);
  });

  it("loadFeatureFlags: false skips the initial reload; manual reload still works", async () => {
    init({
      apiHost: "http://localhost:4000",
      token: "tok-w",
      loadFeatureFlags: false,
    });
    // Give any stray fire-and-forget a tick to land.
    await new Promise((r) => setTimeout(r, 10));
    expect(flagCalls(fetchMock)).toHaveLength(0);

    await cohorly.reloadFeatureFlags();
    expect(flagCalls(fetchMock)).toHaveLength(1);
    expect(cohorly.isFeatureEnabled("checkout")).toBe(true);
  });

  it("onFeatureFlags subscription delegates and fires on reload", async () => {
    init({
      apiHost: "http://localhost:4000",
      token: "tok-w",
      loadFeatureFlags: false,
    });
    const seen: unknown[] = [];
    const unsubscribe = cohorly.onFeatureFlags((flags) => {
      seen.push(flags);
    });
    await cohorly.reloadFeatureFlags();
    expect(seen).toHaveLength(1);
    unsubscribe();
    await cohorly.reloadFeatureFlags();
    expect(seen).toHaveLength(1);
  });

  /** Queued `$feature_flag_called` events, read from the persisted queue. */
  function exposures() {
    const raw = window.localStorage.getItem("cohorly_queue") ?? "[]";
    return (JSON.parse(raw) as { event: string; properties: Record<string, unknown> }[])
      .filter((e) => e.event === "$feature_flag_called");
  }

  it("tracks one exposure per flag value, and none for payload/unknown reads", async () => {
    init({
      apiHost: "http://localhost:4000",
      token: "tok-w",
      loadFeatureFlags: false,
    });
    cohorly.getFeatureFlag("banner"); // not loaded yet: no exposure
    await cohorly.reloadFeatureFlags();

    cohorly.getFeatureFlag("banner");
    cohorly.isFeatureEnabled("banner");
    cohorly.getFeatureFlagPayload("banner");
    cohorly.getFeatureFlag("nope");

    const fired = exposures();
    expect(fired).toHaveLength(1);
    expect(fired[0].properties.$feature_flag).toBe("banner");
    expect(fired[0].properties.$feature_flag_response).toBe("blue");
  });

  it("sendExposureEvents: false silences exposures", async () => {
    init({
      apiHost: "http://localhost:4000",
      token: "tok-w",
      loadFeatureFlags: false,
      sendExposureEvents: false,
    });
    await cohorly.reloadFeatureFlags();
    cohorly.getFeatureFlag("banner");
    cohorly.isFeatureEnabled("checkout");
    expect(exposures()).toHaveLength(0);
  });

  it("getFeatureFlagDetails reports the source, and fallback reads emit none", async () => {
    init({
      apiHost: "http://localhost:4000",
      token: "tok-w",
      loadFeatureFlags: false,
    });
    expect(cohorly.getFeatureFlagDetails("nope", "control").source).toBe(
      "fallback",
    );

    await cohorly.reloadFeatureFlags();
    expect(cohorly.getFeatureFlagDetails("banner")).toEqual({
      key: "banner",
      value: "blue",
      enabled: true,
      payload: { color: "#00f" },
      source: "network",
    });
    cohorly.getFeatureFlag("nope", "control");
    // Only the details read of the known flag exposed; fallback emitted none.
    expect(exposures()).toHaveLength(1);
  });

  it("serves the persisted cache across init() and flagPersistence passes through", async () => {
    init({
      apiHost: "http://localhost:4000",
      token: "tok-w",
      loadFeatureFlags: false,
    });
    await cohorly.reloadFeatureFlags();
    const distinctId = cohorly.getDistinctId();
    expect(JSON.parse(window.localStorage.getItem("chl_flags")!).stored_at).toEqual(
      expect.any(Number),
    );

    // Second init, network down: the persisted cache serves with
    // source "persistence" - the option defaults reach the core client.
    fetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    init({
      apiHost: "http://localhost:4000",
      token: "tok-w",
      loadFeatureFlags: false,
    });
    expect(cohorly.getDistinctId()).toBe(distinctId);
    const details = cohorly.getFeatureFlagDetails("banner");
    expect(details.source).toBe("persistence");
    expect(details.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(typeof details.persistedAt).toBe("number");

    // networkOnly: the same cache is ignored, never served.
    init({
      apiHost: "http://localhost:4000",
      token: "tok-w",
      loadFeatureFlags: false,
      flagPersistence: "networkOnly",
    });
    expect(cohorly.getFeatureFlagDetails("banner").source).toBe("fallback");
    await cohorly.reloadFeatureFlags(); // fetch still throws: no recovery
    expect(cohorly.getFeatureFlag("banner")).toBe(false);
  });
});
