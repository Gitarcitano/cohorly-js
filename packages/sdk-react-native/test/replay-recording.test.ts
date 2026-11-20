import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeModuleBag } from "../src/deviceInfo.js";

const native = vi.hoisted(() => ({ bag: {} as Record<string, unknown> }));
vi.mock("../src/deviceInfo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deviceInfo.js")>();
  return { ...actual, loadNativeModules: () => native.bag as NativeModuleBag };
});

import type { ErrorInfo } from "react";
import { CohorlyClient } from "../src/client.js";
import { teardownExceptionCapture } from "../src/exceptions/handlers.js";
import { CohorlyErrorBoundary, init } from "../src/index.js";
import { MAX_CHUNK_BYTES, MAX_CHUNK_EVENTS } from "../src/replay/chunks.js";
import { replayStorageKey } from "../src/replay/session.js";
import type { CohorlyOptions } from "../src/types.js";
import { LIB_VERSION } from "../src/version.js";
import { FakeStorage } from "./helpers.js";
import {
  advance,
  deferred,
  fakeAppState,
  fakeReplayModule,
  full,
  HeldStorage,
  meta,
  type ReplayRequest,
  type RrEvent,
  replayFetch,
  settle,
  touch,
  useClock,
} from "./replay-helpers.js";

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const g = globalThis as Record<string, unknown>;
const clients: CohorlyClient[] = [];

beforeEach(() => useClock(T0));
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  teardownExceptionCapture();
  delete g.ErrorUtils;
  delete g.__DEV__;
  vi.useRealTimers();
  vi.restoreAllMocks();
  native.bag = {};
});

function link(replay = fakeReplayModule()) {
  native.bag = { rn: { NativeModules: { CohorlyReactNativeReplay: replay.mod } } };
  return replay;
}

async function makeClient(
  options: Partial<CohorlyOptions> = {},
  respond?: (n: number, request: ReplayRequest) => Response | Promise<Response>,
) {
  const net = replayFetch(respond);
  const appState = fakeAppState();
  const storage = (options.storage as FakeStorage | undefined) ?? new FakeStorage();
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "proj_test",
    fetch: net.fetchImpl,
    flushInterval: 600_000,
    flushAt: 1000,
    loadFeatureFlags: false,
    platformInfo: { os: "iOS" },
    appState,
    sessionReplay: { sampleRate: 1 },
    ...options,
    storage,
  });
  clients.push(client);
  await client.ready;
  await client.exceptionsReady;
  await settle();
  const sent = async () => {
    await client.flush();
    await settle();
    return net.tracked;
  };
  return { client, storage, appState, sent, ...net };
}

const quotaRefusal = () =>
  new Response(JSON.stringify({ status: 0, error: "replay quota exceeded" }), {
    status: 429,
    headers: { "retry-after": "3600" },
  });

/** The controller's outbox and error buffer (private), to prove what opt-out drops. */
const internals = (client: CohorlyClient) =>
  (client as unknown as { replay: { sender: { pending: readonly unknown[] }; buffer: { size: number } } }).replay;

/** A FullSnapshot larger than a whole chunk body. */
const hugeFull = (timestamp: number): RrEvent => ({
  type: 2,
  timestamp,
  data: { wireframes: [{ base64: "b".repeat(1_000_000) }] },
});

const errorEvent = (timestamp: number) => ({ type: 5, timestamp, data: { tag: "error", payload: {} } });

/** An image mutation whose JSON is about `size` bytes. */
const image = (timestamp: number, size: number): RrEvent => ({
  type: 3,
  timestamp,
  data: { source: 0, adds: [{ parentId: 5, wireframe: { id: 10000001, type: "image", base64: "a".repeat(size) } }] },
});

