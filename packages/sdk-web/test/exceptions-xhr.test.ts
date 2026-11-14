import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Breadcrumb, CohorlyWebOptions, TrackedEvent } from "../src/index.js";
import { cohorly, init } from "../src/index.js";

const API_HOST = "https://ingest.example.com";

/**
 * Just enough of XMLHttpRequest, with the real state rules: open() resets the
 * request (a request in flight gets an abort event first, as Firefox does) and
 * send() outside the OPENED state throws InvalidStateError. The test settles requests.
 */
class FakeXHR extends EventTarget {
  status = 0;
  readyState = 0;
  onload: (() => void) | null = null;
  onreadystatechange: (() => void) | null = null;
  opened: unknown[] = [];
  sent: unknown[] = [];
  private state: "unsent" | "opened" | "sent" = "unsent";

  open(...args: unknown[]) {
    if (this.state === "sent") this.dispatchEvent(new Event("abort"));
    this.opened = args;
    this.state = "opened";
    return "open-result";
  }

  send(...args: unknown[]) {
    if (this.state !== "opened") {
      throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
    }
    this.state = "sent";
    this.sent = args;
    return "send-result";
  }

  /** Like a real response: the DONE readystatechange first, then load; the app's handlers after the listeners. */
  finish(status: number) {
    this.status = status;
    this.readyState = 4;
    this.dispatchEvent(new Event("readystatechange"));
    this.onreadystatechange?.();
    this.dispatchEvent(new Event("load"));
    this.onload?.();
  }

  /** Like the real thing, a failed request is DONE with status 0 before its error/timeout/abort event. */
  fire(type: "error" | "timeout" | "abort") {
    this.status = 0;
    this.readyState = 4;
    this.dispatchEvent(new Event("readystatechange"));
    this.dispatchEvent(new Event(type));
  }
}

function initCapturing(options: Partial<CohorlyWebOptions> = {}) {
  init({
    apiHost: API_HOST,
    token: "tok-web",
    loadFeatureFlags: false,
    flushIntervalMs: 0,
    captureExceptions: true,
    ...options,
  });
}

function request(method: string, url: string | URL, status?: number): FakeXHR {
  const xhr = new FakeXHR();
  xhr.open(method, url);
  xhr.send();
  if (status !== undefined) xhr.finish(status);
  return xhr;
}

/** The xhr breadcrumbs that travel with the next exception. */
function xhrCrumbs(): Breadcrumb[] {
  const evt = cohorly.captureException(new Error(`probe ${Math.random()}`)) as TrackedEvent;
  const all = (evt.properties.$exception_breadcrumbs as Breadcrumb[] | undefined) ?? [];
  return all.filter((c) => c.category === "xhr");
}

