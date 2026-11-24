import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeModuleBag } from "../src/deviceInfo.js";

// The native modules come from a literal require("react-native"); tests swap
// the loaded bag instead (same pattern as native-crashes.test.ts).
const native = vi.hoisted(() => ({ bag: {} as Record<string, unknown> }));
vi.mock("../src/deviceInfo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deviceInfo.js")>();
  return { ...actual, loadNativeModules: () => native.bag as NativeModuleBag };
});

import { CohorlyClient } from "../src/client.js";
import { buildNativeCrashConfig } from "../src/exceptions/native-crashes.js";
import { drawSession, replaySettings } from "../src/replay/options.js";
import type { ReplayController } from "../src/replay/replay.js";
import { ReplaySessionStore, replayStorageKey } from "../src/replay/session.js";
import type { CohorlyOptions } from "../src/types.js";
import { FakeStorage } from "./helpers.js";
import {
  type AnyEvent,
  advance,
  fakeAppState,
  fakeReplayModule,
  HeldStorage,
  replayFetch,
  StuckStorage,
  settle,
  useClock,
} from "./replay-helpers.js";

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const MIN = 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A client's replay controller (private), to read the live session id. */
const replayOf = (client: CohorlyClient) => (client as unknown as { replay: ReplayController }).replay;

/** A stored replay record, live at T0 unless overridden. */
const storedRecord = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "stored-session",
    startedAt: T0 - 10 * MIN,
    lastActivity: T0 - 5 * MIN,
    backgroundAt: null,
    draw: "none",
    seq: 3,
    ...fields,
  });

/** A client built without waiting for `ready`. */
function rawClient(storage: FakeStorage, options: Partial<CohorlyOptions> = {}) {
  const net = replayFetch();
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "proj_test",
    storage,
    fetch: net.fetchImpl,
    flushInterval: 600_000,
    loadFeatureFlags: false,
    platformInfo: { os: "iOS" },
    appState: fakeAppState(),
    sessionReplay: { sampleRate: 1 },
    ...options,
  });
  clients.push(client);
  return { client, ...net };
}
const clients: CohorlyClient[] = [];

beforeEach(() => useClock(T0));
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  native.bag = {};
});

/** Links the replay module and the crash module, recording every crash config written. */
function link(replay = fakeReplayModule()) {
  const configureNativeCrashes = vi.fn<(json: string) => void>();
  native.bag = {
    rn: { NativeModules: { CohorlyReactNativeReplay: replay.mod, CohorlyReactNative: { configureNativeCrashes } } },
    expoApplication: { applicationId: "com.example.shop" },
  };
  return {
    ...replay,
    configs: (): any[] => configureNativeCrashes.mock.calls.map(([json]) => JSON.parse(json)),
  };
}

async function makeClient(options: Partial<CohorlyOptions> = {}) {
  const net = replayFetch();
  const appState = fakeAppState();
  const storage = (options.storage as FakeStorage | undefined) ?? new FakeStorage();
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "proj_test",
    fetch: net.fetchImpl,
    flushInterval: 600_000,
    flushAt: 1000,
    loadFeatureFlags: false,
    appVersion: "3.8.1",
    appBuild: "415",
    platformInfo: { os: "iOS" },
    appState,
    sessionReplay: { sampleRate: 1 },
    ...options,
    storage,
  });
  clients.push(client);
  await client.ready;
  await settle();
  /** Flushes and returns the `$session_id` of every event sent so far, by event name. */
  const sent = async (): Promise<AnyEvent[]> => {
    await client.flush();
    await settle();
    return net.tracked;
  };
  const sessionOf = async (event: string) => (await sent()).filter((e) => e.event === event).map((e) => e.properties.$session_id);
  return { client, storage, appState, sent, sessionOf, ...net };
}

