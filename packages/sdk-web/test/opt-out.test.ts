import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CohorlyWebOptions, TrackedEvent } from "../src/index.js";
import { cohorly, init } from "../src/index.js";

const API_HOST = "https://ingest.example.com";

function start(options: Partial<CohorlyWebOptions> = {}) {
  init({ apiHost: API_HOST, token: "tok-web", loadFeatureFlags: false, flushIntervalMs: 0, ...options });
}

/** Event names that reached /track through fetch. */
function sentEvents(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/track"))
    .flatMap(([, init]) => (JSON.parse((init as { body: string }).body) as { event: string }[]).map((e) => e.event));
}

describe("opt-out and captureExceptions on the web SDK", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    start();
    vi.unstubAllGlobals();
  });

  it("optOutTracking sends no event or $exception, even one already queued, and persists across init()", async () => {
    start();
    // A capture is sent at once: that first send fails, so the exception is
    // still queued when the opt-out comes. Only sends after it count.
    const ok = fetchMock.getMockImplementation();
    let failedTrack = false;
    fetchMock.mockImplementation(async (url: string, init: unknown) => {
      if (!failedTrack && String(url).endsWith("/track")) {
        failedTrack = true;
        throw new Error("offline");
      }
      return ok?.(url, init);
    });
    cohorly.track("Before");
    cohorly.captureException(new Error("queued"));
    await vi.waitFor(() => expect(failedTrack).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Object.values({ ...window.localStorage }).some((v) => String(v).includes('"value":"queued"'))).toBe(true);
    fetchMock.mockClear();
    cohorly.optOutTracking();
    expect(cohorly.hasOptedOutTracking()).toBe(true);

    expect(Object.values({ ...window.localStorage }).some((v) => String(v).includes('"value":"queued"'))).toBe(false);
    cohorly.track("After");
    expect(cohorly.captureException(new Error("after"))).toBeNull();
    await cohorly.flush();
    expect(sentEvents(fetchMock)).toEqual([]);

    start();
    expect(cohorly.hasOptedOutTracking()).toBe(true);
    cohorly.track("Still off");
    await cohorly.flush();
    expect(sentEvents(fetchMock)).toEqual([]);

    cohorly.optInTracking();
    cohorly.track("Back");
    await cohorly.flush();
    expect(sentEvents(fetchMock)).toEqual(["Back"]);
  });

  it("captureExceptions: false blocks the manual captureException too, but events still go out", async () => {
    start({ captureExceptions: false });
    expect(cohorly.captureException(new Error("manual"))).toBeNull();
    cohorly.track("Page View");
    await cohorly.flush();
    expect(sentEvents(fetchMock)).toEqual(["Page View"]);
  });

  it("captureExceptions omitted keeps manual captureException working", async () => {
    start();
    expect(cohorly.captureException(new Error("manual"))).not.toBeNull();
    await cohorly.flush();
    expect(sentEvents(fetchMock)).toEqual(["$exception"]);
  });

  describe("captureExceptions is three-state", () => {
    /** init() recording every exception that reaches the queue; then fires a global error. */
    function startCapturing(options: Partial<CohorlyWebOptions>) {
      const seen: TrackedEvent[] = [];
      start({
        ...options,
        beforeSendException: (evt) => {
          seen.push(evt);
          return evt;
        },
      });
      const globalError = new Error("global");
      // Marks the event handled, so jsdom does not report it as uncaught when
      // no SDK handler is installed. Added after init(), so it runs after them.
      const handled = (event: ErrorEvent) => event.preventDefault();
      window.addEventListener("error", handled);
      window.dispatchEvent(new ErrorEvent("error", { error: globalError, message: globalError.message, cancelable: true }));
      window.removeEventListener("error", handled);
      return seen;
    }

    it("true installs the handlers: a global error becomes a $exception", () => {
      const seen = startCapturing({ captureExceptions: true });
      expect(seen).toHaveLength(1);
      expect(seen[0].event).toBe("$exception");
      expect(cohorly.captureException(new Error("manual"))).not.toBeNull();
      expect(seen).toHaveLength(2);
    });

    it("omitted installs none: a global error is not captured, a manual one is", async () => {
      const seen = startCapturing({});
      expect(seen).toEqual([]);
      expect(cohorly.captureException(new Error("manual"))).not.toBeNull();
      expect(seen).toHaveLength(1);
      await cohorly.flush();
      expect(sentEvents(fetchMock)).toEqual(["$exception"]);
    });

    it("false installs none and a manual capture sends nothing either", async () => {
      const seen = startCapturing({ captureExceptions: false });
      expect(seen).toEqual([]);
      expect(cohorly.captureException(new Error("manual"))).toBeNull();
      expect(seen).toEqual([]);
      await cohorly.flush();
      expect(sentEvents(fetchMock)).toEqual([]);
    });
  });
});

