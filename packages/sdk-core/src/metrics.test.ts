import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "./client.js";
import { METRIC_BUCKETS } from "./metrics.js";
import type {
  CohorlyMetricsOptions,
  CohorlyStorage,
  FlagResult,
  TrackedEvent,
} from "./types.js";

// Aligned to a 60s boundary (60_000 * 28_333_334).
const T0 = 1_700_000_040_000;
const WINDOW = 60_000;

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

const flag = (enabled: boolean): FlagResult => ({
  enabled,
  variant: null,
  payload: null,
  reason: "test",
});

function setup(metrics?: CohorlyMetricsOptions) {
  const storage = makeStorage();
  const state: { mode: "normal" | "hang"; flags: Record<string, FlagResult> } = {
    mode: "normal",
    flags: {},
  };
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    storage,
    transport: async () => {},
    fetcher: async () => {
      if (state.mode === "hang") return new Promise<never>(() => {});
      return { flags: state.flags };
    },
    flushIntervalMs: 0,
    // Large so the size-triggered flush never drains the queue under test.
    batchSize: 100_000,
    metrics,
  });
  const queued = (): TrackedEvent[] => {
    const raw = storage.get("cohorly_queue");
    return raw ? (JSON.parse(raw) as TrackedEvent[]) : [];
  };
  const metricEvents = () => queued().filter((e) => e.event === "$metric");
  return { client, state, queued, metricEvents };
}

function metricProps(evt: TrackedEvent): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(evt.properties).filter(([k]) => k.startsWith("metric_")),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("aggregation window", () => {
  it("emits one event per tag combination after the window, never one per sample", () => {
    const { client, metricEvents } = setup();
    for (let i = 1; i <= 1000; i++) {
      client.metrics.distribution("js_cost", i, { service: i % 2 === 1 ? "api" : "web" });
      vi.advanceTimersByTime(50);
    }
    // 50s in: the window is still open.
    expect(metricEvents()).toHaveLength(0);
    // One millisecond before the boundary: still nothing.
    vi.advanceTimersByTime(WINDOW - 50_000 - 1);
    expect(metricEvents()).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const events = metricEvents();
    expect(events).toHaveLength(2);

    const byService = new Map(events.map((e) => [e.properties.metric_tag_service, e]));
    // odd values 1,3,...,999
    expect(metricProps(byService.get("api")!)).toMatchObject({
      metric_count: 500,
      metric_sum: 250_000,
      metric_min: 1,
      metric_max: 999,
      metric_p50: 499,
      metric_p95: 949,
    });
    // even values 2,4,...,1000
    expect(metricProps(byService.get("web")!)).toMatchObject({
      metric_count: 500,
      metric_sum: 250_500,
      metric_min: 2,
      metric_max: 1000,
      metric_p50: 500,
      metric_p95: 950,
    });
  });

  it("computes nearest-rank percentiles over 1..1000", () => {
    const { client, metricEvents } = setup();
    for (let i = 1; i <= 1000; i++) client.metrics.distribution("d", i);
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(evt.properties.metric_p50).toBe(500);
    expect(evt.properties.metric_p95).toBe(950);
    expect(evt.properties.metric_bucket).toBe("6: 500-1000");
  });

  it("a single sample is its own p50 and p95", () => {
    const { client, metricEvents } = setup();
    client.metrics.distribution("d", 42);
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(evt.properties.metric_p50).toBe(42);
    expect(evt.properties.metric_p95).toBe(42);
  });

  it("treats the same tags in another key order as one series, other tags, name or type as another", () => {
    const { client, metricEvents } = setup();
    client.metrics.count("m", 1, { a: 1, b: 2 });
    client.metrics.count("m", 1, { b: 2, a: 1 });
    client.metrics.count("m", 1, { a: 1, b: 3 });
    client.metrics.gauge("m", 5, { a: 1, b: 2 });
    client.metrics.count("other", 1, { a: 1, b: 2 });
    vi.advanceTimersByTime(WINDOW);

    const events = metricEvents();
    expect(events).toHaveLength(4);
    const sameSeries = events.find(
      (e) =>
        e.properties.metric_type === "count" &&
        e.properties.metric_name === "m" &&
        e.properties.metric_tag_b === "2",
    )!;
    expect(sameSeries.properties.metric_count).toBe(2);
  });

  it("stamps the event time with the window start, not the emit time", () => {
    const { client, metricEvents } = setup();
    vi.setSystemTime(T0 + 25_000);
    client.metrics.count("m");
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(evt.properties.time).toBe(T0);
    expect(evt.properties.metric_window_start).toBe(T0);
    expect(evt.properties.metric_window_ms).toBe(WINDOW);
  });

  it("moves a sample that arrives after the window ended (timer never ran) to the new window", () => {
    const { client, metricEvents } = setup();
    client.metrics.count("m", 1);
    vi.setSystemTime(T0 + WINDOW + 1000);
    client.metrics.count("m", 1);

    const first = metricEvents();
    expect(first).toHaveLength(1);
    expect(first[0].properties.time).toBe(T0);
    expect(first[0].properties.metric_count).toBe(1);

    vi.advanceTimersByTime(WINDOW - 1000);
    const all = metricEvents();
    expect(all).toHaveLength(2);
    expect(all[1].properties.time).toBe(T0 + WINDOW);
    expect(all[1].properties.metric_count).toBe(1);
  });
});