describe("session draw", () => {
  it.each([
    [{ sampleRate: 1 }, '{"mode":"screenshot","maskAllImages":true}'],
    [{ sampleRate: 1, mode: "wireframe", maskAllImages: false }, '{"mode":"wireframe","maskAllImages":false}'],
  ] as const)("starts the recorder once with both config keys (%o)", async (sessionReplay, json) => {
    const replay = link();
    await makeClient({ sessionReplay });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    expect(replay.mod.replayStart).toHaveBeenCalledWith(json);
  });

  it("uploads what it drains every 5 s as uncompressed react-native JSON chunks with a persisted, increasing seq", async () => {
    const replay = link();
    const first = await makeClient();
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(4999);
    expect(first.replays).toHaveLength(0);
    await advance(1);
    expect(first.replays).toHaveLength(1);

    first.client.track("E");
    const [event] = (await first.sent()).filter((e) => e.event === "E");
    const [request] = first.replays;
    expect(request.url).toBe("http://localhost:4000/replay");
    expect(request.headers["x-cohorly-token"]).toBe("proj_test");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers).not.toHaveProperty("content-encoding");
    expect(request.body).toEqual({
      session_id: event.properties.$session_id,
      distinct_id: first.client.getDistinctId(),
      seq: 0,
      mode: "session",
      lib: "react-native",
      lib_version: LIB_VERSION,
      events: [meta(T0), full(T0), touch(T0 + 100)],
    });

    replay.capture(touch(T0 + 6000));
    await advance(5000);
    expect(first.replays.map((r) => r.body.seq)).toEqual([0, 1]);

    // A relaunch inside the session goes on from the persisted seq.
    first.client.stop();
    await settle();
    const relaunched = link();
    const second = await makeClient({ storage: first.storage });
    relaunched.capture(meta(Date.now()), full(Date.now()));
    await advance(5000);
    expect(second.replays.map((r) => [r.body.session_id, r.body.seq])).toEqual([[event.properties.$session_id, 2]]);
  });

  it("drains at once when the app goes to background and on a captured exception, and sends no error-mode chunk", async () => {
    const replay = link();
    const { client, appState, replays } = await makeClient();
    replay.capture(meta(T0), full(T0));
    appState.emit("background");
    await settle();
    expect(replays).toHaveLength(1);

    appState.emit("active");
    replay.capture(touch(T0 + 10));
    client.captureException(new Error("boom"));
    await settle();
    expect(replays).toHaveLength(2);
    expect(replays.map((r) => r.body.mode)).toEqual(["session", "session"]);
  });

  it("keeps every chunk under 900 KB and 1000 events, in order, and drops an event too large to ever send", async () => {
    const replay = link();
    const { replays } = await makeClient();
    const touches = Array.from({ length: 1500 }, (_, i) => touch(T0 + 10 + i));
    const big = [image(T0 + 1, 600_000), image(T0 + 2, 600_000)];
    replay.capture(meta(T0), full(T0), ...big);
    replay.capture(...touches);
    await advance(5000);
    // The two images cannot share a chunk, and 1500 touches cannot fit one.
    expect(replays.length).toBeGreaterThanOrEqual(3);
    for (const r of replays) {
      expect(Buffer.byteLength(r.raw)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(r.body.events.length).toBeLessThanOrEqual(MAX_CHUNK_EVENTS);
    }
    expect(replays.flatMap((r) => r.body.events)).toEqual([meta(T0), full(T0), ...big, ...touches]);
    expect(replays.map((r) => r.body.seq)).toEqual(replays.map((_, i) => i));

  });

  it("drops a Meta + FullSnapshot pair too large to send and every mutation after it until a snapshot that fits", async () => {
    const replay = link();
    const { replays } = await makeClient();
    replay.capture(meta(T0), full(T0));
    await advance(5000);
    const before = replays.length;
    const checkouts = replay.mod.replayCheckout.mock.calls.length;
    replay.capture(meta(T0 + 6000), hugeFull(T0 + 6000));
    replay.capture(touch(T0 + 6100));
    await advance(5000);
    replay.capture(touch(T0 + 11_000)); // a later drain: still against the unsent screen
    await advance(5000);
    expect(replays.slice(before)).toHaveLength(0);
    // Never retried, and a new snapshot is asked for once.
    expect(replay.mod.replayCheckout.mock.calls.length).toBe(checkouts + 1);
    replay.capture(meta(T0 + 16_000), full(T0 + 16_000), touch(T0 + 16_100));
    await advance(5000);
    expect(replays.slice(before).flatMap((r) => r.body.events)).toEqual([
      meta(T0 + 16_000),
      full(T0 + 16_000),
      touch(T0 + 16_100),
    ]);
  });

  it("drops a mutation too large to send and every mutation after it until a new snapshot, and asks for one", async () => {
    const replay = link();
    const { replays } = await makeClient();
    replay.capture(meta(T0), full(T0));
    await advance(5000);
    const before = replays.length;
    const checkouts = replay.mod.replayCheckout.mock.calls.length;
    replay.capture(image(T0 + 6000, MAX_CHUNK_BYTES));
    replay.capture(touch(T0 + 6100)); // may reference what the lost mutation added
    await advance(5000);
    expect(replays.slice(before)).toHaveLength(0);
    expect(replay.mod.replayCheckout.mock.calls.length).toBe(checkouts + 1);
    replay.capture(meta(T0 + 11_000), full(T0 + 11_000), touch(T0 + 11_100));
    await advance(5000);
    expect(replays.slice(before).flatMap((r) => r.body.events)).toEqual([
      meta(T0 + 11_000),
      full(T0 + 11_000),
      touch(T0 + 11_100),
    ]);
  });

  it("a replaced client whose native start resolves late never stops its replacement's recording", async () => {
    const replay = link();
    const start = deferred<boolean>();
    replay.mod.replayStart.mockImplementationOnce(() => start.promise);
    const first = await makeClient();
    first.client.stop();
    await makeClient();
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(2);
    start.resolve(true);
    await settle();
    expect(replay.mod.replayStop).not.toHaveBeenCalled();
  });

  it("reset(): a drain still in flight goes under the old session and distinct id; the new session starts at a Meta + FullSnapshot", async () => {
    const replay = link();
    const { client, replays, sent } = await makeClient();
    client.track("Old");
    const oldSession = (await sent()).find((e) => e.event === "Old")?.properties.$session_id;
    const oldDistinct = client.getDistinctId();
    const drain = deferred<string[]>();
    replay.mod.replayDrain.mockImplementationOnce(() => drain.promise);
    await advance(5000); // the tick's drain is pending
    client.reset();
    drain.resolve([JSON.stringify([meta(T0), full(T0), touch(T0 + 100)])]);
    await settle();
    // Captured before the new session's snapshot: the old screen, never in the new session.
    replay.capture(touch(T0 + 5100));
    replay.capture(meta(T0 + 5200), full(T0 + 5200), touch(T0 + 5300));
    await advance(5000);

    expect(client.getDistinctId()).not.toBe(oldDistinct);
    expect(replays[0].body).toMatchObject({
      session_id: oldSession,
      distinct_id: oldDistinct,
      seq: 0,
      events: [meta(T0), full(T0), touch(T0 + 100)],
    });
    const fresh = replays.slice(1);
    for (const r of fresh) {
      expect(r.body.session_id).not.toBe(oldSession);
      expect(r.body.distinct_id).toBe(client.getDistinctId());
    }
    expect(fresh.flatMap((r) => r.body.events)).toEqual([meta(T0 + 5200), full(T0 + 5200), touch(T0 + 5300)]);
  });

  it("persists the seq a chunk carries before posting it", async () => {
    const replay = link();
    const storage = new HeldStorage();
    const key = replayStorageKey("proj_test");
    const storedSeqAtPost: number[] = [];
    const { replays } = await makeClient({ storage }, () => {
      storedSeqAtPost.push(JSON.parse(storage.store.get(key) as string).seq);
      return new Response("", { status: 200 });
    });
    storage.hold(key, "set");
    replay.capture(meta(T0), full(T0));
    await advance(5000);
    expect(replays).toHaveLength(0);
    storage.open();
    await settle();
    expect(replays.map((r) => r.body.seq)).toEqual([0]);
    expect(storedSeqAtPost).toEqual([1]);
  });
});

