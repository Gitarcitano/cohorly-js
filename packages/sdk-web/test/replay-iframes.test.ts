import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionReplayOptions } from "../src/index.js";
import { cohorly, init } from "../src/index.js";

// Parent side of cross-origin iframe recording (VEL-2152). A stand-in for
// @rrweb/record keeps rrweb's emit order (Meta + FullSnapshot on start and on
// takeFullSnapshot) and, like rrweb's IframeManager, a `message` listener
// added by record() that emits what a child relays; replay-rrweb.test.ts runs
// the real rrweb.
const rr = vi.hoisted(() => {
  const state = { emit: null as null | ((e: unknown) => void), snapshots: 0 };
  const snapshot = () => {
    state.emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href } });
    state.emit?.({ type: 2, timestamp: Date.now(), data: { node: {} } });
    state.snapshots += 1;
  };
  const relayed = (message: MessageEvent) => {
    const data = message.data as { type?: unknown; event?: { type?: unknown } } | null;
    if (data?.type === "rrweb" && typeof data.event?.type === "number") state.emit?.(data.event);
  };
  const record = Object.assign(
    vi.fn((options: { emit: (e: unknown) => void }) => {
      state.emit = options.emit;
      window.addEventListener("message", relayed);
      snapshot();
      return () => {
        state.emit = null;
        window.removeEventListener("message", relayed);
      };
    }),
    { takeFullSnapshot: () => snapshot() },
  );
  return { state, record };
});
vi.mock("@rrweb/record", () => ({ record: rr.record }));

const API_HOST = "https://ingest.example.com";
const PAY = "https://pay.example.com";
const OTHER = "https://other.example.com";
const EVIL = "https://evil.example.com";
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

interface RrEvent {
  type: number;
  timestamp: number;
  data: Record<string, unknown>;
}

/** What the parent's rrweb emits when a child's full snapshot arrives (or a same-origin iframe loads). */
const attachEvent = () => ({
  type: 3,
  timestamp: Date.now(),
  data: { source: 0, adds: [], removes: [], texts: [], attributes: [], isAttachIframe: true },
});

/** A mouse interaction (IncrementalSource.MouseInteraction). */
const click = (id: number) => ({ type: 3, timestamp: Date.now(), data: { source: 2, type: 2, id } });