describe("replay options", () => {
  it("clamps rates to 0..1, counts anything that is not a finite number as 0, and defaults mode and masking", () => {
    expect(replaySettings({ sampleRate: 1.5, onErrorSampleRate: -2 })).toEqual({
      sampleRate: 1,
      onErrorSampleRate: 0,
      mode: "screenshot",
      maskAllImages: true,
      remoteConfig: false,
    });
    expect(
      replaySettings({ sampleRate: Number.NaN, onErrorSampleRate: 0.25, mode: "wireframe", maskAllImages: false }),
    ).toEqual({ sampleRate: 0, onErrorSampleRate: 0.25, mode: "wireframe", maskAllImages: false, remoteConfig: false });
    expect(replaySettings({ sampleRate: "0.5" as any, mode: "video" as any })).toBeNull();
    expect(replaySettings({ sampleRate: 0, onErrorSampleRate: 0 })).toBeNull();
    expect(replaySettings(undefined)).toBeNull();
  });

  it("draws session below sampleRate, else error below onErrorSampleRate with a second draw, else none", () => {
    const settings = { sampleRate: 0.3, onErrorSampleRate: 0.5, mode: "screenshot" as const, maskAllImages: true };
    const draws = (values: number[]) => {
      const random = vi.fn(() => values.shift() as number);
      return { draw: drawSession(settings, random), calls: random.mock.calls.length };
    };
    expect(draws([0.29])).toEqual({ draw: "session", calls: 1 });
    expect(draws([0.3, 0.49])).toEqual({ draw: "error", calls: 2 });
    expect(draws([0.9, 0.5])).toEqual({ draw: "none", calls: 2 });
  });
});