describe("error draw", () => {
  it("sends nothing without an exception, then the window from the newest usable snapshot, closed by an error event, under the $exception's $session_id", async () => {
    const replay = link();
    const { client, appState, replays, sent } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    replay.capture(meta(T0), full(T0, "first"), touch(T0 + 1000));
    await advance(40_000);
    // Activity since the snapshot: a checkout at 30 s.
    expect(replay.mod.replayCheckout).toHaveBeenCalledTimes(1);
    replay.capture(meta(T0 + 40_000), full(T0 + 40_000, "second"), touch(T0 + 50_000));
    await advance(35_000); // T0 + 75 s
    appState.emit("background");
    await settle();
    appState.emit("active");
    expect(replays).toHaveLength(0);

    const checkouts = replay.mod.replayCheckout.mock.calls.length;
    client.captureException(new Error("boom"));
    await settle();
    expect(replays).toHaveLength(1);
    const [exception] = (await sent()).filter((e) => e.event === "$exception");
    const { body } = replays[0];
    expect(body.mode).toBe("error");
    expect(body.session_id).toBe(exception.properties.$session_id);
    // The segment that started at 0 s had activity at 1 s, older than 60 s before the error.
    expect(body.events).toEqual([
      meta(T0 + 40_000),
      full(T0 + 40_000, "second"),
      touch(T0 + 50_000),
      { type: 5, timestamp: T0 + 75_000, data: { tag: "error", payload: {} } },
    ]);
    // Buffering goes on from a new snapshot.
    expect(replay.mod.replayCheckout.mock.calls.length).toBe(checkouts + 1);
  });

  it.each([
    ["a different screen", "second", 2],
    ["a checkout of the same screen", "first", 1],
  ])("after a send, %s alone decides whether the next exception sends again", async (_label, screen, sends) => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    replay.capture(meta(T0), full(T0, "first"), touch(T0 + 100));
    await advance(5000);
    client.captureException(new Error("one"));
    await settle();
    expect(replays).toHaveLength(1);
    // No touch: a programmatic navigation, or the checkout after the send.
    replay.capture(meta(T0 + 8000), full(T0 + 8000, screen));
    await advance(6000);
    client.captureException(new Error("two"));
    await settle();
    await advance(6000);
    expect(replays).toHaveLength(sends);
    if (sends === 2) expect(replays[1].body.events.slice(0, 2)).toEqual([meta(T0 + 8000), full(T0 + 8000, screen)]);
  });

  it("sends an idle screen's snapshot stamped at the start of the 60 s window", async () => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    replay.capture(meta(T0), full(T0));
    await advance(90_000);
    // Nothing happened on screen: no checkout was needed.
    expect(replay.mod.replayCheckout).not.toHaveBeenCalled();
    replay.capture(touch(T0 + 90_000));
    await advance(10_000); // T0 + 100 s
    client.captureException(new Error("boom"));
    await settle();
    expect(replays[0].body.events).toEqual([
      { ...meta(T0), timestamp: T0 + 40_000 },
      { ...full(T0), timestamp: T0 + 40_000 },
      touch(T0 + 90_000),
      { type: 5, timestamp: T0 + 100_000, data: { tag: "error", payload: {} } },
    ]);
  });

  it("sends at most once every 5 s: an exception inside the gap goes with the next send", async () => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    client.captureException(new Error("first"));
    await settle();
    expect(replays).toHaveLength(1);

    replay.capture(meta(T0 + 5000), full(T0 + 5000), touch(T0 + 5500));
    await advance(1000); // T0 + 6 s
    client.captureException(new Error("second"));
    await settle();
    expect(replays).toHaveLength(1);
    await advance(3999);
    expect(replays).toHaveLength(1);
    await advance(1);
    expect(replays).toHaveLength(2);
    expect(replays[1].body.events).toContainEqual(touch(T0 + 5500));
    expect(replays[1].body.events).not.toContainEqual(touch(T0 + 100));
    // The window and the error event take the second exception's time, not the send's.
    expect(replays[1].body.events.at(-1)).toEqual(errorEvent(T0 + 6000));
  });

  it("reset() right after an error waiting out the gap sends it under the old session; the new session's first error is not held by that gap", async () => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    const oldDistinct = client.getDistinctId();
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    client.captureException(new Error("first"));
    await settle();
    expect(replays).toHaveLength(1);
    const oldSession = replays[0].body.session_id;

    replay.capture(meta(T0 + 5000), full(T0 + 5000), touch(T0 + 5500));
    await advance(1000); // T0 + 6 s, inside the gap
    client.captureException(new Error("second"));
    await settle();
    expect(replays).toHaveLength(1);
    client.reset();
    await settle();
    expect(replays).toHaveLength(2);
    expect(replays[1].body).toMatchObject({ session_id: oldSession, distinct_id: oldDistinct, mode: "error" });
    expect(replays[1].body.events).toContainEqual(touch(T0 + 5500));
    expect(replays[1].body.events.at(-1)).toEqual(errorEvent(T0 + 6000));

    // Still inside 5 s of that send: the new session's error goes at once.
    replay.capture(meta(T0 + 6100), full(T0 + 6100), touch(T0 + 6200));
    client.captureException(new Error("third"));
    await settle();
    expect(replays).toHaveLength(3);
    expect(replays[2].body.mode).toBe("error");
    expect(replays[2].body.session_id).not.toBe(oldSession);
  });

  it("stamps the error event at the exception's time when the drain before the send is slow", async () => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    const drain = deferred<string[]>();
    replay.mod.replayDrain.mockImplementationOnce(() => drain.promise);
    client.captureException(new Error("boom")); // T0 + 5 s
    await settle();
    vi.setSystemTime(T0 + 9000);
    drain.resolve([]);
    await settle();
    expect(replays).toHaveLength(1);
    expect(replays[0].body.events.at(-1)).toEqual(errorEvent(T0 + 5000));
  });

  it("takes the checkout of a dirty buffer at 30 s, not before", async () => {
    const replay = link();
    await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(29_900);
    expect(replay.mod.replayCheckout).not.toHaveBeenCalled();
    await advance(100);
    expect(replay.mod.replayCheckout).toHaveBeenCalledTimes(1);
  });

  it("sends no recording for an exception beforeSendException drops", async () => {
    const replay = link();
    const { client, replays } = await makeClient({
      sessionReplay: { onErrorSampleRate: 1 },
      beforeSendException: () => null,
    });
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    client.captureException(new Error("dropped"));
    await advance(10_000);
    expect(replays).toHaveLength(0);
  });

  it("sends the recording of the $session_id the exception is recorded with, after beforeSendException", async () => {
    const replay = link();
    let live = "";
    const { client, replays, sent } = await makeClient({
      sessionReplay: { onErrorSampleRate: 1 },
      beforeSendException: (event) => ({ ...event, properties: { ...event.properties, $session_id: live } }),
    });
    client.track("E");
    live = (await sent()).find((e) => e.event === "E")?.properties.$session_id;
    expect(live).toEqual(expect.any(String));
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    // The caller's tag names a foreign session; the hook moves it to the live one.
    client.captureException(new Error("boom"), { tags: { $session_id: "foreign" } });
    await settle();
    expect(replays).toHaveLength(1);
    expect(replays[0].body.session_id).toBe(live);
  });

  it("a snapshot too large to send ships nothing: no error event without a snapshot", async () => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    replay.capture(meta(T0), hugeFull(T0), touch(T0 + 100));
    await advance(5000);
    client.captureException(new Error("boom"));
    await advance(10_000);
    expect(replays).toHaveLength(0);
  });

  it("an oversized snapshot in the window holds back its mutations; the window starts at the next one that fits", async () => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    replay.capture(meta(T0), hugeFull(T0), touch(T0 + 100));
    replay.capture(meta(T0 + 1000), full(T0 + 1000), touch(T0 + 1100));
    await advance(5000);
    client.captureException(new Error("boom"));
    await settle();
    expect(replays).toHaveLength(1);
    expect(replays[0].body.events).toEqual([
      meta(T0 + 1000),
      full(T0 + 1000),
      touch(T0 + 1100),
      errorEvent(T0 + 5000),
    ]);
  });

  it("sends the error-mode recording for an error CohorlyErrorBoundary catches", async () => {
    const replay = link();
    const net = replayFetch();
    const client = init({
      apiHost: "http://localhost:4000",
      token: "proj_test",
      storage: new FakeStorage(),
      fetch: net.fetchImpl,
      flushInterval: 600_000,
      loadFeatureFlags: false,
      platformInfo: { os: "iOS" },
      appState: fakeAppState(),
      sessionReplay: { onErrorSampleRate: 1 },
    });
    clients.push(client);
    await client.ready;
    await client.exceptionsReady;
    await settle();
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);

    // A child that throws while rendering, driven the way React does (see CohorlyErrorBoundary.test.ts).
    const Child = () => {
      throw new TypeError("render failed");
    };
    let error: unknown;
    try {
      Child();
    } catch (err) {
      error = err;
    }
    const boundary = new CohorlyErrorBoundary({ fallback: "Something went wrong" });
    boundary.setState = (update) => {
      boundary.state = { ...boundary.state, ...(update as object) };
    };
    boundary.state = CohorlyErrorBoundary.getDerivedStateFromError(error);
    boundary.componentDidCatch(error, { componentStack: "\n    in Child" } as ErrorInfo);
    await settle();

    expect(boundary.render()).toBe("Something went wrong");
    expect(net.replays).toHaveLength(1);
    expect(net.replays[0].body.mode).toBe("error");
    expect(net.replays[0].body.events.slice(0, 3)).toEqual([meta(T0), full(T0), touch(T0 + 100)]);
    expect(net.replays[0].body.events.at(-1)).toEqual(errorEvent(T0 + 5000));
  });

  it("sends nothing on an exception in a session that is not recorded, but still stamps $session_id", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9); // over both rates: none
    const replay = link();
    const { client, replays, sent } = await makeClient({ sessionReplay: { sampleRate: 0.5, onErrorSampleRate: 0.5 } });
    client.track("E");
    client.captureException(new Error("boom"));
    await advance(60_000);
    expect(replays).toHaveLength(0);
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    expect(replay.mod.replayDrain).not.toHaveBeenCalled();
    const events = await sent();
    expect(events.find((e) => e.event === "E")?.properties.$session_id).toEqual(expect.any(String));
  });
});