describe("XHR breadcrumbs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
  });

  afterEach(() => {
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("records a 500 without query or hash, in the same shape as fetch", () => {
    initCapturing();
    request("post", "https://api.example.com/orders?token=secret#frag", 500);

    const [crumb, ...rest] = xhrCrumbs();
    expect(rest).toEqual([]);
    expect(crumb.message).toBe("POST https://api.example.com/orders 500");
    expect(crumb.level).toBe("error");
    expect(crumb.data).toEqual({
      method: "POST",
      url: "https://api.example.com/orders",
      status_code: 500,
    });
    expect(JSON.stringify(crumb)).not.toMatch(/secret|\?|#/);
  });

  it("shows only the path for a same-origin request", () => {
    initCapturing();
    request("GET", "/api/cart?x=1", 503);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /api/cart 503"]);
  });

  it("records a 404 as a warning", () => {
    initCapturing();
    request("GET", "/missing", 404);
    const [crumb] = xhrCrumbs();
    expect(crumb.level).toBe("warning");
    expect(crumb.message).toBe("GET /missing 404");
  });

  it("records the boundary status 400, never 399, 200 or a status 0 load", () => {
    initCapturing();
    request("GET", "/a", 200);
    request("GET", "/b", 304);
    request("GET", "/c", 399);
    request("GET", "/d", 0);
    expect(xhrCrumbs()).toEqual([]);
    request("GET", "/e", 400);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /e 400"]);
  });

  it("records a network error and a timeout as failed, without a status code", () => {
    initCapturing();
    request("GET", "/offline").fire("error");
    request("PUT", "/slow").fire("timeout");

    const trail = xhrCrumbs();
    expect(trail.map((c) => c.message)).toEqual(["GET /offline failed", "PUT /slow failed"]);
    expect(trail.map((c) => c.level)).toEqual(["error", "error"]);
    for (const crumb of trail) expect(crumb.data).not.toHaveProperty("status_code");
  });

  it("never records an abort", () => {
    initCapturing();
    request("GET", "/cancelled").fire("abort");
    expect(xhrCrumbs()).toEqual([]);
  });

  it("records one breadcrumb per request even when several events fire", () => {
    initCapturing();
    const xhr = request("GET", "/flaky");
    xhr.fire("error");
    xhr.fire("timeout");
    xhr.finish(500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /flaky failed"]);
  });

  it("records each send of a reused XHR once", () => {
    initCapturing();
    const xhr = new FakeXHR();
    xhr.open("GET", "/first");
    xhr.send();
    xhr.finish(500);
    xhr.open("GET", "/second");
    xhr.send();
    xhr.finish(502);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /first 500", "GET /second 502"]);
  });

  it("accepts a URL object in open()", () => {
    initCapturing();
    request("GET", new URL("https://api.example.com/v1/items?page=2"), 500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET https://api.example.com/v1/items 500"]);
  });

  it("ignores the SDK's own endpoints but keeps the app's other paths on the same apiHost", () => {
    initCapturing();
    request("POST", `${API_HOST}/track`, 500);
    request("POST", `${API_HOST}/engage?x=1`, 500);
    request("POST", `${API_HOST}/alias`, 500);
    request("POST", `${API_HOST}/flags/evaluate`, 500);
    request("GET", `${API_HOST}/reports`, 500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual([`GET ${API_HOST}/reports 500`]);
  });

  it("handles a relative apiHost", () => {
    initCapturing({ apiHost: "/api/cohorly" });
    request("POST", "/api/cohorly/track", 500);
    request("POST", `${location.origin}/api/cohorly/engage`, 500);
    request("GET", "/api/cohorly/other", 500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /api/cohorly/other 500"]);
  });

  it("keeps this, arguments and return values of open and send, and leaves the app's handlers alone", () => {
    initCapturing();
    const xhr = new FakeXHR();
    const onload = vi.fn();
    xhr.onload = onload;
    const listener = vi.fn();
    xhr.addEventListener("load", listener);

    expect(xhr.open("get", "/x", true, "user")).toBe("open-result");
    expect(xhr.opened).toEqual(["get", "/x", true, "user"]);
    expect(xhr.send("body")).toBe("send-result");
    expect(xhr.sent).toEqual(["body"]);
    expect(xhr.onload).toBe(onload);

    xhr.finish(500);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(xhrCrumbs()).toHaveLength(1);
  });

  it("works for subclasses", () => {
    initCapturing();
    class Tracked extends FakeXHR {
      tag = "sub";
    }
    const sub = new Tracked();
    sub.open("GET", "/sub");
    sub.send();
    sub.finish(500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /sub 500"]);
  });

  it("throws exactly what the original throws for send() without open(), and records nothing", () => {
    initCapturing();
    const never = new FakeXHR();
    let thrown: unknown;
    try {
      never.send();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("InvalidStateError");
    never.finish(500);
    expect(xhrCrumbs()).toEqual([]);
  });

  it("records one breadcrumb when send() is called twice and the second throws", () => {
    initCapturing();
    const xhr = new FakeXHR();
    xhr.open("GET", "/twice");
    xhr.send();
    expect(() => xhr.send()).toThrow("OPENED");
    xhr.finish(500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /twice 500"]);
  });

  it("a rejected second send() leaves no stale watcher for a later open()", () => {
    initCapturing();
    const xhr = new FakeXHR();
    xhr.open("GET", "/first");
    xhr.send();
    expect(() => xhr.send()).toThrow("OPENED");
    xhr.open("GET", "/second");
    xhr.send();
    xhr.finish(500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /second 500"]);
  });

  it("records only the new URL when open() runs again on a request in flight", () => {
    initCapturing();
    const xhr = new FakeXHR();
    xhr.open("GET", "/old");
    xhr.send();
    xhr.open("POST", "/new");
    xhr.send();
    xhr.finish(500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["POST /new 500"]);
  });

  it("records the breadcrumb before an app onload that throws", () => {
    initCapturing();
    let seenByApp = -1;
    const xhr = new FakeXHR();
    xhr.open("GET", "/boom");
    xhr.send();
    xhr.onload = () => {
      // Runs after the SDK's capturing listener: the crumb must already exist.
      seenByApp = xhrCrumbs().length;
      throw new Error("app handler failed");
    };
    expect(() => xhr.finish(500)).toThrow("app handler failed");
    expect(seenByApp).toBe(1);
  });

  it("records the breadcrumb before an app onreadystatechange that throws on the failed DONE", () => {
    initCapturing();
    let seenByApp = -1;
    const xhr = new FakeXHR();
    xhr.open("GET", "/boom-state");
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      seenByApp = xhrCrumbs().length;
      throw new Error("app handler failed");
    };
    xhr.send();
    expect(() => xhr.finish(502)).toThrow("app handler failed");
    expect(seenByApp).toBe(1);
  });

  it("a failed DONE (status 0) followed by error or timeout is one failed breadcrumb", () => {
    initCapturing();
    const a = new FakeXHR();
    a.open("GET", "/offline");
    a.send();
    a.fire("error");
    const b = new FakeXHR();
    b.open("GET", "/slow");
    b.send();
    b.fire("timeout");
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /offline failed", "GET /slow failed"]);
  });

  it("accepts anything with a toString in open(), and ignores null and undefined", () => {
    initCapturing();
    request("GET", { toString: () => "/stringy" } as unknown as string, 500);
    const nothing = new FakeXHR();
    nothing.open("GET", null);
    nothing.send();
    nothing.finish(500);
    expect(xhrCrumbs().map((c) => c.message)).toEqual(["GET /stringy 500"]);
  });

  it("never throws into the page when the URL is unusable", () => {
    initCapturing();
    const xhr = new FakeXHR();
    expect(() => xhr.open("GET", undefined)).not.toThrow();
    expect(() => xhr.send()).not.toThrow();
    xhr.finish(500);
    expect(xhrCrumbs()).toEqual([]);
  });

  it("restores open on teardown, leaves send alone and stops recording from pending requests", () => {
    const openBefore = FakeXHR.prototype.open;
    const sendBefore = FakeXHR.prototype.send;
    initCapturing();
    expect(FakeXHR.prototype.open).not.toBe(openBefore);
    expect(FakeXHR.prototype.send).toBe(sendBefore);

    const pending = request("GET", "/in-flight");
    initCapturing();
    expect(FakeXHR.prototype.open).not.toBe(openBefore);
    pending.finish(500);
    expect(xhrCrumbs()).toEqual([]);

    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    expect(FakeXHR.prototype.open).toBe(openBefore);
    expect(FakeXHR.prototype.send).toBe(sendBefore);
  });

  it("does not touch XMLHttpRequest when captureExceptions is omitted or false", () => {
    const openBefore = FakeXHR.prototype.open;
    const sendBefore = FakeXHR.prototype.send;
    for (const captureExceptions of [undefined, false]) {
      init({
        apiHost: API_HOST,
        loadFeatureFlags: false,
        flushIntervalMs: 0,
        captureExceptions,
      });
      expect(FakeXHR.prototype.open).toBe(openBefore);
      expect(FakeXHR.prototype.send).toBe(sendBefore);
    }
  });
});
