import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCrossSourceDedup } from "../src/exceptions.js";
import type { CohorlyWebOptions, TrackedEvent } from "../src/index.js";
import {
  CROSS_SOURCE_DEDUP_WINDOW_MS,
  cohorly,
  init,
  MAX_EXCEPTIONS_PER_FINGERPRINT,
} from "../src/index.js";

const API_HOST = "https://ingest.example.com";

function initCapturing(options: Partial<CohorlyWebOptions> = {}) {
  const seen: TrackedEvent[] = [];
  init({
    apiHost: API_HOST,
    token: "tok-web",
    loadFeatureFlags: false,
    flushIntervalMs: 0,
    captureExceptions: true,
    beforeSendException: (evt) => {
      seen.push(evt);
      return evt;
    },
    ...options,
  });
  return seen;
}

/** Lets the zero-delay timer that ends a "same task" run fire. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function dispatchOnError(error: Error) {
  window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
}

function dispatchRejection(reason: unknown) {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  window.dispatchEvent(event);
}

/** A NEW object every call, same type, message and crashing frame: what React 18 dev produces. */
function boom(message = "boom", frame = "render"): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${frame} (https://app.example.com/app.js:10:5)`;
  return error;
}

describe("one $exception per error seen by both a global handler and captureException", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetCrossSourceDedup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
      })),
    );
  });

  afterEach(() => {
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the global capture and drops a manual one with another Error object", () => {
    const seen = initCapturing();
    dispatchOnError(boom());
    const second = cohorly.captureException(boom(), {
      mechanism: { type: "react.errorboundary", handled: true },
    });

    expect(second).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].properties.$exception_level).toBe("fatal");
  });

  it("keeps the manual capture and drops the global one that follows", () => {
    const seen = initCapturing();
    const first = cohorly.captureException(boom());
    dispatchOnError(boom());

    expect(first).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(first);
  });

  it("collapses the real React 18 dev sequence global, manual, global into one", () => {
    const seen = initCapturing();
    dispatchOnError(boom());
    expect(cohorly.captureException(boom())).toBeNull();
    dispatchOnError(boom());
    expect(seen).toHaveLength(1);
    expect(seen[0].properties.$exception_level).toBe("fatal");
  });

  it("applies the same rule to an unhandled rejection", () => {
    const seen = initCapturing();
    dispatchRejection(boom("a"));
    expect(cohorly.captureException(boom("a"))).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("collapses what React 18 dev really does: global, global, then the boundary's manual capture", () => {
    const seen = initCapturing();
    dispatchOnError(boom());
    dispatchOnError(boom());
    expect(cohorly.captureException(boom())).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].properties.$exception_level).toBe("fatal");
  });

  it("duplicates do not extend the window: a recurring error reported by both sources keeps reaching the queue", async () => {
    const seen = initCapturing();
    const queuedAt: number[] = [];
    // A global error followed by its manual capture every 500 ms for two minutes.
    for (let t = 0; t < 120_000; t += 500) {
      vi.setSystemTime(1_000_000 + t);
      const source = (t / 500) % 2 === 0 ? "global" : "manual";
      const before = seen.length;
      if (source === "global") dispatchOnError(boom("recurring"));
      else cohorly.captureException(boom("recurring"));
      await nextTask();
      if (seen.length > before) queuedAt.push(t);
    }
    // Anchored on what was queued: after the 1 s window the next report passes again.
    expect(queuedAt.slice(0, 3)).toEqual([0, 1000, 2000]);
    // Two minutes at the 10-per-minute local limit: the error keeps counting instead of vanishing.
    expect(seen).toHaveLength(2 * MAX_EXCEPTIONS_PER_FINGERPRINT);
  });

  it("never drops two manual captures from the same source", () => {
    const seen = initCapturing();
    expect(cohorly.captureException(boom())).not.toBeNull();
    expect(cohorly.captureException(boom())).not.toBeNull();
    expect(seen).toHaveLength(2);
  });

  it("merges identical global errors only inside one synchronous run", async () => {
    const seen = initCapturing();
    dispatchOnError(boom());
    dispatchRejection(boom());
    expect(seen).toHaveLength(1);

    await nextTask();
    dispatchOnError(boom());
    await nextTask();
    dispatchOnError(boom());
    expect(seen).toHaveLength(3);
  });

  it("never merges identical global errors of a different message in one run", () => {
    const seen = initCapturing();
    dispatchOnError(boom("one"));
    dispatchOnError(boom("two"));
    expect(seen).toHaveLength(2);
  });

  it("never drops a different message or a different crashing frame", () => {
    const seen = initCapturing();
    dispatchOnError(boom("one"));
    expect(cohorly.captureException(boom("two"))).not.toBeNull();
    expect(cohorly.captureException(boom("one", "other"))).not.toBeNull();
    expect(seen).toHaveLength(3);
  });

  it("lets the second capture through once the window has passed", () => {
    const seen = initCapturing();
    dispatchOnError(boom());
    vi.setSystemTime(1_000_000 + CROSS_SOURCE_DEDUP_WINDOW_MS - 1);
    expect(cohorly.captureException(boom())).toBeNull();

    vi.setSystemTime(1_000_000 + CROSS_SOURCE_DEDUP_WINDOW_MS + 1);
    expect(cohorly.captureException(boom())).not.toBeNull();
    expect(seen).toHaveLength(2);
  });

  it("a dropped duplicate does not use up the local quota of 10", () => {
    const seen = initCapturing();
    dispatchOnError(boom("looping"));
    for (let i = 0; i < 50; i++) cohorly.captureException(boom("looping"));
    expect(seen).toHaveLength(1);

    vi.setSystemTime(1_000_000 + CROSS_SOURCE_DEDUP_WINDOW_MS + 1);
    // One slot went to the global capture; nine are still free.
    for (let i = 0; i < MAX_EXCEPTIONS_PER_FINGERPRINT - 1; i++) {
      expect(cohorly.captureException(boom("looping"))).not.toBeNull();
    }
    expect(cohorly.captureException(boom("looping"))).toBeNull();
    expect(seen).toHaveLength(MAX_EXCEPTIONS_PER_FINGERPRINT);
  });

  it("a manual capture dropped by beforeSendException does not stop the global one", () => {
    const sent: TrackedEvent[] = [];
    initCapturing({
      beforeSendException: (evt) => {
        if (evt.properties.$exception_level !== "fatal") return null;
        sent.push(evt);
        return evt;
      },
    });
    expect(cohorly.captureException(boom())).toBeNull();
    dispatchOnError(boom());
    expect(sent).toHaveLength(1);
  });

  it("keeps what it saw across init(), which React re-runs while it replays a failing render", () => {
    initCapturing();
    dispatchOnError(boom());
    const seen = initCapturing();
    expect(cohorly.captureException(boom())).toBeNull();
    dispatchOnError(boom());
    expect(seen).toHaveLength(0);
  });

  it("changes nothing for manual-only use (captureExceptions omitted)", () => {
    const seen: TrackedEvent[] = [];
    init({
      apiHost: API_HOST,
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      beforeSendException: (evt) => {
        seen.push(evt);
        return evt;
      },
    });
    expect(cohorly.captureException(boom())).not.toBeNull();
    expect(cohorly.captureException(boom())).not.toBeNull();
    expect(seen).toHaveLength(2);
  });
});