describe("fatal JS errors", () => {
  function installErrorUtils() {
    const previous = vi.fn();
    let handler: (error: unknown, isFatal?: boolean) => void = previous;
    g.ErrorUtils = {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next: typeof handler) => {
        handler = next;
      },
    };
    return { previous, current: () => handler };
  }

  it("sends the error buffer at once, past the 5 s gap and the backoff, without holding up the previous handler", async () => {
    const { previous, current } = installErrorUtils();
    const replay = link();
    let hang = false;
    const { client, replays } = await makeClient(
      { sessionReplay: { onErrorSampleRate: 1 }, captureExceptions: true },
      (n) => {
        if (hang) return new Promise<Response>(() => {});
        return new Response("", { status: n === 1 ? 500 : 200 });
      },
    );
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    client.captureException(new Error("handled"));
    await settle();
    expect(replays).toHaveLength(1); // answered 500: backing off for about 2 s

    replay.capture(meta(T0 + 5000), full(T0 + 5000), touch(T0 + 5200));
    await advance(500);
    current()(new Error("fatal"), true);
    await settle();
    const last = replays.at(-1) as ReplayRequest;
    expect(last.body.mode).toBe("error");
    expect(last.body.events).toContainEqual(touch(T0 + 5200));
    expect(previous).toHaveBeenCalledTimes(1);

    // A send that never answers does not hold the handler chain either.
    hang = true;
    const issued = replays.length;
    replay.capture(meta(T0 + 6000), full(T0 + 6000), touch(T0 + 6100));
    current()(new Error("fatal again"), true);
    await settle();
    expect(previous).toHaveBeenCalledTimes(2);
    // The request was really made, and is still unanswered.
    expect(replays).toHaveLength(issued + 1);
    expect(replays.at(-1)?.body.events).toContainEqual(touch(T0 + 6100));
  });
});