describe("timers and flush", () => {
  it("never emits for an empty window and arms no timer without a sample", () => {
    const { client, metricEvents } = setup();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * WINDOW);
    expect(metricEvents()).toHaveLength(0);

    client.metrics.count("m");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(WINDOW);
    expect(metricEvents()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5 * WINDOW);
    expect(metricEvents()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("metrics.flush() queues the pending window now and clears the timer", () => {
    const { client, metricEvents } = setup();
    client.metrics.count("m");
    client.metrics.flush();
    expect(metricEvents()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(WINDOW);
    expect(metricEvents()).toHaveLength(1);
  });

  it("stop() queues the pending window and leaves no timer", () => {
    const { client, metricEvents } = setup();
    client.metrics.count("m");
    client.stop();
    expect(metricEvents()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("kill switch", () => {
  it("records nothing, not even a timer, while the flag is disabled", async () => {
    const { client, state, queued } = setup();
    state.flags = { cohorly_metrics: flag(false) };
    await client.reloadFeatureFlags();

    client.metrics.count("m");
    client.metrics.gauge("g", 1);
    client.metrics.distribution("d", 1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * WINDOW);
    expect(queued()).toHaveLength(0);
  });

  it("sends when the flag does not exist", async () => {
    const { client, state, metricEvents } = setup();
    state.flags = { something_else: flag(false) };
    await client.reloadFeatureFlags();
    client.metrics.count("m");
    vi.advanceTimersByTime(WINDOW);
    expect(metricEvents()).toHaveLength(1);
  });

  it("sends when the flag is on, and reading the verdict emits no $feature_flag_called", async () => {
    const { client, state, queued } = setup();
    state.flags = { cohorly_metrics: flag(true) };
    await client.reloadFeatureFlags();
    client.metrics.count("m");
    vi.advanceTimersByTime(WINDOW);
    expect(queued().map((e) => e.event)).toEqual(["$metric"]);
  });

  it("honors a custom flag key", async () => {
    const { client, state, queued } = setup({ flagKey: "my_switch" });
    state.flags = { cohorly_metrics: flag(false), my_switch: flag(false) };
    await client.reloadFeatureFlags();
    client.metrics.count("m");
    vi.advanceTimersByTime(WINDOW);
    expect(queued()).toHaveLength(0);
  });

  it("discards the pending window when the flag turns off mid-window, and records again once it is back on", async () => {
    const { client, state, metricEvents } = setup();
    state.flags = { cohorly_metrics: flag(true) };
    await client.reloadFeatureFlags();
    client.metrics.count("m", 5);
    expect(vi.getTimerCount()).toBe(1);

    state.flags = { cohorly_metrics: flag(false) };
    await client.reloadFeatureFlags();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(WINDOW);
    expect(metricEvents()).toHaveLength(0);

    state.flags = { cohorly_metrics: flag(true) };
    await client.reloadFeatureFlags();
    client.metrics.count("m", 2);
    vi.advanceTimersByTime(WINDOW);
    const events = metricEvents();
    expect(events).toHaveLength(1);
    expect(events[0].properties.metric_sum).toBe(2);
  });

  it("identify() and reset() clear the flags to an empty map without turning metrics back on", async () => {
    const { client, state, queued } = setup();
    state.flags = { cohorly_metrics: flag(false) };
    await client.reloadFeatureFlags();

    // The reload triggered by identify()/reset() never answers, so the empty
    // map is all the aggregator ever sees.
    state.mode = "hang";
    await client.identify("user-1");
    expect(client.areFeatureFlagsLoaded()).toBe(false);
    client.metrics.count("m");
    client.reset();
    client.metrics.count("m");
    vi.advanceTimersByTime(WINDOW);
    expect(vi.getTimerCount()).toBe(0);
    expect(queued()).toHaveLength(0);
  });

  it("adopts a persisted disabled flag at construction", async () => {
    const storage = makeStorage();
    const first = new CohorlyClient({
      storage,
      transport: async () => {},
      fetcher: async () => ({ flags: { cohorly_metrics: flag(false) } }),
      flushIntervalMs: 0,
      batchSize: 100_000,
    });
    await first.reloadFeatureFlags();

    const second = new CohorlyClient({
      storage,
      transport: async () => {},
      fetcher: async () => new Promise<never>(() => {}),
      flushIntervalMs: 0,
      batchSize: 100_000,
    });
    second.metrics.count("m");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(WINDOW);
    expect(JSON.parse(storage.get("cohorly_queue") ?? "[]")).toEqual([]);
  });
});

describe("input handling", () => {
  it("drops non-finite and non-number values and bad names without a trace", () => {
    const { client, metricEvents } = setup();
    client.metrics.gauge("g", Number.NaN);
    client.metrics.gauge("g", Number.POSITIVE_INFINITY);
    client.metrics.gauge("g", Number.NEGATIVE_INFINITY);
    client.metrics.gauge("g", "5" as unknown as number);
    client.metrics.gauge("g", null as unknown as number);
    client.metrics.gauge("", 1);
    client.metrics.gauge("   ", 1);
    client.metrics.gauge(undefined as unknown as string, 1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(WINDOW);
    expect(metricEvents()).toHaveLength(0);

    client.metrics.gauge("g", 3);
    vi.advanceTimersByTime(WINDOW);
    expect(metricEvents()).toHaveLength(1);
  });

  it("count() defaults the value to 1", () => {
    const { client, metricEvents } = setup();
    client.metrics.count("hits");
    client.metrics.count("hits");
    client.metrics.count("hits", 3);
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(evt.properties.metric_count).toBe(3);
    expect(evt.properties.metric_sum).toBe(5);
    expect(evt.properties.metric_min).toBe(1);
    expect(evt.properties.metric_max).toBe(3);
  });

  it("tells { tags, unit } options apart from a bare tags map", () => {
    const { client, metricEvents } = setup();
    client.metrics.count("a", 1, { tags: { region: "eu" }, unit: "ms" });
    client.metrics.count("b", 1, { unit: "ms" });
    client.metrics.count("c", 1, { region: "eu" });
    client.metrics.count("d", 1, { tags: { unit: "x" } });
    client.metrics.count("e", 1, { tags: "x", unit: "y" });
    vi.advanceTimersByTime(WINDOW);
    const byName = new Map(metricEvents().map((e) => [e.properties.metric_name, metricProps(e)]));

    expect(byName.get("a")).toMatchObject({ metric_unit: "ms", metric_tag_region: "eu" });
    expect(byName.get("b")).toMatchObject({ metric_unit: "ms" });
    expect(byName.get("b")).not.toHaveProperty("metric_tag_unit");
    expect(byName.get("c")).toMatchObject({ metric_tag_region: "eu" });
    expect(byName.get("c")).not.toHaveProperty("metric_unit");
    expect(byName.get("d")).toMatchObject({ metric_tag_unit: "x" });
    expect(byName.get("e")).toMatchObject({ metric_tag_tags: "x", metric_tag_unit: "y" });
  });
});

describe("limits", () => {
  it("keeps the first 10 tag keys alphabetically, sanitizes keys and truncates values to 64 chars", () => {
    const { client, metricEvents } = setup();
    const tags: Record<string, string | number | boolean> = {};
    for (let i = 11; i >= 1; i--) tags[`k${String(i).padStart(2, "0")}`] = i;
    tags["My-Key!"] = "v";
    tags["!!!"] = "x";
    tags.long = "x".repeat(100);
    tags.flag = true;
    client.metrics.count("m", 1, tags);
    vi.advanceTimersByTime(WINDOW);

    const tagKeys = Object.keys(metricProps(metricEvents()[0]))
      .filter((k) => k.startsWith("metric_tag_"))
      .sort();
    // "!!!" sanitizes to "___", a legal key that sorts first; k09..k11, long
    // and my_key_ fall past the 10th key.
    expect(tagKeys).toEqual([
      "metric_tag____",
      "metric_tag_flag",
      "metric_tag_k01",
      "metric_tag_k02",
      "metric_tag_k03",
      "metric_tag_k04",
      "metric_tag_k05",
      "metric_tag_k06",
      "metric_tag_k07",
      "metric_tag_k08",
    ]);
    expect(metricEvents()[0].properties.metric_tag_flag).toBe("true");
    expect(metricEvents()[0].properties.metric_tag_k01).toBe("1");
  });

  it("sanitizes uppercase and symbols in tag keys and truncates long values", () => {
    const { client, metricEvents } = setup();
    client.metrics.count("m", 1, { "My-Key!": "v", long: "x".repeat(100) });
    vi.advanceTimersByTime(WINDOW);
    const props = metricProps(metricEvents()[0]);
    expect(props.metric_tag_my_key_).toBe("v");
    expect(props.metric_tag_long).toBe("x".repeat(64));
  });

  it("drops the 201st series of a window and keeps feeding the existing ones", () => {
    const { client, metricEvents } = setup();
    for (let i = 0; i < 201; i++) client.metrics.count("m", 1, { id: i });
    client.metrics.count("m", 1, { id: 0 });
    vi.advanceTimersByTime(WINDOW);

    const events = metricEvents();
    expect(events).toHaveLength(200);
    expect(events.some((e) => e.properties.metric_tag_id === "200")).toBe(false);
    const first = events.find((e) => e.properties.metric_tag_id === "0")!;
    expect(first.properties.metric_count).toBe(2);
  });

  it("frees the series budget when the next window starts", () => {
    const { client, metricEvents } = setup({ maxSeries: 2 });
    client.metrics.count("a");
    client.metrics.count("b");
    client.metrics.count("c");
    vi.advanceTimersByTime(WINDOW);
    expect(metricEvents()).toHaveLength(2);
    client.metrics.count("c");
    vi.advanceTimersByTime(WINDOW);
    expect(metricEvents().map((e) => e.properties.metric_name)).toEqual(["a", "b", "c"]);
  });

  it("keeps count, sum, min and max exact past 2048 samples, with p95 from a uniform reservoir", () => {
    const { client, metricEvents } = setup();
    const n = 5000;
    for (let i = 1; i <= n; i++) client.metrics.distribution("d", i);
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(evt.properties.metric_count).toBe(5000);
    expect(evt.properties.metric_sum).toBe(12_502_500);
    expect(evt.properties.metric_min).toBe(1);
    expect(evt.properties.metric_max).toBe(5000);
    const p95 = evt.properties.metric_p95 as number;
    expect(p95).toBeGreaterThanOrEqual(1);
    expect(p95).toBeLessThanOrEqual(5000);
    // Keeping only the first 2048 samples would give ~1946; a uniform
    // reservoir lands near 4750.
    expect(p95).toBeGreaterThan(4500);
  });
});

describe("event properties", () => {
  it("count: only count, sum, min, max", () => {
    const { client, metricEvents } = setup();
    client.metrics.count("orders", 2, { tags: { region: "eu" }, unit: "order" });
    client.metrics.count("orders", 5, { tags: { region: "eu" }, unit: "order" });
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(evt.event).toBe("$metric");
    expect(metricProps(evt)).toEqual({
      metric_name: "orders",
      metric_type: "count",
      metric_unit: "order",
      metric_window_start: T0,
      metric_window_ms: 60_000,
      metric_count: 2,
      metric_sum: 7,
      metric_min: 2,
      metric_max: 5,
      metric_tag_region: "eu",
    });
    expect(evt.properties.time).toBe(T0);
  });

  it("gauge: adds last, no percentiles, no unit when none was given", () => {
    const { client, metricEvents } = setup();
    client.metrics.gauge("queue_depth", 7);
    client.metrics.gauge("queue_depth", 3);
    client.metrics.gauge("queue_depth", 5);
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(metricProps(evt)).toEqual({
      metric_name: "queue_depth",
      metric_type: "gauge",
      metric_window_start: T0,
      metric_window_ms: 60_000,
      metric_count: 3,
      metric_sum: 15,
      metric_min: 3,
      metric_max: 7,
      metric_last: 5,
    });
  });

  it("distribution: adds p50, p95 and bucket", () => {
    const { client, metricEvents } = setup();
    for (const v of [10, 20, 30, 40]) client.metrics.distribution("lat", v, { unit: "ms" });
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(metricProps(evt)).toEqual({
      metric_name: "lat",
      metric_type: "distribution",
      metric_unit: "ms",
      metric_window_start: T0,
      metric_window_ms: 60_000,
      metric_count: 4,
      metric_sum: 100,
      metric_min: 10,
      metric_max: 40,
      metric_p50: 20,
      metric_p95: 40,
      metric_bucket: "3: 10-50",
    });
  });

  it("buckets the p95 on the documented edges, lower bound inclusive", () => {
    const { client, metricEvents } = setup();
    const cases: [number, string][] = [
      [-1, "-: <0"],
      [0, "0: <1"],
      [0.99, "0: <1"],
      [1, "1: 1-5"],
      [4.99, "1: 1-5"],
      [5, "2: 5-10"],
      [9.99, "2: 5-10"],
      [10, "3: 10-50"],
      [49.99, "3: 10-50"],
      [50, "4: 50-100"],
      [99.99, "4: 50-100"],
      [100, "5: 100-500"],
      [499.99, "5: 100-500"],
      [500, "6: 500-1000"],
      [999.99, "6: 500-1000"],
      [1000, "7: 1000-5000"],
      [4999.99, "7: 1000-5000"],
      [5000, "8: 5000+"],
      [1_000_000, "8: 5000+"],
    ];
    cases.forEach(([v], i) => client.metrics.distribution(`d${i}`, v));
    vi.advanceTimersByTime(WINDOW);
    const byName = new Map(metricEvents().map((e) => [e.properties.metric_name, e.properties.metric_bucket]));
    cases.forEach(([v, label], i) => {
      expect(byName.get(`d${i}`), `value ${v}`).toBe(label);
    });
  });

  it("exports bucket labels that sort in range order as plain text", () => {
    const labels = METRIC_BUCKETS.map((b) => b.label);
    expect(labels).toHaveLength(10);
    expect([...labels].sort()).toEqual(labels);
  });

  it("carries the client identity and super properties like any event", () => {
    const { client, metricEvents } = setup();
    client.register({ app_version: "1.2.3" });
    client.metrics.count("m");
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(evt.properties.distinct_id).toBe(client.getDistinctId());
    expect(evt.properties.$device_id).toBe(client.getDeviceId());
    expect(evt.properties.app_version).toBe("1.2.3");
    expect(typeof evt.properties.$insert_id).toBe("string");
  });
});

describe("identity changes", () => {
  it("identify() ships the pending window under the previous distinct_id, the next window under the new one", async () => {
    const { client, metricEvents } = setup();
    const anonId = client.getDistinctId();
    client.metrics.count("m", 1);
    await client.identify("user-1");
    expect(metricEvents()).toHaveLength(1);
    client.metrics.count("m", 1);
    // The old window's timer is gone: only the new window's one is armed, and
    // it must not fire early.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(WINDOW - 1);
    expect(metricEvents()).toHaveLength(1);
    vi.advanceTimersByTime(1);

    const events = metricEvents();
    expect(events).toHaveLength(2);
    expect(events[0].properties.distinct_id).toBe(anonId);
    expect(events[0].properties.$user_id).toBeUndefined();
    expect(events[1].properties.distinct_id).toBe("user-1");
    expect(events[1].properties.$user_id).toBe("user-1");
  });

  it("reset() ships the pending window under the identity it was measured with", () => {
    const { client, metricEvents } = setup();
    const before = client.getDistinctId();
    client.metrics.count("m", 1);
    client.reset();
    const events = metricEvents();
    expect(events).toHaveLength(1);
    expect(events[0].properties.distinct_id).toBe(before);
    expect(client.getDistinctId()).not.toBe(before);
  });
});

describe("series identity and event hygiene", () => {
  it("treats the same name with another unit as another series", () => {
    const { client, metricEvents } = setup();
    client.metrics.distribution("t", 5, { unit: "second" });
    client.metrics.distribution("t", 5000, { unit: "millisecond" });
    vi.advanceTimersByTime(WINDOW);
    const events = metricEvents();
    expect(events).toHaveLength(2);
    const byUnit = new Map(events.map((e) => [e.properties.metric_unit, e]));
    expect(byUnit.get("second")?.properties.metric_max).toBe(5);
    expect(byUnit.get("millisecond")?.properties.metric_max).toBe(5000);
  });

  it("never lets a super property fill a metric_ field the aggregator omitted", () => {
    const { client, metricEvents } = setup();
    client.register({
      metric_bucket: "x",
      metric_unit: "y",
      metric_last: 1,
      metric_tag_extra: "z",
      app_version: "1.2.3",
    });
    client.metrics.count("m", 2);
    vi.advanceTimersByTime(WINDOW);
    const [evt] = metricEvents();
    expect(evt.properties.metric_bucket).toBeUndefined();
    expect(evt.properties.metric_unit).toBeUndefined();
    expect(evt.properties.metric_last).toBeUndefined();
    expect(evt.properties.metric_tag_extra).toBeUndefined();
    expect(evt.properties.metric_sum).toBe(2);
    expect(evt.properties.app_version).toBe("1.2.3");
  });
});

describe("queue cap", () => {
  it("drops $metric events before any product event when the queue overflows", () => {
    const storage = makeStorage();
    const client = new CohorlyClient({
      storage,
      transport: async () => {},
      fetcher: async () => ({ flags: {} }),
      flushIntervalMs: 0,
      batchSize: 100_000,
      maxQueueSize: 5,
    });
    client.track("Sign Up");
    client.track("Checkout");
    client.track("Invite");
    for (const service of ["a", "b", "c", "d"]) {
      client.metrics.count("m", 1, { service });
    }
    vi.advanceTimersByTime(WINDOW);
    const queue = JSON.parse(storage.get("cohorly_queue") ?? "[]") as TrackedEvent[];
    expect(queue).toHaveLength(5);
    expect(queue.filter((e) => e.event !== "$metric").map((e) => e.event)).toEqual([
      "Sign Up",
      "Checkout",
      "Invite",
    ]);
    expect(queue.filter((e) => e.event === "$metric")).toHaveLength(2);
  });

  it("still drops the oldest events when no $metric is queued", () => {
    const storage = makeStorage();
    const client = new CohorlyClient({
      storage,
      transport: async () => {},
      fetcher: async () => ({ flags: {} }),
      flushIntervalMs: 0,
      batchSize: 100_000,
      maxQueueSize: 2,
    });
    client.track("one");
    client.track("two");
    client.track("three");
    const queue = JSON.parse(storage.get("cohorly_queue") ?? "[]") as TrackedEvent[];
    expect(queue.map((e) => e.event)).toEqual(["two", "three"]);
  });
});

describe("flag hold on a cold start", () => {
  function coldStart() {
    const storage = makeStorage();
    const sent: TrackedEvent[] = [];
    const answers: ((value: unknown) => void)[] = [];
    let evaluations = 0;
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport: async (_url, body) => {
        if (Array.isArray(body)) sent.push(...(body as TrackedEvent[]));
      },
      fetcher: () => {
        evaluations += 1;
        return new Promise((resolve) => answers.push(resolve));
      },
      flushIntervalMs: 0,
      batchSize: 100_000,
    });
    const answer = async (value: unknown) => {
      for (const resolve of answers) resolve(value);
      await vi.advanceTimersByTimeAsync(0);
    };
    const queuedMetrics = () =>
      (JSON.parse(storage.get("cohorly_queue") ?? "[]") as TrackedEvent[]).filter(
        (e) => e.event === "$metric",
      );
    const sentNames = () => sent.map((e) => e.event);
    return { client, answer, sent, sentNames, queuedMetrics, evaluations: () => evaluations };
  }

  async function sampleThenIdentify(client: CohorlyClient) {
    void client.reloadFeatureFlags();
    client.metrics.count("m", 2);
    client.track("Open");
    await client.identify("user-1");
    await client.flush();
  }

  it("flag off: no $metric is sent before or after the flags arrive, and none stays in the persisted queue", async () => {
    const { client, answer, sentNames, queuedMetrics } = coldStart();
    await sampleThenIdentify(client);
    expect(sentNames()).toEqual(["Open"]);
    expect(queuedMetrics()).toHaveLength(1);

    await answer({ flags: { cohorly_metrics: flag(false) } });
    expect(queuedMetrics()).toHaveLength(0);
    await client.flush();
    expect(sentNames()).toEqual(["Open"]);
  });

  it("flag on: the $metric is sent after the flags arrive, not before", async () => {
    const { client, answer, sentNames } = coldStart();
    await sampleThenIdentify(client);
    expect(sentNames()).toEqual(["Open"]);

    await answer({ flags: { cohorly_metrics: flag(true) } });
    await client.flush();
    expect(sentNames()).toEqual(["Open", "$metric"]);
  });

  it("flag missing: the $metric is sent after the flags arrive", async () => {
    const { client, answer, sentNames } = coldStart();
    await sampleThenIdentify(client);
    await answer({ flags: {} });
    await client.flush();
    expect(sentNames()).toEqual(["Open", "$metric"]);
  });

  it("a failed evaluation releases the $metric", async () => {
    const { client, answer, sentNames } = coldStart();
    await sampleThenIdentify(client);
    expect(sentNames()).toEqual(["Open"]);

    await answer(undefined);
    await client.flush();
    expect(sentNames()).toEqual(["Open", "$metric"]);
  });

  it("holds nothing when no flag evaluation was ever started", async () => {
    const { client, sentNames, evaluations } = coldStart();
    client.metrics.count("m");
    client.metrics.flush();
    await client.flush();
    expect(sentNames()).toEqual(["$metric"]);
    expect(evaluations()).toBe(0);
  });

  it("a flush while held sends the other events and keeps the $metric", async () => {
    const { client, answer, sentNames, queuedMetrics } = coldStart();
    void client.reloadFeatureFlags();
    client.metrics.count("m");
    client.metrics.flush();
    client.track("A");
    client.track("B");
    await client.flush();
    expect(sentNames()).toEqual(["A", "B"]);
    expect(queuedMetrics()).toHaveLength(1);

    await answer({ flags: {} });
    await client.flush();
    expect(sentNames()).toEqual(["A", "B", "$metric"]);
    expect(queuedMetrics()).toHaveLength(0);
  });
});

describe("window emission on teardown", () => {
  it("queuing a window never starts a fetch flush, even when the queue reaches batchSize", async () => {
    const transport = vi.fn(async () => {});
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage: makeStorage(),
      transport,
      flushIntervalMs: 0,
      batchSize: 2,
    });
    for (const name of ["a", "b", "c"]) client.metrics.count(name);
    client.metrics.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport).not.toHaveBeenCalled();

    const beacon = vi.fn(async () => {});
    await client.flush(beacon);
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it("a stopped client no longer rewrites the persisted queue when its late flags disable metrics", async () => {
    const storage = makeStorage();
    let answer: ((value: unknown) => void) | undefined;
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      storage,
      transport: async () => {},
      fetcher: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      flushIntervalMs: 0,
      batchSize: 100_000,
    });
    void client.reloadFeatureFlags();
    client.metrics.count("m");
    client.stop();
    const persisted = storage.get("cohorly_queue");
    expect(persisted).toContain("$metric");

    answer?.({ flags: { cohorly_metrics: flag(false) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.get("cohorly_queue")).toBe(persisted);
  });
});