describe("$session_id", () => {
  it.each([
    ["without sessionReplay", undefined],
    ["with both rates 0", { sampleRate: 0, onErrorSampleRate: 0 }],
    ["with rates that are not numbers", { sampleRate: "1", onErrorSampleRate: null }],
  ])("is never stamped and the replay module is never read %s", async (_label, sessionReplay) => {
    const replay = fakeReplayModule();
    let reads = 0;
    const NativeModules = {};
    Object.defineProperty(NativeModules, "CohorlyReactNativeReplay", {
      get: () => {
        reads += 1;
        return replay.mod;
      },
    });
    native.bag = { rn: { NativeModules } };
    // biome-ignore lint/suspicious/noExplicitAny: untyped options on purpose.
    const { client, sent } = await makeClient({ sessionReplay: sessionReplay as any });
    client.track("Viewed");
    client.captureException(new Error("boom"));
    await client.exceptionsReady;
    const events = await sent();
    expect(events.map((e) => e.event).sort()).toEqual(["$exception", "Viewed"]);
    for (const e of events) expect(e.properties).not.toHaveProperty("$session_id");
    expect(reads).toBe(0);
    for (const fn of Object.values(replay.mod)) expect(fn).not.toHaveBeenCalled();
  });

  it("is the same on every event, $exception included, and a caller's own $session_id wins", async () => {
    link();
    const { client, sent } = await makeClient();
    client.track("A");
    client.track("B");
    client.track("C", { $session_id: "mine" });
    client.captureException(new Error("boom"));
    await client.exceptionsReady;
    const events = await sent();
    const byName = Object.fromEntries(events.map((e) => [e.event, e.properties.$session_id]));
    expect(byName.A).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(byName.B).toBe(byName.A);
    expect(byName.$exception).toBe(byName.A);
    expect(byName.C).toBe("mine");
  });

  it("is persisted per token: a relaunch inside the session keeps the id and the draw, never draws again", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1); // under 0.5: session
    link();
    const first = await makeClient({ sessionReplay: { sampleRate: 0.5 } });
    first.client.track("Before");
    const [id] = await first.sessionOf("Before");
    first.client.stop();
    await settle();

    vi.setSystemTime(T0 + 10 * MIN);
    random.mockReturnValue(0.99); // a new draw here would be none
    const second = link();
    const relaunched = await makeClient({ storage: first.storage, sessionReplay: { sampleRate: 0.5 } });
    relaunched.client.track("After");
    expect(await relaunched.sessionOf("After")).toEqual([id]);
    // Recording resumed with the stored draw: a none draw never starts the recorder.
    expect(second.mod.replayStart).toHaveBeenCalledTimes(1);

    // Another project on the same storage has its own session.
    const other = await makeClient({ storage: first.storage, token: "proj_other" });
    other.client.track("Other");
    const [otherId] = await other.sessionOf("Other");
    expect(otherId).not.toBe(id);
    expect(first.storage.store.has(replayStorageKey("proj_test"))).toBe(true);
    expect(first.storage.store.has(replayStorageKey("proj_other"))).toBe(true);
  });

  it("stamps events tracked before the stored session was read with the stored id", async () => {
    link();
    const first = await makeClient();
    first.client.track("Before");
    const [id] = await first.sessionOf("Before");
    first.client.stop();
    await settle();

    // Only the replay record: no stored event queue to replace the early event.
    const storage = new FakeStorage();
    const key = replayStorageKey("proj_test");
    storage.store.set(key, first.storage.store.get(key) as string);
    link();
    const net = replayFetch();
    const client = new CohorlyClient({
      apiHost: "http://localhost:4000",
      token: "proj_test",
      storage,
      fetch: net.fetchImpl,
      flushInterval: 600_000,
      loadFeatureFlags: false,
      platformInfo: { os: "iOS" },
      appState: fakeAppState(),
      sessionReplay: { sampleRate: 1 },
    });
    clients.push(client);
    client.track("Early"); // before `ready`
    await client.ready;
    await client.flush();
    await settle();
    expect(net.tracked.find((e) => e.event === "Early")?.properties.$session_id).toBe(id);
  });

  it("posts no event while the stored session is being read: a flush waits, then sends the stored id", async () => {
    link();
    const storage = new HeldStorage();
    const key = replayStorageKey("proj_test");
    storage.store.set(key, storedRecord());
    storage.hold(key, "get");
    const { client, tracked } = rawClient(storage);
    client.track("Early");
    const flushed = client.flush();
    await settle();
    expect(tracked).toHaveLength(0);
    storage.open();
    await flushed;
    await settle();
    expect(tracked.find((e) => e.event === "Early")?.properties.$session_id).toBe("stored-session");
  });

  it("an exception captured before the engine is ready keeps the session of its capture across a reset()", async () => {
    link();
    const { client, tracked } = rawClient(new FakeStorage());
    const before = replayOf(client).sessionId();
    client.captureException(new Error("early")); // held until the engine exists
    client.reset();
    client.track("After");
    await client.exceptionsReady;
    await settle();
    await client.flush();
    await settle();
    const id = (name: string) => tracked.find((e) => e.event === name)?.properties.$session_id;
    expect(before).toMatch(SESSION_ID);
    expect(id("$exception")).toBe(before);
    expect(id("After")).not.toBe(before);
  });
});

describe("ReplaySessionStore", () => {
  const key = replayStorageKey("proj_test");

  it("never draws when it adopts a live stored session; a new session draws once, after the read", async () => {
    const draw = vi.fn(() => "error" as const);
    const storage = new FakeStorage();
    storage.store.set(key, storedRecord({ draw: "session" }));
    const store = new ReplaySessionStore({ storage, key, draw, now: () => Date.now() });
    expect(await store.load()).toMatchObject({ to: "stored-session" });
    expect(draw).not.toHaveBeenCalled();
    expect(store.last()).toMatchObject({ id: "stored-session", draw: "session", seq: 3 });

    const fresh = new ReplaySessionStore({ storage: new FakeStorage(), key, draw, now: () => Date.now() });
    expect(draw).not.toHaveBeenCalled();
    expect(await fresh.load()).toBeNull();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(fresh.last().draw).toBe("error");
  });

  it("keeps a background transition seen while the record was read: more than 30 min later the session rotates", async () => {
    const storage = new FakeStorage();
    storage.store.set(key, storedRecord());
    const store = new ReplaySessionStore({ storage, key, draw: () => "none", now: () => Date.now() });
    store.background();
    await store.load();
    expect(store.last()).toMatchObject({ id: "stored-session", backgroundAt: T0 });
    vi.setSystemTime(T0 + 30 * MIN + 1);
    expect(store.foreground().id).not.toBe("stored-session");
  });

  it("a client created while the app is in the background starts its idle clock at once", async () => {
    link();
    const appState = fakeAppState("background");
    const { client, sessionOf } = await makeClient({ appState });
    client.track("Before");
    vi.setSystemTime(T0 + 30 * MIN + 1);
    appState.emit("active");
    client.track("After");
    const [before] = await sessionOf("Before");
    const [after] = await sessionOf("After");
    expect(before).toMatch(SESSION_ID);
    expect(after).not.toBe(before);
  });
});