describe("POST /replay outcomes in the client", () => {
  it("a quota refusal pauses session recording like the web: buffered and sent on an exception even with onErrorSampleRate 0, the buffer first when the pause ends", async () => {
    const replay = link();
    const sessionReplay = { sampleRate: 1, onErrorSampleRate: 0 };
    const first = await makeClient({ sessionReplay }, (n) => (n === 1 ? quotaRefusal() : new Response("", { status: 200 })));
    replay.capture(meta(T0), full(T0), touch(T0 + 1));
    await advance(5000);
    expect(first.replays).toHaveLength(1);
    const record = JSON.parse(first.storage.store.get(replayStorageKey("proj_test")) as string);
    expect(record.quotaPausedUntil).toBe(T0 + 5000 + 3_600_000);

    replay.capture(meta(T0 + 5000), full(T0 + 5000), touch(T0 + 6000));
    await advance(5000);
    expect(first.replays).toHaveLength(1);
    first.client.captureException(new Error("boom"));
    await settle();
    expect(first.replays.slice(1).map((r) => r.body.mode)).toEqual(["error"]);

    // A relaunch during the pause still sends no session-mode chunk.
    first.client.stop();
    await settle();
    const relaunched = link();
    const second = await makeClient({ storage: first.storage, sessionReplay });
    relaunched.capture(meta(Date.now()), full(Date.now()), touch(Date.now() + 1));
    await advance(30_000);
    expect(second.replays).toHaveLength(0);

    // Shortly before the pause ends the screen changes: buffered, not sent.
    const end = T0 + 5000 + 3_600_000;
    vi.setSystemTime(end - 10_000);
    relaunched.capture(meta(end - 10_000), full(end - 10_000), touch(end - 9000));
    await advance(5000);
    expect(second.replays).toHaveLength(0);

    // Once it ends, the buffer goes first (error mode, no error event), then
    // session recording resumes from a new snapshot.
    vi.setSystemTime(end + 1);
    const checkouts = relaunched.mod.replayCheckout.mock.calls.length;
    await advance(5000);
    expect(second.replays.map((r) => r.body.mode)).toEqual(["error"]);
    expect(second.replays[0].body.events).toEqual([meta(end - 10_000), full(end - 10_000), touch(end - 9000)]);
    expect(relaunched.mod.replayCheckout.mock.calls.length).toBeGreaterThan(checkouts);
    relaunched.capture(meta(Date.now()), full(Date.now()));
    await advance(5000);
    expect(second.replays.map((r) => r.body.mode)).toEqual(["error", "session"]);
  });

  it("a 404 stops recording for the process while events keep their $session_id", async () => {
    const replay = link();
    const { client, replays, sent } = await makeClient({}, () => new Response("", { status: 404 }));
    replay.capture(meta(T0), full(T0));
    await advance(5000);
    expect(replays).toHaveLength(1);
    expect(replay.mod.replayStop).toHaveBeenCalledTimes(1);
    const drains = replay.mod.replayDrain.mock.calls.length;
    replay.capture(touch(T0 + 6000));
    await advance(60_000);
    expect(replay.mod.replayDrain.mock.calls.length).toBe(drains);
    expect(replays).toHaveLength(1);
    client.track("After");
    expect((await sent()).find((e) => e.event === "After")?.properties.$session_id).toEqual(expect.any(String));
  });
});

