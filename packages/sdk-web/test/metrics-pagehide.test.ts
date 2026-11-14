import { MetricsAggregator } from "@cohorly/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackedEvent } from "../src/index.js";
import { init } from "../src/index.js";

/** Blob stand-in that keeps what was passed in, so the beacon body can be read back. */
class RecordingBlob {
  constructor(readonly parts: string[]) {}
}

function setup() {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  vi.stubGlobal("Blob", RecordingBlob);
  const sendBeacon = vi.fn((_url: string, _body: RecordingBlob) => true);
  Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
  const flush = vi.spyOn(MetricsAggregator.prototype, "flush");
  init({
    apiHost: "http://localhost:4000",
    token: "tok-web",
    loadFeatureFlags: false,
    flushIntervalMs: 0,
  });
  // Reaches the aggregator through the instance the unload handler flushes,
  // to assert the flush call itself; metrics.test.ts covers `cohorly.metrics`.
  window.dispatchEvent(new Event("pagehide"));
  // init() stops the previous client, which flushes its own aggregator first.
  const aggregator = flush.mock.contexts.at(-1) as MetricsAggregator;
  flush.mockClear();
  sendBeacon.mockClear();
  return { sendBeacon, aggregator };
}

function metricNames(sendBeacon: ReturnType<typeof vi.fn>): string[] {
  return sendBeacon.mock.calls
    .flatMap(([, blob]) => JSON.parse((blob as RecordingBlob).parts[0]) as TrackedEvent[])
    .filter((e) => e.event === "$metric")
    .map((e) => e.properties.metric_name as string);
}

describe("pending metric window on unload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pagehide sends the pending window through sendBeacon", async () => {
    const { sendBeacon, aggregator } = setup();
    aggregator.count("clicks", 3, { page: "home" });
    expect(metricNames(sendBeacon)).toEqual([]);

    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => expect(metricNames(sendBeacon)).toEqual(["clicks"]));
  });

  it("visibilitychange to hidden sends the pending window too", async () => {
    const { sendBeacon, aggregator } = setup();
    aggregator.distribution("js_cost", 12, { service: "web" });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
    }

    await vi.waitFor(() => expect(metricNames(sendBeacon)).toEqual(["js_cost"]));
  });

  it("sends no $metric when no window is pending", async () => {
    const { sendBeacon } = setup();
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(metricNames(sendBeacon)).toEqual([]);
  });
});