describe("session rotation", () => {
  it("rotates on the first foreground after more than 30 min in background, not at exactly 30 min", async () => {
    const linked = link();
    const { client, appState, sessionOf } = await makeClient();
    client.track("E");
    appState.emit("background");
    vi.setSystemTime(Date.now() + 30 * MIN);
    appState.emit("active");
    client.track("E");
    appState.emit("background");
    vi.setSystemTime(Date.now() + 30 * MIN + 1);
    appState.emit("active");
    client.track("E");
    await settle();
    const [a, b, c] = await sessionOf("E");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    // The crash config follows the rotation.
    const configs = linked.configs();
    expect(configs[0].sessionId).toBe(a);
    expect(configs[configs.length - 1].sessionId).toBe(c);
  });

  it("rotates on the first event more than 24 h after the session started, even with steady activity", async () => {
    const linked = link();
    const { client, sessionOf } = await makeClient();
    client.track("Start");
    // Activity every 20 min keeps the session from idling out.
    for (let elapsed = 20 * MIN; elapsed <= 24 * 60 * MIN; elapsed += 20 * MIN) {
      vi.setSystemTime(T0 + elapsed);
      client.track("Tick");
    }
    // Exactly 24 h: still the same session.
    vi.setSystemTime(T0 + 24 * 60 * MIN + 1);
    client.track("Late");
    const [start] = await sessionOf("Start");
    const ticks = await sessionOf("Tick");
    expect(new Set(ticks)).toEqual(new Set([start]));
    const [late] = await sessionOf("Late");
    expect(start).toMatch(SESSION_ID);
    expect(late).toMatch(SESSION_ID);
    expect(late).not.toBe(start);
    // The crash config follows the rotation.
    expect(linked.configs().at(-1).sessionId).toBe(late);
  });

  it("rotates on the first tracked event after more than 30 min without activity in the foreground; internal events never rotate", async () => {
    link();
    const { client, sent } = await makeClient();
    client.track("A");
    vi.setSystemTime(Date.now() + 30 * MIN);
    client.track("B"); // exactly 30 min: same session
    vi.setSystemTime(Date.now() + 30 * MIN + 1);
    client.captureException(new Error("idle")); // internal: stamped, never rotates
    client.track("C");
    await client.exceptionsReady;
    const events = await sent();
    const id = (name: string) => events.find((e) => e.event === name)?.properties.$session_id;
    expect(id("B")).toBe(id("A"));
    expect(id("$exception")).toBe(id("A"));
    expect(id("C")).not.toBe(id("A"));
  });

  it("reset() starts a new session with its own draw and seq 0, and re-sends the crash config", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    const linked = link();
    const { client, storage, sessionOf } = await makeClient({ sessionReplay: { sampleRate: 0.5 } });
    client.track("Before");
    // Sent before the reset (which clears the queue), with a real session id.
    const [before] = await sessionOf("Before");
    expect(before).toMatch(SESSION_ID);
    expect(linked.configs().at(-1).sessionId).toBe(before);
    expect(linked.mod.replayStart).toHaveBeenCalledTimes(1);
    random.mockReturnValue(0.9); // the new session's draw: none
    client.reset();
    client.track("After");
    await settle();
    const [after] = await sessionOf("After");
    expect(after).toMatch(SESSION_ID);
    expect(after).not.toBe(before);
    // The none draw stops the recorder the old session started.
    expect(linked.mod.replayStop).toHaveBeenCalledTimes(1);
    const record = JSON.parse(storage.store.get(replayStorageKey("proj_test")) as string);
    expect(record).toMatchObject({ id: after, draw: "none", seq: 0 });
    expect(linked.configs().at(-1).sessionId).toBe(after);
  });
});

