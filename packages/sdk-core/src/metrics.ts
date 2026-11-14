import type { CohorlyMetricsOptions, FlagResult } from "./types.js";

export type MetricType = "count" | "gauge" | "distribution";
export type MetricTags = Record<string, string | number | boolean>;
export interface MetricOptions {
  tags?: MetricTags;
  unit?: string;
}

/**
 * Range labels for `metric_bucket` (the window's p95). Lower bound inclusive,
 * labels sort correctly as plain text. Fixed: changing an edge would split a
 * stored series in two.
 */
export const METRIC_BUCKETS: readonly { min: number; label: string }[] = [
  { min: Number.NEGATIVE_INFINITY, label: "-: <0" },
  { min: 0, label: "0: <1" },
  { min: 1, label: "1: 1-5" },
  { min: 5, label: "2: 5-10" },
  { min: 10, label: "3: 10-50" },
  { min: 50, label: "4: 50-100" },
  { min: 100, label: "5: 100-500" },
  { min: 500, label: "6: 500-1000" },
  { min: 1000, label: "7: 1000-5000" },
  { min: 5000, label: "8: 5000+" },
];

export const METRIC_EVENT = "$metric";
const DEFAULT_FLAG_KEY = "cohorly_metrics";
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_SERIES = 200;
const MAX_TAGS = 10;
const MAX_TAG_VALUE_LENGTH = 64;
const MAX_PERCENTILE_SAMPLES = 2048;

/** What the aggregator needs from the client; keeps it testable and acyclic. */
export interface MetricsHost {
  /** Queues an event stamped at `time` (the window start), not at Date.now(). */
  trackAt(
    event: string,
    properties: Record<string, unknown>,
    time: number,
  ): unknown;
  onFeatureFlags(cb: (flags: Record<string, FlagResult>) => void): () => void;
  areFeatureFlagsLoaded(): boolean;
  /** Called when a loaded flag set turns metrics off, after the pending window is dropped. */
  onDisabled?(): void;
  log(...args: unknown[]): void;
}

interface Series {
  type: MetricType;
  name: string;
  unit: string | undefined;
  tags: [string, string][];
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
  samples: number[];
}

function bucketOf(value: number): string {
  let label = METRIC_BUCKETS[0].label;
  for (const b of METRIC_BUCKETS) {
    if (value >= b.min) label = b.label;
  }
  return label;
}

/** Nearest-rank percentile of an ascending array; `pct` is an integer so the index math is exact. */
function nearestRank(sorted: number[], pct: number): number {
  const idx = Math.ceil((pct * sorted.length) / 100) - 1;
  return sorted[Math.max(0, idx)];
}

const OPTION_KEYS: ReadonlySet<string> = new Set(["tags", "unit"]);

/**
 * The third argument is `{ tags?, unit? }` when it is a non-empty object whose
 * keys are all `tags`/`unit` and whose `tags`, if present, is an object;
 * otherwise it is the tags map itself. So a tag literally named `unit` or
 * `tags` cannot be passed bare: wrap it as `{ tags: { unit: "x" } }`.
 */
function splitArg(arg: MetricTags | MetricOptions | undefined): {
  tags: Record<string, unknown>;
  unit: string | undefined;
} {
  if (arg === null || typeof arg !== "object") {
    return { tags: {}, unit: undefined };
  }
  const keys = Object.keys(arg);
  const rawTags = (arg as MetricOptions).tags;
  const isOptions =
    keys.length > 0 &&
    keys.every((k) => OPTION_KEYS.has(k)) &&
    (rawTags === undefined || (rawTags !== null && typeof rawTags === "object"));
  if (!isOptions) return { tags: arg as Record<string, unknown>, unit: undefined };
  const unit = (arg as MetricOptions).unit;
  return {
    tags: (rawTags as Record<string, unknown> | undefined) ?? {},
    unit:
      typeof unit === "string" && unit !== ""
        ? unit.slice(0, MAX_TAG_VALUE_LENGTH)
        : undefined,
  };
}

