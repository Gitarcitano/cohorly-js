import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cohorly, init } from "../src/index.js";
import type { IframeRelay, IframeRelayDeps } from "../src/replay/relay.js";
import { normalizeIframeOrigins, startIframeRelay } from "../src/replay/relay.js";
import { recordOptions } from "../src/replay/replay.js";
import { SESSION_KEY } from "../src/replay/session.js";

// Child side of cross-origin iframe recording (VEL-2152). jsdom runs the test
// in the top frame, so the parent window is another real window (an
// iframe's) and the cross-origin check is injected.
const PARENT = "https://shop.example.com";
const PARENT_2 = "https://shop.example.org";

describe("allowedIframeOrigins normalization", () => {
  it("keeps only exact http(s) origins, logging each ignored item", () => {
    const log = vi.fn();
    const origins = normalizeIframeOrigins(
      [
        "https://pay.example.com",
        "http://127.0.0.1:4173",
        "https://pay.example.com", // duplicate, kept once
        "*",
        "https://pay.example.com/", // trailing slash
        "https://pay.example.com/checkout",
        "HTTPS://PAY.EXAMPLE.COM",
        "ftp://files.example.com",
        "",
        42,
      ],
      log,
    );
    expect(origins).toEqual(["https://pay.example.com", "http://127.0.0.1:4173"]);
    expect(log).toHaveBeenCalledTimes(7);
    expect(normalizeIframeOrigins(undefined, log)).toEqual([]);
    expect(normalizeIframeOrigins("https://pay.example.com", log)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(8);
  });
});

describe("iframe relay (child)", () => {
  let parentFrame: HTMLIFrameElement;
  let parent: Window;
  let relay: IframeRelay | null;
  let stops: number;
  const takeFullSnapshot = vi.fn();
  const record = Object.assign(
    vi.fn((_options: Record<string, unknown>) => () => {
      stops += 1;
    }),
    { takeFullSnapshot },
  );
  const load = vi.fn(async () => ({ recordOptions, loadRecorder: async () => ({ record }) }));
  const suspend = vi.fn();
  const resume = vi.fn();

  function startRelay(overrides: Partial<IframeRelayDeps> = {}): IframeRelay | null {
    relay = startIframeRelay({
      // Both rates at 0: the parent decides, the child relays anyway.
      options: { sampleRate: 0, onErrorSampleRate: 0, maskTextSelector: ".pii", blockSelector: ".card" },
      origins: [PARENT],
      load,
      suspend,
      resume,
      log: () => {},
      parent,
      parentIsCrossOrigin: () => true,
      ...overrides,
    });
    return relay;
  }

  const request = (op: string, { origin = PARENT, source = parent as Window | null, v = 1, from = "cohorly-replay" } = {}) =>
    window.dispatchEvent(new MessageEvent("message", { data: { source: from, v, op }, origin, source }));

  beforeEach(() => {
    document.body.innerHTML = '<iframe id="parent"></iframe>';
    parentFrame = document.getElementById("parent") as HTMLIFrameElement;
    parent = parentFrame.contentWindow as Window;
    stops = 0;
    relay = null;
    for (const fn of [record, takeFullSnapshot, load, suspend, resume]) fn.mockClear();
  });

  afterEach(() => {
    relay?.dispose();
    document.body.innerHTML = "";
  });

  it("installs nothing without origins, in the top frame, or under a same-origin parent", () => {
    const listen = vi.spyOn(window, "addEventListener");
    expect(startRelay({ origins: [] })).toBeNull();
    expect(startRelay({ parent: window })).toBeNull();
    expect(startRelay({ parentIsCrossOrigin: () => false })).toBeNull();
    expect(listen.mock.calls.filter(([type]) => type === "message")).toEqual([]);
    listen.mockRestore();
  });

  it("ignores requests from another window, an unlisted origin, or that are not a v1 cohorly-replay message", async () => {
    startRelay();
    request("snapshot", { source: window });
    request("snapshot", { source: null });
    request("snapshot", { origin: "https://evil.example.com" });
    request("snapshot", { from: "rrweb" });
    request("snapshot", { v: 2 });
    request("record");
    request("ready"); // child to parent only
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("first snapshot: suspends its own recording and records with its own masking for the parent; later ones take a checkout; stop resumes", async () => {
    startRelay();
    request("snapshot");
    expect(suspend).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    const options = record.mock.calls[0][0];
    expect(options).toMatchObject({
      recordCrossOriginIframes: true,
      maskTextSelector: "[data-cohorly-mask], .pii",
      blockSelector: "[data-cohorly-block], .card",
      maskInputOptions: { text: true, password: true, hidden: true },
    });
    expect(options).not.toHaveProperty("emit"); // rrweb posts to window.parent itself

    // Checkout, session rotation or recorder restart in the parent: a new snapshot.
    request("snapshot");
    request("snapshot");
    expect(takeFullSnapshot.mock.calls).toEqual([[true], [true]]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);

    request("stop");
    expect(stops).toBe(1);
    expect(resume).toHaveBeenCalledTimes(1);
    request("stop"); // already stopped
    expect(resume).toHaveBeenCalledTimes(1);

    // The parent records again: a fresh record().
    request("snapshot");
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(suspend).toHaveBeenCalledTimes(2);
  });

  it("tells window.parent it is ready, once per listed origin and never to \"*\", every time it starts", () => {
    const post = vi.spyOn(parent, "postMessage").mockImplementation(() => {});
    startRelay({ origins: [PARENT, PARENT_2] });
    expect(post.mock.calls).toEqual([
      [{ source: "cohorly-replay", v: 1, op: "ready" }, PARENT],
      [{ source: "cohorly-replay", v: 1, op: "ready" }, PARENT_2],
    ]);
    relay?.dispose();
    startRelay({ origins: [PARENT] });
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2]).toEqual([{ source: "cohorly-replay", v: 1, op: "ready" }, PARENT]);
  });

  it("a stop while rrweb is still loading never starts it", async () => {
    startRelay();
    request("snapshot");
    request("stop");
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(record).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("dispose (re-init, opt-out) stops relaying and listening without resuming", async () => {
    startRelay();
    request("snapshot");
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    relay?.dispose();
    relay = null;
    expect(stops).toBe(1);
    expect(resume).not.toHaveBeenCalled();
    request("snapshot");
    expect(takeFullSnapshot).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledTimes(1);
  });
});

describe("iframe relay through init() (child)", () => {
  const parentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
  let posted: [unknown, string][];

  beforeEach(() => {
    posted = [];
    // The previous test's afterEach opted out, and that persists.
    window.localStorage.clear();
    window.sessionStorage.clear();
    // A parent on another origin: reading its document throws, like the browser's SecurityError.
    const crossOriginParent = {
      postMessage: (message: unknown, target: string) => posted.push([message, target]),
      get document(): Document {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      },
    };
    Object.defineProperty(window, "parent", { configurable: true, get: () => crossOriginParent });
  });

  afterEach(() => {
    cohorly.optOutTracking();
    if (parentDescriptor) Object.defineProperty(window, "parent", parentDescriptor);
    else delete (window as { parent?: unknown }).parent;
    init({ apiHost: "https://ingest.example.com", loadFeatureFlags: false, flushIntervalMs: 0 });
  });

  const start = (allowedIframeOrigins: string[]) =>
    init({
      apiHost: "https://ingest.example.com",
      token: "tok",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      sessionReplay: { sampleRate: 0, onErrorSampleRate: 0, allowedIframeOrigins },
    });

  /** A request from the cross-origin parent (jsdom only takes a real window as `source`: set it on the event). */
  const fromParent = (op: "snapshot" | "stop") => {
    const event = new MessageEvent("message", { data: { source: "cohorly-replay", v: 1, op }, origin: PARENT });
    Object.defineProperty(event, "source", { value: window.parent });
    window.dispatchEvent(event);
  };

  const ownSession = () => window.sessionStorage.getItem(SESSION_KEY);

  /** A sampled child (its own recording on) whose parent then starts relaying it. */
  async function sampledChildRelaying(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("CompressionStream", undefined); // plain JSON bodies
    init({
      apiHost: "https://ingest.example.com",
      token: "tok",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      sessionReplay: { sampleRate: 1, allowedIframeOrigins: [PARENT] },
    });
    await vi.waitFor(() => expect(ownSession()).not.toBeNull());
    // rrweb loaded and took its first snapshot: the own recorder has pending events.
    await new Promise((resolve) => setTimeout(resolve, 200));
    fromParent("snapshot");
  }

  it("a reset() while relaying makes the resumed recording a new session, never the outgoing identity's", async () => {
    await sampledChildRelaying(vi.fn(async () => new Response("{}", { status: 200 })));
    const before = JSON.parse(ownSession() ?? "{}").id as string;
    cohorly.reset();
    fromParent("stop");
    await vi.waitFor(() => expect(ownSession()).not.toBeNull());
    expect(JSON.parse(ownSession() ?? "{}").id).not.toBe(before);
    vi.unstubAllGlobals();
  });

  it("an opt-out while relaying drops the suspended recording's queue: a later init() never sends it", { timeout: 15_000 }, async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    await sampledChildRelaying(fetchMock);
    const before = JSON.parse(ownSession() ?? "{}").id as string;
    cohorly.optOutTracking();
    await new Promise((resolve) => setTimeout(resolve, 50));
    cohorly.optInTracking();
    window.sessionStorage.clear();
    init({
      apiHost: "https://ingest.example.com",
      token: "tok",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      sessionReplay: { sampleRate: 1 },
    });
    const sentSessions = () =>
      (fetchMock.mock.calls as unknown as [string, { body: string }][])
        .filter(([url]) => String(url).includes("/replay"))
        .map(([, req]) => (JSON.parse(String(req.body)) as { session_id: string }).session_id);
    // The new recording goes out (one flush interval), and nothing of the suspended one with it.
    await vi.waitFor(() => expect(sentSessions().length).toBeGreaterThan(0), { timeout: 8000 });
    expect(sentSessions()).not.toContain(before);
    vi.unstubAllGlobals();
  });

  it("an init() after the parent's requests (or a re-init) posts ready to each listed origin", () => {
    start([PARENT, PARENT_2, "*"]);
    const ready = { source: "cohorly-replay", v: 1, op: "ready" };
    expect(posted).toEqual([
      [ready, PARENT],
      [ready, PARENT_2],
    ]);
    start([PARENT]);
    expect(posted).toEqual([
      [ready, PARENT],
      [ready, PARENT_2],
      [ready, PARENT],
    ]);
    // No list: nothing posted.
    start([]);
    expect(posted).toHaveLength(3);
  });
});