describe("opt-out", () => {
  it("stops the recorder, drops the outbox, and nothing is drained or uploaded afterwards, opted back in or not", async () => {
    const replay = link();
    const { client, replays } = await makeClient({}, () => new Response("", { status: 500 }));
    replay.capture(meta(T0), full(T0));
    await advance(5000);
    expect(replays).toHaveLength(1);
    expect(internals(client).sender.pending).toHaveLength(1); // kept for a retry
    client.optOutTracking();
    await settle();
    expect(replay.mod.replayStop).toHaveBeenCalledTimes(1);
    expect(internals(client).sender.pending).toHaveLength(0);
    const drains = replay.mod.replayDrain.mock.calls.length;
    replay.capture(touch(T0 + 6000));
    await advance(10 * 60_000);
    expect(replays).toHaveLength(1);
    expect(replay.mod.replayDrain.mock.calls.length).toBe(drains);

    client.optInTracking();
    client.captureException(new Error("after opt-in"));
    await advance(10 * 60_000);
    expect(replays).toHaveLength(1);
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });

  it("drops the error buffer: an exception after opting back in sends no recording", async () => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay: { onErrorSampleRate: 1 } });
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    expect(internals(client).buffer.size).toBeGreaterThan(0);
    client.optOutTracking();
    await settle();
    expect(replay.mod.replayStop).toHaveBeenCalledTimes(1);
    expect(internals(client).buffer.size).toBe(0);
    client.optInTracking();
    client.captureException(new Error("boom"));
    await settle();
    expect(replays).toHaveLength(0);
  });

  it("stops the recorder that was still starting when the app opted out", async () => {
    const replay = fakeReplayModule();
    const starting = deferred<boolean>();
    replay.mod.replayStart.mockImplementationOnce(() => starting.promise);
    link(replay);
    const { client } = await makeClient();
    client.optOutTracking();
    await settle();
    expect(replay.mod.replayStop).not.toHaveBeenCalled(); // nothing runs yet
    starting.resolve(true);
    await settle();
    expect(replay.mod.replayStop).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(replay.mod.replayDrain).not.toHaveBeenCalled();
  });

  it.each([
    ["session", { sampleRate: 1 }],
    ["error", { onErrorSampleRate: 1 }],
  ])("drops what a drain in flight returns after the opt-out (%s draw)", async (_label, sessionReplay) => {
    const replay = link();
    const { client, replays } = await makeClient({ sessionReplay });
    const drain = deferred<string[]>();
    replay.mod.replayDrain.mockImplementationOnce(() => drain.promise);
    await advance(5000); // the tick's drain is pending
    client.optOutTracking();
    await settle();
    expect(replay.mod.replayStop).toHaveBeenCalledTimes(1);
    drain.resolve([JSON.stringify([meta(T0), full(T0), touch(T0 + 100)])]);
    await settle();
    expect(internals(client).sender.pending).toHaveLength(0);
    expect(internals(client).buffer.size).toBe(0);
    await advance(60_000);
    expect(replays).toHaveLength(0);
  });

  it("never starts the recorder on a launch with a saved opt-out", async () => {
    const replay = link();
    const storage = new FakeStorage();
    storage.store.set("cohorly:opt_out", "1");
    await makeClient({ storage });
    await advance(10_000);
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    expect(replay.mod.replayDrain).not.toHaveBeenCalled();
  });
});