function normalizeTags(raw: Record<string, unknown>): [string, string][] {
  const entries: { key: string; orig: string; value: string }[] = [];
  for (const [orig, v] of Object.entries(raw)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      continue;
    }
    const key = orig.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (key === "") continue;
    entries.push({ key, orig, value: String(v).slice(0, MAX_TAG_VALUE_LENGTH) });
  }
  // Sorting on the original key too makes a sanitization collision ("A" vs
  // "a") resolve the same way whatever the caller's key order was.
  entries.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.orig < b.orig ? -1 : a.orig > b.orig ? 1 : 0,
  );
  const out: [string, string][] = [];
  for (const e of entries) {
    if (out.length > 0 && out[out.length - 1][0] === e.key) continue;
    if (out.length >= MAX_TAGS) break;
    out.push([e.key, e.value]);
  }
  return out;
}

/**
 * Aggregates metric samples into one `$metric` event per metric name, type and
 * tag combination per fixed, clock-aligned window (60s by default). Never one
 * event per sample; a window without samples emits nothing.
 */
export class MetricsAggregator {
  private readonly host: MetricsHost;
  private readonly flagKey: string;
  private readonly windowMs: number;
  private readonly maxSeries: number;
  /** Remote kill switch verdict. True until a loaded flag set says otherwise. */
  private enabled = true;
  private windowStart: number | undefined;
  private series = new Map<string, Series>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private overflowLogged = false;

  constructor(host: MetricsHost, options: CohorlyMetricsOptions = {}) {
    this.host = host;
    this.flagKey = options.flagKey ?? DEFAULT_FLAG_KEY;
    this.windowMs =
      options.windowMs !== undefined &&
      Number.isFinite(options.windowMs) &&
      options.windowMs > 0
        ? options.windowMs
        : DEFAULT_WINDOW_MS;
    this.maxSeries =
      options.maxSeries !== undefined &&
      Number.isFinite(options.maxSeries) &&
      options.maxSeries >= 1
        ? Math.floor(options.maxSeries)
        : DEFAULT_MAX_SERIES;
    // Not isFeatureEnabled(): that emits $feature_flag_called on first read,
    // and a kill switch read must not add events of its own.
    host.onFeatureFlags((flags) => this.onFlags(flags));
  }

  /** Adds `value` (default 1) to a counter. */
  count(name: string, value = 1, tagsOrOptions?: MetricTags | MetricOptions): void {
    this.record("count", name, value, tagsOrOptions);
  }

  /** Records the current level of something; the window keeps last, min, max, sum, count. */
  gauge(name: string, value: number, tagsOrOptions?: MetricTags | MetricOptions): void {
    this.record("gauge", name, value, tagsOrOptions);
  }

  /** Records a sample whose spread matters; the window adds p50, p95 and a p95 range label. */
  distribution(
    name: string,
    value: number,
    tagsOrOptions?: MetricTags | MetricOptions,
  ): void {
    this.record("distribution", name, value, tagsOrOptions);
  }

  /** Queues the pending window now. Network sending stays the client's job. */
  flush(): void {
    this.emitWindow();
  }

  private onFlags(flags: Record<string, FlagResult>): void {
    // identify()/reset() emit an empty map while flags are unloaded; that is
    // "unknown", not "flag deleted", so it must not flip the verdict.
    if (!this.host.areFeatureFlagsLoaded()) return;
    const flag = flags[this.flagKey];
    this.enabled = flag ? flag.enabled : true;
    if (!this.enabled) {
      this.discardWindow();
      this.host.onDisabled?.();
    }
  }

