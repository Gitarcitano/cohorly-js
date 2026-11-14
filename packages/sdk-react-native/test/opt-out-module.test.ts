import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasOptedOutTracking,
  init,
  isExceptionCaptureEnabled,
  onExceptionCaptureChange,
  optInTracking,
  optOutTracking,
  track,
} from "../src/index.js";
import { createFakeFetch, FakeStorage, requestsTo } from "./helpers.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("opt-out module functions", () => {
  // Runs first, while the module has no shared client yet.
  it("do not throw before init(): getters are false, opt-out and opt-in are no-ops, the subscription is inert", () => {
    expect(() => optOutTracking()).not.toThrow();
    expect(() => optInTracking()).not.toThrow();
    expect(hasOptedOutTracking()).toBe(false);
    expect(isExceptionCaptureEnabled()).toBe(false);
    const listener = vi.fn();
    const unsubscribe = onExceptionCaptureChange(listener);
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("drive the shared client after init()", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = init({
      apiHost: "http://localhost:4000",
      token: "tok",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      flushInterval: 60_000,
      loadFeatureFlags: false,
    });
    stops.push(() => client.stop());
    expect(isExceptionCaptureEnabled()).toBe(false);
    const listener = vi.fn();
    const unsubscribe = onExceptionCaptureChange(listener);
    await client.ready;
    expect(isExceptionCaptureEnabled()).toBe(true);
    expect(listener.mock.calls).toEqual([[true]]);

    optOutTracking();
    expect(hasOptedOutTracking()).toBe(true);
    expect(isExceptionCaptureEnabled()).toBe(false);
    expect(listener.mock.calls).toEqual([[true], [false]]);
    track("Ignored");
    await client.flush();
    expect(requestsTo(requests, "/track")).toEqual([]);

    optInTracking();
    expect(hasOptedOutTracking()).toBe(false);
    expect(listener.mock.calls).toEqual([[true], [false], [true]]);
    unsubscribe();
  });
});