describe("without a working native module", () => {
  it.each([
    ["absent", {}],
    ["missing a method", { replayStart: vi.fn(), replayStop: vi.fn(), replayCheckout: vi.fn() }],
  ])("keeps replay off (%s): no $session_id, no throw, one warning in development", async (_label, mod) => {
    g.__DEV__ = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.bag = { rn: { NativeModules: { CohorlyReactNativeReplay: Object.keys(mod).length ? mod : undefined } } };
    const { client, sent } = await makeClient();
    client.track("E");
    client.captureException(new Error("boom"));
    await client.exceptionsReady;
    const events = await sent();
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.properties).not.toHaveProperty("$session_id");
    expect(warn.mock.calls.filter(([m]) => String(m).includes("CohorlyReactNativeReplay"))).toHaveLength(1);
  });

  it("does not warn in a release build", async () => {
    g.__DEV__ = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.bag = { rn: { NativeModules: {} } };
    await makeClient();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["rejects", (mod: ReturnType<typeof fakeReplayModule>["mod"]) => mod.replayStart.mockRejectedValue(new Error("no"))],
    [
      "throws",
      (mod: ReturnType<typeof fakeReplayModule>["mod"]) =>
        mod.replayStart.mockImplementation(() => {
          throw new Error("no");
        }),
    ],
    ["resolves false", (mod: ReturnType<typeof fakeReplayModule>["mod"]) => mod.replayStart.mockResolvedValue(false)],
  ])("when replayStart %s: nothing is drained and events keep flowing", async (_label, breakIt) => {
    const replay = fakeReplayModule();
    breakIt(replay.mod);
    link(replay);
    const { client, sent } = await makeClient();
    await advance(20_000);
    expect(replay.mod.replayDrain).not.toHaveBeenCalled();
    client.track("E");
    expect((await sent()).find((e) => e.event === "E")?.properties.$session_id).toEqual(expect.any(String));
  });

  it("when a drain rejects, recording stops for the process and events keep flowing", async () => {
    const replay = link();
    const { client, replays, sent } = await makeClient();
    replay.mod.replayDrain.mockRejectedValueOnce(new Error("bridge"));
    await advance(5000);
    expect(replay.mod.replayStop).toHaveBeenCalledTimes(1);
    const drains = replay.mod.replayDrain.mock.calls.length;
    replay.capture(meta(T0), full(T0));
    await advance(30_000);
    expect(replay.mod.replayDrain.mock.calls.length).toBe(drains);
    expect(replays).toHaveLength(0);
    client.track("E");
    expect((await sent()).find((e) => e.event === "E")).toBeDefined();
  });
});