describe("session replay of cross-origin iframes (parent)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  /** Every message posted to an iframe, as `frameId:op@targetOrigin`, in order. */
  let posted: string[];
  const parentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");

  /** Records what is posted to each iframe's current window (an iframe that finished loading late has a new one). */
  function stubFrames() {
    for (const f of Array.from(document.getElementsByTagName("iframe"))) {
      (f.contentWindow as Window).postMessage = ((message: { op: string }, target: string) => {
        posted.push(`${f.id}:${message.op}@${target}`);
      }) as unknown as Window["postMessage"];
    }
  }

  /** Builds the page (real timers: each iframe's about:blank load settles first), then fakes the clock. */
  async function setup(html = '<iframe id="a"></iframe><iframe id="b"></iframe>') {
    document.body.innerHTML = html;
    const frames = Array.from(document.getElementsByTagName("iframe"));
    await Promise.race([
      Promise.all(frames.map((f) => new Promise((resolve) => f.addEventListener("load", resolve, { once: true })))),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    stubFrames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T0);
  }

  const frame = (id: string) => document.getElementById(id) as HTMLIFrameElement;
  const win = (id: string) => frame(id).contentWindow as Window;

  function start(sessionReplay: SessionReplayOptions, debug = false) {
    stubFrames();
    init({ apiHost: API_HOST, token: "tok", loadFeatureFlags: false, flushIntervalMs: 0, debug, sessionReplay });
  }

  async function recording(times = 1) {
    await vi.waitFor(() => expect(rr.record).toHaveBeenCalledTimes(times));
  }

  /** `op` posted to each frame x each origin, in the bridge's order. */
  const matrix = (op: string, frames = ["a", "b"], origins = [PAY, OTHER]) =>
    frames.flatMap((f) => origins.map((o) => `${f}:${op}@${o}`));

  const recordOptions = (call: number) => rr.record.mock.calls[call][0] as unknown as Record<string, unknown>;

  /** A message as rrweb's relay in a child frame posts it. */
  const rrwebMessage = (origin: string, source: Window | null, event: unknown = {}) =>
    new MessageEvent("message", { data: { type: "rrweb", event, origin, isCheckout: false }, origin, source });

  /** The child's `ready`. */
  const readyMessage = (origin: string, source: Window | null) =>
    new MessageEvent("message", { data: { source: "cohorly-replay", v: 1, op: "ready" }, origin, source });

  function sentChunks(): { session_id: string; events: RrEvent[] }[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith(`${API_HOST}/replay`))
      .map(([, req]) => JSON.parse(String((req as { body: string }).body)));
  }

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    rr.record.mockClear();
    rr.state.snapshots = 0;
    posted = [];
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("CompressionStream", undefined);
    fetchMock = vi.fn(async () => new Response('{"status":1}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cohorly.optOutTracking();
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    if (parentDescriptor) Object.defineProperty(window, "parent", parentDescriptor);
    else delete (window as { parent?: unknown }).parent;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("without valid origins nothing changes: no rrweb iframe flag, no message or load listener, each bad item logged", async () => {
    await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listen = vi.spyOn(window, "addEventListener");
    const listenDocument = vi.spyOn(document, "addEventListener");
    start({ sampleRate: 1, allowedIframeOrigins: ["*", "https://pay.example.com/", "https://pay.example.com/x", ""] }, true);
    await recording();
    expect(recordOptions(0)).not.toHaveProperty("recordCrossOriginIframes");
    // Only the stand-in rrweb's own listener.
    expect(listen.mock.calls.filter(([type]) => type === "message" || type === "load")).toHaveLength(1);
    expect(listenDocument.mock.calls.filter(([type]) => type === "load")).toEqual([]);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes("allowedIframeOrigins"))).toHaveLength(4);
    frame("a").dispatchEvent(new Event("load"));
    window.dispatchEvent(readyMessage(PAY, win("a")));
    await vi.advanceTimersByTimeAsync(5000);
    expect(posted).toEqual([]);

    // The default: no list at all.
    start({ sampleRate: 1 });
    await recording(2);
    expect(recordOptions(1)).not.toHaveProperty("recordCrossOriginIframes");
    expect(posted).toEqual([]);
  });

  it("passes recordCrossOriginIframes only in the top frame, with the filter installed before record()", async () => {
    await setup();
    const listen = vi.spyOn(window, "addEventListener");
    start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
    await recording();
    expect(recordOptions(0)).toMatchObject({ recordCrossOriginIframes: true });
    const filter = listen.mock.calls.findIndex(([type, , capture]) => type === "message" && capture === true);
    expect(filter).toBeGreaterThanOrEqual(0);
    expect(listen.mock.invocationCallOrder[filter]).toBeLessThan(rr.record.mock.invocationCallOrder[0]);

    // In a child frame the flag would make rrweb forward to the parent instead of emitting.
    Object.defineProperty(window, "parent", { configurable: true, get: () => win("a") });
    listen.mockClear();
    start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
    await recording(2);
    expect(recordOptions(1)).not.toHaveProperty("recordCrossOriginIframes");
    expect(listen.mock.calls.some(([type, , capture]) => type === "message" && capture === true)).toBe(false);
  });

  it("stops rrweb messages from unlisted origins or from windows that are not an <iframe> of the page, and only those", async () => {
    await setup();
    start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
    await recording();
    // Registered after the SDK's filter, like rrweb's own listener.
    const reached: unknown[] = [];
    const rrwebListener = (event: MessageEvent) => reached.push(event.data);
    window.addEventListener("message", rrwebListener);

    window.dispatchEvent(rrwebMessage(PAY, win("a")));
    expect(reached).toHaveLength(1);
    window.dispatchEvent(rrwebMessage(EVIL, win("a")));
    window.dispatchEvent(rrwebMessage(PAY, window)); // not an iframe's window
    window.dispatchEvent(rrwebMessage(PAY, null));
    const detached = document.createElement("iframe");
    document.body.append(detached);
    const removedWindow = detached.contentWindow;
    detached.remove();
    window.dispatchEvent(rrwebMessage(PAY, removedWindow)); // no longer an <iframe> of the document
    expect(reached).toHaveLength(1);

    // Anything that is not an rrweb message is never touched.
    window.dispatchEvent(new MessageEvent("message", { data: { type: "app" }, origin: EVIL, source: window }));
    window.dispatchEvent(new MessageEvent("message", { data: "hello", origin: EVIL }));
    expect(reached).toHaveLength(3);

    // Removed when the recording stops.
    cohorly.optOutTracking();
    window.dispatchEvent(rrwebMessage(EVIL, win("a")));
    expect(reached).toHaveLength(4);
    window.removeEventListener("message", rrwebListener);
  });

  it("asks each iframe once per listed origin after record(), every checkout, iframe load, rotation and restart; stop when it ends", async () => {
    await setup();
    start({ sampleRate: 0, onErrorSampleRate: 1, allowedIframeOrigins: [PAY, OTHER] });
    await recording();
    // record()'s own full snapshot, then right after record() returned.
    expect(posted).toEqual([...matrix("snapshot"), ...matrix("snapshot")]);

    // Error-mode checkout.
    posted = [];
    rr.state.emit?.(click(1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rr.state.snapshots).toBe(2);
    expect(posted).toEqual(matrix("snapshot"));

    // An iframe (re)load: only that one.
    posted = [];
    frame("b").dispatchEvent(new Event("load"));
    expect(posted).toEqual(matrix("snapshot", ["b"]));

    // Session rotation (reset()) restarts the recorder: no stop in between.
    posted = [];
    cohorly.reset();
    await vi.advanceTimersByTimeAsync(0);
    await recording(2);
    expect(posted).toEqual([...matrix("snapshot"), ...matrix("snapshot")]);

    // A restart of the recording (re-init on the same page): stop from the old one, snapshots from the new.
    posted = [];
    start({ sampleRate: 0, onErrorSampleRate: 1, allowedIframeOrigins: [PAY, OTHER] });
    await recording(3);
    expect(posted).toEqual([...matrix("stop"), ...matrix("snapshot"), ...matrix("snapshot")]);

    // Stopped for good.
    posted = [];
    cohorly.optOutTracking();
    expect(posted).toEqual(matrix("stop"));
    frame("a").dispatchEvent(new Event("load"));
    expect(posted).toEqual(matrix("stop"));
  });

  it("never asks or hears an <iframe> the parent blocks, directly or through an ancestor", async () => {
    await setup(`
      <iframe id="a" class="secret"></iframe>
      <div data-cohorly-block><iframe id="b"></iframe></div>
      <div class="rr-block"><iframe id="c"></iframe></div>
      <iframe id="d"></iframe>`);
    start({ sampleRate: 1, allowedIframeOrigins: [PAY], blockSelector: ".secret" });
    await recording();
    expect(posted).toEqual([`d:snapshot@${PAY}`, `d:snapshot@${PAY}`]);

    posted = [];
    const reached: string[] = [];
    const rrwebListener = (event: MessageEvent) => {
      const data = event.data as { type?: string; origin?: string };
      if (data.type === "rrweb") reached.push(String(data.origin));
    };
    window.addEventListener("message", rrwebListener);
    for (const id of ["a", "b", "c", "d"]) {
      frame(id).dispatchEvent(new Event("load"));
      window.dispatchEvent(readyMessage(PAY, win(id)));
      window.dispatchEvent(rrwebMessage(PAY, win(id), attachEvent()));
    }
    expect(posted).toEqual([`d:snapshot@${PAY}`, `d:snapshot@${PAY}`]);
    expect(reached).toEqual([PAY]); // only d's message reached rrweb
    window.removeEventListener("message", rrwebListener);

    // A blockSelector the browser rejects: every iframe counts as blocked.
    posted = [];
    start({ sampleRate: 1, allowedIframeOrigins: [PAY], blockSelector: "a[[" });
    await recording(2);
    expect(posted).toEqual([`d:stop@${PAY}`]); // the old recording's stop, nothing asked by the new one
    posted = [];
    frame("d").dispatchEvent(new Event("load"));
    window.dispatchEvent(readyMessage(PAY, win("d")));
    expect(posted).toEqual([]);
  });

  it("tells every frame it asked to stop, even one blocked since", async () => {
    await setup();
    start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
    await recording();
    frame("a").setAttribute("data-cohorly-block", "");
    posted = [];
    cohorly.optOutTracking();
    expect(posted).toEqual([`a:stop@${PAY}`, `b:stop@${PAY}`]);
  });

  it("answers a child's ready with a snapshot request to that frame and origin only, while recording", async () => {
    await setup();
    start({ sampleRate: 1, allowedIframeOrigins: [PAY, OTHER] });
    await recording();
    posted = [];
    window.dispatchEvent(readyMessage(OTHER, win("b")));
    expect(posted).toEqual([`b:snapshot@${OTHER}`]);

    posted = [];
    window.dispatchEvent(readyMessage(EVIL, win("a"))); // unlisted origin
    window.dispatchEvent(readyMessage(PAY, window)); // not an iframe
    window.dispatchEvent(readyMessage(PAY, null));
    window.dispatchEvent(new MessageEvent("message", { data: { source: "cohorly-replay", v: 2, op: "ready" }, origin: PAY, source: win("a") }));
    expect(posted).toEqual([]);

    // Not recording any more.
    cohorly.optOutTracking();
    posted = [];
    window.dispatchEvent(readyMessage(PAY, win("a")));
    expect(posted).toEqual([]);
  });

  it("an idle expiry keeps the iframes relaying; an interaction inside one wakes the session like one here", async () => {
    await setup();
    start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
    await recording();
    await vi.advanceTimersByTimeAsync(5000);
    const firstSession = sentChunks()[0].session_id;
    posted = [];
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(posted).toEqual([]); // no stop

    // Not an interaction, or from an unlisted origin: still asleep.
    window.dispatchEvent(rrwebMessage(PAY, win("a"), attachEvent()));
    window.dispatchEvent(rrwebMessage(EVIL, win("a"), click(5)));
    await vi.advanceTimersByTimeAsync(0);
    expect(rr.record).toHaveBeenCalledTimes(1);

    window.dispatchEvent(rrwebMessage(PAY, win("a"), click(5)));
    await recording(2);
    expect(posted).toEqual([...matrix("snapshot", ["a", "b"], [PAY]), ...matrix("snapshot", ["a", "b"], [PAY])]);
    await vi.advanceTimersByTimeAsync(5000);
    const woken = sentChunks().filter((c) => c.session_id !== firstSession);
    expect(woken.length).toBeGreaterThan(0);
    expect(woken[0].events.map((e) => e.type).slice(0, 2)).toEqual([4, 2]);
  });

  it("an interaction relayed by an iframe during a rotation is never carried into the new session", async () => {
    await setup();
    start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
    await recording();
    await vi.advanceTimersByTimeAsync(5000);
    const firstSession = sentChunks()[0].session_id;
    // Idle past the timeout, before the tick notices: both interactions arrive under the old recorder.
    vi.setSystemTime(Date.now() + 31 * 60_000);
    window.dispatchEvent(rrwebMessage(PAY, win("a"), click(222)));
    rr.state.emit?.(click(111));
    await vi.advanceTimersByTimeAsync(0);
    await recording(2);
    await vi.advanceTimersByTimeAsync(5000);
    const next = sentChunks().filter((c) => c.session_id !== firstSession);
    const ids = next.flatMap((c) => c.events.map((e) => e.data.id));
    expect(ids).toContain(111);
    expect(ids).not.toContain(222);
  });

  it("in the error buffer only a relayed attach is page state; a same-origin iframe's attach stays activity", async () => {
    await setup();
    start({ sampleRate: 0, onErrorSampleRate: 1, allowedIframeOrigins: [PAY] });
    await recording();
    window.dispatchEvent(rrwebMessage(PAY, win("a"), attachEvent()));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rr.state.snapshots).toBe(1); // not dirty: no checkout

    // The same mutation outside a relayed message (a same-origin iframe loading): dirty, as before VEL-2152.
    rr.state.emit?.(attachEvent());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rr.state.snapshots).toBe(2);

    // Without the option, unchanged too.
    start({ sampleRate: 0, onErrorSampleRate: 1 });
    await recording(2);
    const before = rr.state.snapshots;
    rr.state.emit?.(attachEvent());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rr.state.snapshots).toBe(before + 1);
  });

  it("a relayed attach in the error buffer is stamped at the window start with the snapshot and sends nothing on its own", async () => {
    await setup();
    start({ sampleRate: 0, onErrorSampleRate: 1, allowedIframeOrigins: [PAY] });
    await recording();
    window.dispatchEvent(rrwebMessage(PAY, win("a"), attachEvent()));

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    rr.state.emit?.(click(999));
    const now = Date.now();
    cohorly.captureException(new Error("boom"));
    await vi.advanceTimersByTimeAsync(0);
    const [first] = sentChunks();
    expect(first.events.map((e) => e.type)).toEqual([4, 2, 3, 3]);
    expect(first.events[2].data.isAttachIframe).toBe(true);
    // In the snapshot's lead: moved to the window start like the rest of it.
    expect(first.events.slice(0, 3).every((e) => e.timestamp === now - 60_000)).toBe(true);
    expect(first.events[3].timestamp).toBe(now);

    // After the send, only an iframe attach (a reload of the iframe): nothing new to send.
    await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(rrwebMessage(PAY, win("a"), attachEvent()));
    cohorly.captureException(new Error("again"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sentChunks()).toHaveLength(1);
  });

  describe("same-origin iframe windows (rrweb listens there too, without an origin check)", () => {
    /** An rrweb message as a nested cross-origin frame would post it to the same-origin iframe's window. */
    const post = (target: Window, data: unknown, origin = EVIL, Ctor = (target as unknown as typeof globalThis).MessageEvent): boolean => {
      target.dispatchEvent(new Ctor("message", { data, origin }));
      return true;
    };
    /**
     * Listens like rrweb's IframeManager on an attached iframe's window: capturing
     * too, so only a filter registered before it runs first. Register it right
     * after the attach emit, the order rrweb's attachIframe keeps.
     */
    const listenOn = (target: Window): unknown[] => {
      const reached: unknown[] = [];
      target.addEventListener("message", (event) => reached.push((event as MessageEvent).data), true);
      return reached;
    };
    const forged = { type: "rrweb", event: { type: 2, timestamp: 1, data: {} }, origin: EVIL, isCheckout: false };

    /** A new <iframe> appended to `parent`'s body, loaded. */
    async function addFrame(parent: Document, id: string): Promise<HTMLIFrameElement> {
      const f = parent.createElement("iframe");
      f.id = id;
      const loaded = new Promise((resolve) => f.addEventListener("load", resolve, { once: true }));
      parent.body.append(f);
      await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 100))]);
      return f;
    }

    it("stops an rrweb message from any origin in a recorded same-origin iframe, and nothing else", async () => {
      await setup();
      start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
      await recording();
      const reached = listenOn(win("a"));

      post(win("a"), forged);
      post(win("a"), { ...forged, origin: PAY }, PAY); // a listed origin is no exception below the top window
      expect(reached).toEqual([]);

      // Not an rrweb message: never touched (the relay's own too).
      post(win("a"), { type: "app" });
      post(win("a"), "hello");
      post(win("a"), null);
      post(win("a"), { source: "cohorly-replay", v: 1, op: "ready" }, PAY);
      expect(reached).toHaveLength(4);
    });

    it("does not let a forged event reach the recording", async () => {
      await setup();
      start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
      await recording();
      // Like rrweb's IframeManager: a handler on the iframe's window that emits what it is sent.
      win("a").addEventListener("message", (event) => {
        const data = (event as MessageEvent).data as { type?: unknown; event?: unknown } | null;
        if (data?.type === "rrweb") rr.state.emit?.({ ...(data.event as object), data: { id: 4242 } });
      });
      post(win("a"), { ...forged, event: { type: 3, timestamp: Date.now(), data: { source: 2, type: 2, id: 4242 } } });
      await vi.advanceTimersByTimeAsync(5000);
      const ids = sentChunks().flatMap((c) => c.events.map((e) => e.data.id));
      expect(ids).not.toContain(4242);
    });

    it("covers an iframe that was replaced (new window) once rrweb emits its attach", async () => {
      await setup();
      start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
      await recording();
      frame("a").remove();
      const fresh = await addFrame(document, "a2");
      stubFrames();
      rr.state.emit?.(attachEvent()); // what rrweb emits when the new iframe loads, before it listens there
      const reached = listenOn(fresh.contentWindow as Window);
      post(fresh.contentWindow as Window, forged);
      expect(reached).toEqual([]);
    });

    it("covers a reloaded iframe (same element, new window) once rrweb emits its attach", async () => {
      await setup();
      start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
      await recording();
      const element = frame("a");
      const before = element.contentWindow;
      const reloaded = new Promise((resolve) => element.addEventListener("load", resolve, { once: true }));
      element.remove();
      document.body.append(element);
      await Promise.race([reloaded, vi.advanceTimersByTimeAsync(100)]);
      expect(element.contentWindow).not.toBe(before);
      rr.state.emit?.(attachEvent());
      const reached = listenOn(element.contentWindow as Window);
      post(element.contentWindow as Window, forged);
      expect(reached).toEqual([]);
    });

    it("covers a same-origin iframe inside an open shadow root", async () => {
      await setup();
      const host = document.createElement("div");
      document.body.append(host);
      const inShadow = document.createElement("iframe");
      host.attachShadow({ mode: "open" }).append(inShadow);
      // jsdom gives an iframe in a shadow root no browsing context: a same-origin one, stood in for.
      const shadowWin = new EventTarget() as unknown as Window;
      Object.defineProperty(inShadow, "contentWindow", { value: shadowWin });
      Object.defineProperty(inShadow, "contentDocument", { value: document.implementation.createHTMLDocument() });
      start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
      await recording();
      const reached = listenOn(shadowWin);
      post(shadowWin, forged, EVIL, MessageEvent);
      expect(reached).toEqual([]);
    });

    it("recurses: a same-origin iframe nested in another is guarded too", async () => {
      await setup();
      const outer = frame("a");
      const inner = await addFrame(outer.contentDocument as Document, "inner");
      start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
      await recording();
      const reached = listenOn(inner.contentWindow as Window);
      post(inner.contentWindow as Window, forged);
      expect(reached).toEqual([]);
      post(inner.contentWindow as Window, { type: "app" });
      expect(reached).toHaveLength(1);
    });

    it("removes every filter when the recording stops", async () => {
      await setup();
      start({ sampleRate: 1, allowedIframeOrigins: [PAY] });
      await recording();
      const reached = listenOn(win("a"));
      post(win("a"), forged);
      expect(reached).toEqual([]);

      cohorly.optOutTracking();
      post(win("a"), forged);
      expect(reached).toHaveLength(1);
    });

    it("installs no filter without allowedIframeOrigins", async () => {
      await setup();
      start({ sampleRate: 1 });
      await recording();
      rr.state.emit?.(attachEvent());
      const reached = listenOn(win("a"));
      post(win("a"), forged);
      expect(reached).toHaveLength(1);
    });
  });
});