describe("native crash config sessionId", () => {
  it("is written only when a session id is given", () => {
    const base = {
      captureEnabled: true,
      release: undefined,
      dist: undefined,
      distinctId: "u",
      deviceId: "d",
      build: undefined,
    };
    expect(buildNativeCrashConfig(base)).not.toHaveProperty("sessionId");
    expect(buildNativeCrashConfig({ ...base, sessionId: "" })).not.toHaveProperty("sessionId");
    expect(buildNativeCrashConfig({ ...base, sessionId: "s-1" }).sessionId).toBe("s-1");
  });

  it("carries the session stamped on events while replay is configured", async () => {
    const linked = link();
    const { client, sessionOf } = await makeClient();
    client.track("E");
    const [id] = await sessionOf("E");
    expect(linked.configs()[0].sessionId).toBe(id);
  });

  it("on Android, hands configureNativeCrashes the new session id when the session rotates", async () => {
    const linked = link();
    const { client, appState, sessionOf } = await makeClient({ platformInfo: { os: "Android" } });
    client.track("E");
    appState.emit("background");
    vi.setSystemTime(Date.now() + 30 * MIN + 1);
    appState.emit("active");
    client.track("E");
    await settle();
    const [first, second] = await sessionOf("E");
    expect(second).not.toBe(first);
    const sessions = linked.configs().map((config) => config.sessionId);
    expect(sessions[0]).toBe(first);
    expect(sessions.at(-1)).toBe(second);
  });
});

describe("seq reservation", () => {
  const KEY = "replay-key";
  const storedSeq = (storage: FakeStorage) => JSON.parse(storage.store.get(KEY) as string).seq;

  it("persisted() gives up after 5 s of a write that never answers, waits for a new write once storage answers, and never hands out a seq twice", async () => {
    const storage = new StuckStorage(KEY);
    const store = new ReplaySessionStore({ storage, key: KEY, draw: () => "session", now: () => Date.now() });
    await store.load();
    await store.persisted();
    storage.stuck = true;
    const id = store.last().id;
    expect(store.takeSeq(id)).toBe(0);
    const outcome = vi.fn();
    store.persisted().then(
      () => outcome("persisted"),
      () => outcome("timeout"),
    );
    await advance(4999);
    expect(outcome).not.toHaveBeenCalled();
    await advance(1);
    expect(outcome).toHaveBeenCalledWith("timeout");
    // The first write and the one sent again when it expired with a wait still open.
    expect(storage.hangingWrites).toBe(2);

    // That second write expires too, with nobody waiting: nothing more is sent.
    await advance(5000);
    expect(storage.hangingWrites).toBe(2);

    // Storage answers again; both writes still hang. A new wait writes the record again.
    storage.stuck = false;
    await expect(store.persisted()).resolves.toBeUndefined();
    expect(storedSeq(storage)).toBe(1);
    expect(store.takeSeq(id)).toBe(1);
    await store.persisted();
    expect(storedSeq(storage)).toBe(2);

    // The write stuck since seq 0 lands now, older than what storage holds: the newest record is written back.
    storage.release();
    await settle();
    expect(storedSeq(storage)).toBe(2);
    await expect(store.persisted()).resolves.toBeUndefined();
  });

  it("a write that fails still counts as done: the in-memory session goes on", async () => {
    const storage = new FakeStorage();
    const store = new ReplaySessionStore({ storage, key: KEY, draw: () => "session", now: () => Date.now() });
    await store.load();
    vi.spyOn(storage, "setItem").mockRejectedValue(new Error("full"));
    expect(store.takeSeq(store.last().id)).toBe(0);
    await expect(store.persisted()).resolves.toBeUndefined();
    expect(store.takeSeq(store.last().id)).toBe(1);
  });
});
