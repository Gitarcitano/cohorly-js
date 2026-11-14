import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CohorlyWebOptions, TrackedEvent } from "../src/index.js";
import { cohorly, init } from "../src/index.js";

/** Blob stand-in that keeps what was passed in, so the beacon body can be read back. */
class RecordingBlob {
  constructor(readonly parts: string[]) {}
}

const flag = (enabled: boolean) => ({ enabled, variant: null, payload: null, reason: "test" });

function setup(flags: Record<string, unknown> | null = null) {
  window.localStorage.clear();
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (flags && String(url).endsWith("/flags/evaluate")) {
      return new Response(JSON.stringify({ flags }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Blob", RecordingBlob);
  const sendBeacon = vi.fn((_url: string, _body: RecordingBlob) => true);
  Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
  return { sendBeacon, fetchMock };
}

async function initWeb(extra: Partial<CohorlyWebOptions> = {}, flagsLoaded = false) {
  init({
    apiHost: "http://localhost:4000",
    token: "tok-web",
    loadFeatureFlags: flagsLoaded,
    flushIntervalMs: 0,
    ...extra,
  });
  if (flagsLoaded) await vi.waitFor(() => expect(cohorly.areFeatureFlagsLoaded()).toBe(true));
}

function beaconEvents(sendBeacon: ReturnType<typeof vi.fn>): TrackedEvent[] {
  return sendBeacon.mock.calls.flatMap(
    ([, blob]) => JSON.parse((blob as RecordingBlob).parts[0]) as TrackedEvent[],
  );
}

function metricEvents(sendBeacon: ReturnType<typeof vi.fn>): TrackedEvent[] {
  return beaconEvents(sendBeacon).filter((e) => e.event === "$metric");
}

function trackBodies(fetchMock: ReturnType<typeof vi.fn>): TrackedEvent[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/track"))
    .flatMap(([, reqInit]) => JSON.parse((reqInit as RequestInit).body as string) as TrackedEvent[]);
}

/**
 * Fires pagehide after a probe event and waits until the beacon carried the
 * probe, so "no $metric left" proves the beacon ran and held none, not that it never ran.
 */
async function pagehideWithProbe(sendBeacon: ReturnType<typeof vi.fn>) {
  cohorly.track("probe");
  window.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() =>
    expect(beaconEvents(sendBeacon).some((e) => e.event === "probe")).toBe(true),
  );
  return metricEvents(sendBeacon);
}

describe("cohorly.metrics after init()", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a recorded distribution leaves on pagehide as a $metric through sendBeacon", async () => {
    const { sendBeacon } = setup();
    await initWeb();

    cohorly.metrics.distribution("x", 12, { service: "a" });
    expect(metricEvents(sendBeacon)).toEqual([]);
    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => expect(metricEvents(sendBeacon)).toHaveLength(1));
    const [event] = metricEvents(sendBeacon);
    expect(event.event).toBe("$metric");
    expect(event.properties).toMatchObject({
      metric_name: "x",
      metric_type: "distribution",
      metric_tag_service: "a",
      metric_count: 1,
      metric_max: 12,
    });
  });

  it("count and gauge record their value and tags", async () => {
    const { sendBeacon } = setup();
    await initWeb();

    cohorly.metrics.count("clicks", 2, { button: "buy" });
    cohorly.metrics.gauge("queue", 5, { lane: "fast" });
    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => expect(metricEvents(sendBeacon)).toHaveLength(2));
    const byName = Object.fromEntries(metricEvents(sendBeacon).map((e) => [e.properties.metric_name, e]));
    expect(byName.clicks.properties).toMatchObject({ metric_type: "count", metric_tag_button: "buy" });
    expect(byName.queue.properties).toMatchObject({ metric_type: "gauge", metric_tag_lane: "fast" });
  });

  it("flush() queues the pending window at once, before any pagehide", async () => {
    const { sendBeacon, fetchMock } = setup();
    await initWeb();

    cohorly.metrics.count("flushed_now", 1);
    expect(trackBodies(fetchMock).filter((e) => e.event === "$metric")).toEqual([]);
    cohorly.metrics.flush();
    await cohorly.flush();

    const sent = trackBodies(fetchMock).filter((e) => e.event === "$metric");
    expect(sent.map((e) => e.properties.metric_name)).toEqual(["flushed_now"]);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("a second init() replaces the client: metrics talk to the new one", async () => {
    const { sendBeacon } = setup();
    await initWeb({ token: "tok-first" });
    await initWeb({ token: "tok-second" });

    cohorly.metrics.count("after_reinit", 1);
    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => expect(metricEvents(sendBeacon)).toHaveLength(1));
    expect(metricEvents(sendBeacon)[0].properties).toMatchObject({
      metric_name: "after_reinit",
      token: "tok-second",
    });
  });
});

describe("metrics.flagKey option", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a disabled custom flagKey drops the samples and nothing leaves in the beacon", async () => {
    const { sendBeacon } = setup({ custom_key: flag(false) });
    await initWeb({ metrics: { flagKey: "custom_key" } }, true);

    cohorly.metrics.distribution("x", 12, { service: "a" });

    expect(await pagehideWithProbe(sendBeacon)).toEqual([]);
  });

  it("the default cohorly_metrics flag does not drop when a custom flagKey is set", async () => {
    const { sendBeacon } = setup({ cohorly_metrics: flag(false), custom_key: flag(true) });
    await initWeb({ metrics: { flagKey: "custom_key" } }, true);

    cohorly.metrics.distribution("x", 12, { service: "a" });
    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => expect(metricEvents(sendBeacon)).toHaveLength(1));
  });

  it("without the option, a disabled cohorly_metrics drops the samples", async () => {
    const { sendBeacon } = setup({ cohorly_metrics: flag(false) });
    await initWeb({}, true);

    cohorly.metrics.distribution("x", 12, { service: "a" });

    expect(await pagehideWithProbe(sendBeacon)).toEqual([]);
  });
});
