import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Breadcrumb, CohorlyWebOptions, ExceptionListEntry, TrackedEvent } from "../src/index.js";
import { cohorly, init, MAX_EXCEPTIONS_PER_FINGERPRINT } from "../src/index.js";

const API_HOST = "https://ingest.example.com";

function response(status: number) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => ({}) };
}

function urlOf(input: unknown): string {
  return typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
}

/** init() with exception capture on; every exception that reaches the queue lands in `seen`. */
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

function list(evt: TrackedEvent): ExceptionListEntry[] {
  return evt.properties.$exception_list as ExceptionListEntry[];
}

function crumbs(evt: TrackedEvent | null | undefined): Breadcrumb[] {
  return (evt?.properties.$exception_breadcrumbs as Breadcrumb[] | undefined) ?? [];
}

function rejectionEvent(reason: unknown): Event {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  return event;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("automatic exception capture", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock = vi.fn(async (input: unknown) => {
      const url = urlOf(input);
      if (url.includes("/offline")) throw new TypeError("Failed to fetch");
      if (url.includes("/broken") || url.includes("/api/cohorly/") || url.startsWith(API_HOST)) {
        return response(500);
      }
      if (url.includes("/missing")) return response(404);
      return response(200);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    // A plain init() tears the previous capture down before globals are restored.
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("captures an onerror Error as unhandled and fatal, with stack, release, breadcrumbs and app version", () => {
    const from = location.pathname;
    const seen = initCapturing({ release: "web@2026.11.3", dist: "b71e04" });
    cohorly.addBreadcrumb({ category: "custom", message: "opened checkout" });
    history.pushState({}, "", "/checkout-13?step=2#total");

    const error = new TypeError("Cannot read properties of undefined (reading 'id')");
    error.stack = `TypeError: Cannot read properties of undefined (reading 'id')
    at e.submit (https://cdn.example.com/assets/app.b71e04.js:1:90412)
    at Nt (https://cdn.example.com/assets/app.b71e04.js:1:90337)`;
    window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));

    expect(seen).toHaveLength(1);
    const evt = seen[0];
    expect(evt.event).toBe("$exception");
    const [entry] = list(evt);
    expect(entry.type).toBe("TypeError");
    expect(entry.mechanism).toEqual({ handled: false, type: "onerror", synthetic: false });
    expect(entry.stacktrace?.frames.map((f) => f.function)).toEqual(["Nt", "e.submit"]);
    expect(evt.properties.$exception_level).toBe("fatal");
    expect(evt.properties.$exception_release).toBe("web@2026.11.3");
    expect(evt.properties.$exception_dist).toBe("b71e04");
    expect(evt.properties.$app_version_string).toBe("web@2026.11.3");
    expect(evt.properties.$lib).toBe("web");
    expect(evt.properties.$current_url).toBe(location.href);
    expect(evt.properties.$browser).toBeDefined();
    expect(crumbs(evt).map((c) => [c.category, c.message])).toEqual([
      ["custom", "opened checkout"],
      ["navigation", `${from} -> /checkout-13`],
    ]);

    cohorly.track("Viewed Page");
    const queued = JSON.parse(window.localStorage.getItem("cohorly_queue") ?? "[]");
    expect(queued.at(-1).properties.$app_version_string).toBe("web@2026.11.3");
  });

  it("builds a synthetic exception for onerror without an Error object", () => {
    const seen = initCapturing();
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "Script error.",
        filename: "https://cdn.other.com/widget.js",
        lineno: 12,
        colno: 7,
      }),
    );
    window.dispatchEvent(
      new ErrorEvent("error", { message: "Uncaught TypeError: x is not a function" }),
    );

    expect(seen.map((evt) => list(evt)[0])).toEqual([
      {
        type: "Error",
        value: "Script error.",
        mechanism: { handled: false, type: "onerror", synthetic: true },
        stacktrace: {
          type: "raw",
          frames: [
            {
              platform: "javascript",
              filename: "https://cdn.other.com/widget.js",
              abs_path: "https://cdn.other.com/widget.js",
              lineno: 12,
              colno: 7,
              in_app: true,
            },
          ],
        },
      },
      {
        type: "TypeError",
        value: "x is not a function",
        mechanism: { handled: false, type: "onerror", synthetic: true },
      },
    ]);
  });

  it("captures an unhandledrejection with a non-Error reason as a synthetic exception", () => {
    const seen = initCapturing();
    window.dispatchEvent(rejectionEvent({ code: "E_TIMEOUT" }));
    window.dispatchEvent(rejectionEvent(new RangeError("out of range")));

    expect(seen).toHaveLength(2);
    expect(list(seen[0])).toEqual([
      {
        type: "UnhandledRejection",
        value: 'Non-Error promise rejection captured with value: {"code":"E_TIMEOUT"}',
        mechanism: { handled: false, type: "onunhandledrejection", synthetic: true },
      },
    ]);
    expect(seen[0].properties.$exception_level).toBe("error");
    expect(list(seen[1])[0]).toMatchObject({
      type: "RangeError",
      value: "out of range",
      mechanism: { handled: false, type: "onunhandledrejection", synthetic: false },
    });
  });

  it("lets at most 10 identical errors per minute through the onerror path", async () => {
    const seen = initCapturing();
    for (let i = 0; i < 30; i++) {
      const error = new Error("render loop");
      error.stack = "Error: render loop\n    at render (https://app.example.com/app.js:10:5)";
      window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
      // One task per throw, as in a real loop of frames or timers.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(MAX_EXCEPTIONS_PER_FINGERPRINT).toBe(10);
    expect(seen).toHaveLength(MAX_EXCEPTIONS_PER_FINGERPRINT);

    const other = new Error("different error");
    window.dispatchEvent(new ErrorEvent("error", { error: other, message: other.message }));
    expect(seen).toHaveLength(MAX_EXCEPTIONS_PER_FINGERPRINT + 1);
  });

  it("lets the same error through again once the minute has passed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const seen = initCapturing();
      const capture = () => cohorly.captureException(new Error("same"));
      for (let i = 0; i < 15; i++) capture();
      expect(seen).toHaveLength(10);
      vi.setSystemTime(Date.now() + 60_001);
      capture();
      expect(seen).toHaveLength(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records failed fetches without query or hash, and neither successful nor SDK requests", async () => {
    initCapturing();
    await fetch("https://api.example.com/broken?token=secret#frag");
    await fetch("/ok?x=1");
    await fetch(`${API_HOST}/track`, { method: "POST" });
    await fetch("/missing?q=1", { method: "post" });
    await expect(fetch("https://api.example.com/offline?x=1")).rejects.toThrow();
    await settle();

    const fetchCrumbs = crumbs(cohorly.captureException(new Error("x"))).filter(
      (c) => c.category === "fetch",
    );
    expect(fetchCrumbs.map((c) => c.message)).toEqual([
      "GET https://api.example.com/broken 500",
      "POST /missing 404",
      "GET https://api.example.com/offline failed",
    ]);
    expect(fetchCrumbs[0].data).toEqual({
      method: "GET",
      url: "https://api.example.com/broken",
      status_code: 500,
    });
    expect(JSON.stringify(fetchCrumbs)).not.toMatch(/secret|\?|#/);
  });

  it("still records the app's failed requests when apiHost is the page's own origin", async () => {
    initCapturing({ apiHost: location.origin });
    await fetch("/missing?q=1");
    await fetch("/track", { method: "POST" });
    await fetch(`${location.origin}/flags/evaluate`, { method: "POST" });
    await settle();

    const fetchCrumbs = crumbs(cohorly.captureException(new Error("x"))).filter(
      (c) => c.category === "fetch",
    );
    expect(fetchCrumbs.map((c) => c.message)).toEqual(["GET /missing 404"]);
  });

  it("treats a relative apiHost's endpoints as SDK requests", async () => {
    initCapturing({ apiHost: "/api/cohorly" });
    await fetch("/api/cohorly/track", { method: "POST" });
    await fetch(`${location.origin}/api/cohorly/engage`, { method: "POST" });
    await fetch("/missing");
    await settle();

    const fetchCrumbs = crumbs(cohorly.captureException(new Error("x"))).filter(
      (c) => c.category === "fetch",
    );
    expect(fetchCrumbs.map((c) => c.message)).toEqual(["GET /missing 404"]);
  });

  it("hands back a fetch promise that still rejects, so unawaited failures stay unhandled", async () => {
    const original = Promise.reject(new TypeError("Failed to fetch"));
    original.catch(() => {});
    fetchMock.mockImplementationOnce(() => original);
    initCapturing();
    // The original promise gets the SDK's handlers attached; the caller must
    // receive a separate promise whose rejection nobody has handled yet.
    const failure = fetch("https://api.example.com/offline");
    expect(failure).not.toBe(original);
    await expect(failure).rejects.toThrow("Failed to fetch");
    const ok = (await fetch("/ok")) as { status: number };
    expect(ok.status).toBe(200);
  });

  it("records clicks as a short selector and console.error, never element text", () => {
    const original = vi.spyOn(console, "error").mockImplementation(() => {});
    initCapturing();
    document.body.innerHTML = '<button id="pay"><span>Pay $5 now</span></button><a class="nav-link main extra">Home</a>';
    document.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    console.error("payment failed", { code: 42 });

    expect(original).toHaveBeenCalledWith("payment failed", { code: 42 });
    const trail = crumbs(cohorly.captureException(new Error("x")));
    expect(trail.map((c) => [c.category, c.message])).toEqual([
      ["ui.click", "button#pay"],
      ["ui.click", "a.nav-link.main"],
      ["console", 'payment failed {"code":42}'],
    ]);
    expect(trail.find((c) => c.category === "console")?.level).toBe("error");
    expect(JSON.stringify(trail)).not.toContain("Pay $5");
  });

  it("console.error still logs when an argument throws while being described", () => {
    const original = vi.fn();
    vi.spyOn(console, "error").mockImplementation(original);
    initCapturing();
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter blew up");
      },
    });

    let thrown: unknown;
    try {
      console.error(hostile);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0][0]).toBe(hostile);
  });

  it("restores fetch and console.error on teardown and wraps them once across inits", () => {
    const fetchBefore = globalThis.fetch;
    const errorBefore = console.error;
    initCapturing();
    const wrappedFetch = globalThis.fetch;
    expect(wrappedFetch).not.toBe(fetchBefore);
    initCapturing();
    expect(globalThis.fetch).not.toBe(wrappedFetch);
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(console.error).toBe(errorBefore);
  });

  it("installs no handlers and wraps nothing when captureExceptions is off (the default)", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const fetchBefore = globalThis.fetch;
    const errorBefore = console.error;
    const pushStateBefore = history.pushState;
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });

    const types = addListener.mock.calls.map(([type]) => type);
    expect(types).not.toContain("error");
    expect(types).not.toContain("unhandledrejection");
    expect(types).not.toContain("hashchange");
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(console.error).toBe(errorBefore);
    expect(history.pushState).toBe(pushStateBefore);
  });

  it("captureException adds the web default properties and honors tags and options", () => {
    const seen = initCapturing({ release: "web@1" });
    const evt = cohorly.captureException("not an error", {
      level: "warning",
      title: "Odd value",
      tags: { plan: "pro" },
    });
    expect(seen).toEqual([evt]);
    expect(evt?.properties).toMatchObject({
      $exception_level: "warning",
      error_title: "Odd value",
      plan: "pro",
      $lib: "web",
      $current_url: location.href,
    });
    expect(list(evt!)[0].mechanism).toEqual({ handled: true, type: "generic", synthetic: true });
  });
});