  private record(
    type: MetricType,
    name: string,
    value: number,
    tagsOrOptions: MetricTags | MetricOptions | undefined,
  ): void {
    try {
      if (!this.enabled) return;
      if (typeof name !== "string" || name.trim() === "") {
        this.host.log("metric dropped: invalid name");
        return;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        this.host.log("metric dropped: value is not a finite number", name);
        return;
      }

      const now = Date.now();
      const start = Math.floor(now / this.windowMs) * this.windowMs;
      // The window this sample would have joined already closed and its timer
      // never ran (suspended tab, throttled timer): ship it before starting over.
      if (this.windowStart !== undefined && start !== this.windowStart) {
        this.emitWindow();
      }

      const { tags: rawTags, unit } = splitArg(tagsOrOptions);
      const tags = normalizeTags(rawTags);
      // The unit is part of the identity: 5 "second" and 5000 "millisecond"
      // must never share a sum, a max or a p95.
      const key = JSON.stringify([type, name, unit ?? null, tags]);
      let s = this.series.get(key);
      if (!s) {
        if (this.series.size >= this.maxSeries) {
          if (!this.overflowLogged) {
            this.overflowLogged = true;
            this.host.log(`metric dropped: more than ${this.maxSeries} series in one window`);
          }
          return;
        }
        s = {
          type,
          name,
          unit,
          tags,
          count: 0,
          sum: 0,
          min: value,
          max: value,
          last: value,
          samples: [],
        };
        this.series.set(key, s);
      }

      s.count += 1;
      s.sum += value;
      if (value < s.min) s.min = value;
      if (value > s.max) s.max = value;
      s.last = value;
      if (type === "distribution") {
        if (s.samples.length < MAX_PERCENTILE_SAMPLES) {
          s.samples.push(value);
        } else {
          // Reservoir sampling: every sample seen so far is equally likely to
          // be one of the kept ones. Only the percentiles use this; count,
          // sum, min and max above stay exact.
          const j = Math.floor(Math.random() * s.count);
          if (j < MAX_PERCENTILE_SAMPLES) s.samples[j] = value;
        }
      }

      if (this.windowStart === undefined) {
        this.windowStart = start;
        // setTimeout, not setInterval: no timer runs while nothing is pending.
        this.timer = setTimeout(() => {
          this.timer = undefined;
          try {
            this.emitWindow();
          } catch (err) {
            this.host.log("metrics window emit failed", err);
          }
        }, start + this.windowMs - now);
        (this.timer as { unref?: () => void }).unref?.();
      }
    } catch (err) {
      this.host.log("metric recording failed", err);
    }
  }

  /** False once a loaded flag set turned metrics off. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Drops the pending window without emitting it (used by the client's opt-out). */
  discard(): void {
    this.discardWindow();
  }

  private discardWindow(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.windowStart = undefined;
    this.series = new Map();
    this.overflowLogged = false;
  }

  private emitWindow(): void {
    const start = this.windowStart;
    const series = this.series;
    this.discardWindow();
    if (start === undefined) return;
    for (const s of series.values()) {
      try {
        this.host.trackAt(METRIC_EVENT, this.buildProps(s, start), start);
      } catch (err) {
        this.host.log("metric event failed", err);
      }
    }
  }

  private buildProps(s: Series, start: number): Record<string, unknown> {
    const props: Record<string, unknown> = {
      metric_name: s.name,
      metric_type: s.type,
      ...(s.unit !== undefined ? { metric_unit: s.unit } : {}),
      metric_window_start: start,
      metric_window_ms: this.windowMs,
      metric_count: s.count,
      metric_sum: s.sum,
      metric_min: s.min,
      metric_max: s.max,
    };
    if (s.type === "gauge") props.metric_last = s.last;
    if (s.type === "distribution") {
      const sorted = [...s.samples].sort((a, b) => a - b);
      const p95 = nearestRank(sorted, 95);
      props.metric_p50 = nearestRank(sorted, 50);
      props.metric_p95 = p95;
      props.metric_bucket = bucketOf(p95);
    }
    for (const [k, v] of s.tags) props[`metric_tag_${k}`] = v;
    return props;
  }
}
