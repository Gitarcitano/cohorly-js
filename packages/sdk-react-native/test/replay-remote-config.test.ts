import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeModuleBag } from "../src/deviceInfo.js";

const native = vi.hoisted(() => ({ bag: {} as Record<string, unknown> }));
vi.mock("../src/deviceInfo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deviceInfo.js")>();
  return { ...actual, loadNativeModules: () => native.bag as NativeModuleBag };
});

import { CohorlyClient } from "../src/client.js";
import { teardownExceptionCapture } from "../src/exceptions/handlers.js";
import { replaySettings } from "../src/replay/options.js";
import {
  fetchReplayConfig,
  parseReplayConfig,
  readReplayConfig,
  replayConfigKey,
} from "../src/replay/remote-config.js";
import { MIN_DURATION_HOLD_MAX_BYTES } from "../src/replay/replay.js";
import { replayStorageKey } from "../src/replay/session.js";
import type { CohorlyOptions } from "../src/types.js";
import { FakeStorage } from "./helpers.js";
import {
  advance,
  deferred,
  fakeAppState,
  fakeReplayModule,
  full,
  HeldStorage,
  meta,
  type RrEvent,
  replayFetch,
  settle,
  touch,
  useClock,
} from "./replay-helpers.js";

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const TOKEN = "proj_test";
const CONFIG_KEY = replayConfigKey(TOKEN);
const RECORD_KEY = replayStorageKey(TOKEN);
const clients: CohorlyClient[] = [];

beforeEach(() => useClock(T0));
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  teardownExceptionCapture();
  vi.useRealTimers();
  vi.restoreAllMocks();
  native.bag = {};
});

function link(replay = fakeReplayModule()) {
  native.bag = { rn: { NativeModules: { CohorlyReactNativeReplay: replay.mod } } };
  return replay;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const answer = (config: unknown) => () => ok({ config });
const hang = () => new Promise<Response>(() => {});

interface ConfigCall {
  url: string;
  init?: RequestInit;
}

/** replayFetch plus `/replay/config`, answered by `config` (an empty config by default). */
function network(config: (call: ConfigCall) => Response | Promise<Response> = answer({})) {
  const base = replayFetch();
  const configCalls: ConfigCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === "/replay/config") {
      const call = { url, init };
      configCalls.push(call);
      return config(call);
    }
    return base.fetchImpl(url, init);
  }) as unknown as typeof fetch;
  return { ...base, fetchImpl, configCalls };
}

/** A client not yet ready. */
function build(
  options: Partial<CohorlyOptions> = {},
  config?: (call: ConfigCall) => Response | Promise<Response>,
) {
  const net = network(config);
  const storage = (options.storage as FakeStorage | undefined) ?? new FakeStorage();
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: TOKEN,
    fetch: net.fetchImpl,
    flushInterval: 600_000,
    flushAt: 1000,
    loadFeatureFlags: false,
    platformInfo: { os: "iOS" },
    appState: fakeAppState(),
    sessionReplay: { sampleRate: 0, remoteConfig: true },
    ...options,
    storage,
  });
  clients.push(client);
  const sent = async () => {
    await client.flush();
    await settle();
    return net.tracked;
  };
  return { client, storage, sent, ...net };
}

async function makeClient(
  options: Partial<CohorlyOptions> = {},
  config?: (call: ConfigCall) => Response | Promise<Response>,
) {
  const made = build(options, config);
  await made.client.ready;
  await made.client.exceptionsReady;
  await settle();
  return made;
}

/** A storage holding a settings copy fetched at `fetchedAt`. */
function withCopy(config: unknown, fetchedAt: number, storage = new FakeStorage()) {
  storage.store.set(CONFIG_KEY, JSON.stringify({ fetchedAt, config }));
  return storage;
}
const fresh = (config: unknown, storage?: FakeStorage) => withCopy(config, T0 - 10 * MIN, storage);
const expired = (config: unknown, storage?: FakeStorage) => withCopy(config, T0 - 2 * HOUR, storage);

const record = (storage: FakeStorage) => JSON.parse(storage.store.get(RECORD_KEY) ?? "null");
const copyOf = (storage: FakeStorage) => JSON.parse(storage.store.get(CONFIG_KEY) ?? "null");

/** A stored replay record, live at T0 unless overridden. */
const storedRecord = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "stored-session",
    startedAt: T0 - 10 * MIN,
    lastActivity: T0 - 5 * MIN,
    backgroundAt: null,
    draw: "none",
    seq: 0,
    ...fields,
  });

/** An image mutation whose JSON is about `size` bytes. */
const image = (timestamp: number, size: number): RrEvent => ({
  type: 3,
  timestamp,
  data: { source: 0, adds: [{ parentId: 5, wireframe: { id: 10000001, type: "image", base64: "a".repeat(size) } }] },
});

describe("remoteConfig off (G1)", () => {
  it.each([{ sampleRate: 1 }, { sampleRate: 1, remoteConfig: false }])(
    "never asks for the settings and records as the code says (%o)",
    async (sessionReplay) => {
      const replay = link();
      const { replays, configCalls, storage } = await makeClient({ sessionReplay }, answer({ sampleRate: 0 }));
      replay.capture(meta(T0), full(T0), touch(T0 + 100));
      await advance(HOUR);
      expect(configCalls).toHaveLength(0);
      expect(storage.store.has(CONFIG_KEY)).toBe(false);
      expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
      expect(replays.length).toBeGreaterThan(0);
    },
  );

  it("a record left pending is decided at once by the code, with no request", async () => {
    const replay = link();
    const storage = new FakeStorage();
    storage.store.set(RECORD_KEY, storedRecord({ draw: "pending" }));
    const { configCalls } = await makeClient({ storage, sessionReplay: { sampleRate: 1 } }, answer({ sampleRate: 0 }));
    expect(configCalls).toHaveLength(0);
    expect(record(storage)).toMatchObject({ id: "stored-session", draw: "session" });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });

  it("a stored minimum duration is not applied", async () => {
    const replay = link();
    const storage = new FakeStorage();
    storage.store.set(RECORD_KEY, storedRecord({ draw: "session", minDurationMs: 30_000 }));
    const { replays } = await makeClient({ storage, sessionReplay: { sampleRate: 1 } });
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    expect(replays).toHaveLength(1);
    expect(replays[0].body).toMatchObject({ session_id: "stored-session", seq: 0 });
  });

  it("is off with both rates at 0 unless remoteConfig and a token turn it on", () => {
    expect(replaySettings({ sampleRate: 0 }, TOKEN)).toBeNull();
    expect(replaySettings({ sampleRate: 0, remoteConfig: true })).toBeNull();
    expect(replaySettings({ sampleRate: 0, remoteConfig: true }, TOKEN)).toMatchObject({ remoteConfig: true });
  });
});

describe("the stored copy", () => {
  it("fresh: no request, and its values decide the first session at once (G2)", async () => {
    const replay = link();
    const { configCalls, storage } = await makeClient({ storage: fresh({ sampleRate: 1 }) });
    expect(configCalls).toHaveLength(0);
    expect(record(storage).draw).toBe("session");
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });

  it("expired: exactly one request to /replay/config with the token and no credential (G3)", async () => {
    link();
    const { client, configCalls } = await makeClient({ storage: expired({ sampleRate: 1 }) }, hang);
    client.reset();
    client.reset();
    await advance(10_000);
    expect(configCalls).toHaveLength(1);
    const [{ url, init }] = configCalls;
    expect(url).toBe(`http://localhost:4000/replay/config?token=${TOKEN}`);
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-cohorly-token")).toBe(false);
  });

  it("a copy fetched in the future is no copy (G13)", async () => {
    const replay = link();
    const { configCalls, storage } = await makeClient(
      { storage: withCopy({ sampleRate: 1 }, T0 + HOUR) },
      answer({ sampleRate: 0 }),
    );
    expect(configCalls).toHaveLength(1);
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    expect(copyOf(storage)).toEqual({ fetchedAt: T0, config: { sampleRate: 0 } });
    expect(await readReplayConfig(withCopy({}, T0 + 1), TOKEN, () => T0)).toBeNull();
  });
});

describe("the answer", () => {
  it.each([
    [{ sampleRate: 0, onErrorSampleRate: 1 }, { sampleRate: 0 }, "error"],
    [{ sampleRate: 1, onErrorSampleRate: 0 }, { onErrorSampleRate: 0 }, "session"],
    [{ sampleRate: 0, onErrorSampleRate: 0 }, { sampleRate: 1 }, "session"],
    [{ sampleRate: 1, onErrorSampleRate: 1 }, { sampleRate: 0, onErrorSampleRate: 0 }, "none"],
  ] as const)("applies per field: code %o with %o saved decides %s (G4)", async (code, saved, draw) => {
    link();
    const { storage } = await makeClient({ sessionReplay: { ...code, remoteConfig: true } }, answer(saved));
    expect(record(storage).draw).toBe(draw);
    expect(copyOf(storage)).toEqual({ fetchedAt: T0, config: saved });
  });

  it("keeps only valid fields: rates in 0..1, minDurationMs capped at 30 s, no triggers (G7)", async () => {
    link();
    const { storage } = await makeClient(
      {},
      answer({ sampleRate: 1.5, onErrorSampleRate: "1", minDurationMs: 45_000, triggers: [{ type: "event" }] }),
    );
    expect(copyOf(storage).config).toEqual({ minDurationMs: 30_000 });
  });

  it.each([1.5, -0.1, true, "0.5", Number.NaN, null])("drops the rate %o", (value) => {
    expect(parseReplayConfig({ sampleRate: value, onErrorSampleRate: value })).toEqual({});
  });

  it("drops a negative minDurationMs and keeps 0..30 s as saved (G7)", () => {
    expect(parseReplayConfig({ minDurationMs: -1 })).toEqual({});
    expect(parseReplayConfig({ minDurationMs: 45_000 })).toEqual({ minDurationMs: 30_000 });
    expect(parseReplayConfig({ sampleRate: 0, onErrorSampleRate: 1, minDurationMs: 0, triggers: [] })).toEqual({
      sampleRate: 0,
      onErrorSampleRate: 1,
      minDurationMs: 0,
    });
    expect(parseReplayConfig("nope")).toBeNull();
  });
});

describe("failures fall back (G5)", () => {
  const failures = {
    "a non-2xx answer": () => new Response("{}", { status: 500 }),
    "a network error": () => Promise.reject(new TypeError("offline")),
    "invalid JSON": () => new Response("not json", { status: 200 }),
  };

  it.each(Object.entries(failures))("%s: the expired copy decides, and nothing is written", async (_name, fail) => {
    const replay = link();
    const storage = expired({ sampleRate: 1 });
    const before = storage.store.get(CONFIG_KEY);
    await makeClient({ storage }, fail);
    expect(record(storage).draw).toBe("session");
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    expect(storage.store.get(CONFIG_KEY)).toBe(before);
  });

  it.each(Object.entries(failures))("%s: without a copy the code decides, and nothing is written", async (_name, fail) => {
    const replay = link();
    const { storage } = await makeClient({ sessionReplay: { sampleRate: 1, remoteConfig: true } }, fail);
    expect(record(storage).draw).toBe("session");
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    expect(storage.store.has(CONFIG_KEY)).toBe(false);
  });

  it("no answer in 3 s: the expired copy decides", async () => {
    const replay = link();
    const { storage } = await makeClient({ storage: expired({ sampleRate: 1 }) }, hang);
    await advance(2999);
    expect(record(storage).draw).toBe("pending");
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    await advance(1);
    expect(record(storage).draw).toBe("session");
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });
});

describe("late answers", () => {
  it("after 3 s: the decided session stays, the copy is updated and decides the next session (G6)", async () => {
    const replay = link();
    const late = deferred<Response>();
    const { client, storage } = await makeClient({}, () => late.promise);
    await advance(3000);
    expect(record(storage).draw).toBe("none");
    const first = record(storage).id;

    late.resolve(ok({ config: { sampleRate: 1 } }));
    await settle();
    expect(record(storage)).toMatchObject({ id: first, draw: "none" });
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    expect(copyOf(storage)).toEqual({ fetchedAt: T0 + 3000, config: { sampleRate: 1 } });

    client.reset();
    await settle();
    expect(record(storage).id).not.toBe(first);
    expect(record(storage).draw).toBe("session");
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });

  it("a live session never changes mode or minimum duration after a new answer (G8)", async () => {
    const replay = link();
    const late = deferred<Response>();
    const { storage, replays } = await makeClient({ storage: expired({ sampleRate: 1 }) }, () => late.promise);
    await advance(3000);
    expect(record(storage)).toMatchObject({ draw: "session" });
    expect(record(storage)).not.toHaveProperty("minDurationMs");

    late.resolve(ok({ config: { sampleRate: 0, minDurationMs: 30_000 } }));
    await settle();
    replay.capture(meta(T0 + 3000), full(T0 + 3000), touch(T0 + 3100));
    await advance(5000);
    expect(record(storage)).toMatchObject({ draw: "session" });
    expect(record(storage)).not.toHaveProperty("minDurationMs");
    expect(replay.mod.replayStop).not.toHaveBeenCalled();
    expect(replays).toHaveLength(1);
  });

  it("an answer handled after the 3 s, before the timer ran, never decides the live session (G6)", async () => {
    const replay = link();
    const reply = deferred<Response>();
    const { storage } = await makeClient({}, () => reply.promise);
    vi.setSystemTime(T0 + 3500);
    reply.resolve(ok({ config: { sampleRate: 1 } }));
    await settle();
    expect(record(storage).draw).toBe("none");
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    expect(copyOf(storage)).toEqual({ fetchedAt: T0 + 3500, config: { sampleRate: 1 } });
  });

  it("a fast answer decides the session while the copy is still being written (G4)", async () => {
    const replay = link();
    const storage = new HeldStorage();
    storage.hold(CONFIG_KEY, "set");
    const reply = deferred<Response>();
    await makeClient({ storage }, () => reply.promise);
    await advance(100);
    reply.resolve(ok({ config: { sampleRate: 1 } }));
    await settle();
    expect(record(storage).draw).toBe("session");
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    expect(storage.store.has(CONFIG_KEY)).toBe(false);
    storage.open();
    await settle();
    expect(copyOf(storage)).toEqual({ fetchedAt: T0 + 100, config: { sampleRate: 1 } });
  });

  it("after stop() an answer is not written (G5)", async () => {
    link();
    const reply = deferred<Response>();
    const { client, storage } = await makeClient({}, () => reply.promise);
    client.stop();
    reply.resolve(ok({ config: { sampleRate: 1 } }));
    await settle();
    expect(storage.store.has(CONFIG_KEY)).toBe(false);
  });

  it("two requests for one token: the older answer, written last, never replaces the newer (G13)", async () => {
    const storage = new HeldStorage();
    storage.hold(CONFIG_KEY, "set");
    const older = deferred<Response>();
    const newer = deferred<Response>();
    const call = (reply: Promise<Response>) =>
      fetchReplayConfig({
        apiHost: "http://localhost:4000",
        token: TOKEN,
        storage,
        fetch: (() => reply) as unknown as typeof fetch,
        now: () => Date.now(),
      });
    const first = call(older.promise);
    await advance(1000);
    const second = call(newer.promise);
    newer.resolve(ok({ config: { sampleRate: 1 } }));
    await settle();
    older.resolve(ok({ config: { sampleRate: 0 } }));
    await settle();
    storage.open();
    await Promise.all([first, second]);
    expect(copyOf(storage)).toEqual({ fetchedAt: T0 + 1000, config: { sampleRate: 1 } });
  });

  it("never overwrites a copy fetched after the request began; one request in flight (G13)", async () => {
    const storage = new FakeStorage();
    const pending = deferred<Response>();
    const fetchImpl = vi.fn(() => pending.promise) as unknown as typeof fetch;
    const result = fetchReplayConfig({
      apiHost: "http://localhost:4000/",
      token: TOKEN,
      storage,
      fetch: fetchImpl,
      now: () => Date.now(),
    });
    await advance(1000);
    const newer = JSON.stringify({ fetchedAt: T0 + 500, config: { sampleRate: 1 } });
    storage.store.set(CONFIG_KEY, newer);
    pending.resolve(ok({ config: { sampleRate: 0 } }));
    expect(await result).toEqual({ fetchedAt: T0 + 1000, config: { sampleRate: 0 } });
    expect(storage.store.get(CONFIG_KEY)).toBe(newer);
    expect(fetchImpl).toHaveBeenCalledWith(`http://localhost:4000/replay/config?token=${TOKEN}`, expect.anything());
  });
});

describe("the 30 s abort (G9)", () => {
  it("aborts the request at 30 s and resolves null", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const storage = new FakeStorage();
    let outcome: unknown = "unsettled";
    void fetchReplayConfig({ apiHost: "http://localhost:4000", token: TOKEN, storage, fetch: fetchImpl, now: () => Date.now() }).then(
      (r) => {
        outcome = r;
      },
    );
    await advance(29_999);
    expect(signal?.aborted).toBe(false);
    await advance(1);
    expect(signal?.aborted).toBe(true);
    expect(outcome).toBeNull();
    expect(storage.store.size).toBe(0);
  });

  it("a fetch that ignores the abort still ends at 30 s, and the next session asks again", async () => {
    link();
    const { client, configCalls } = await makeClient({}, hang);
    await advance(30_000);
    expect(configCalls).toHaveLength(1);
    client.reset();
    await settle();
    expect(configCalls).toHaveLength(2);
  });

  it.each([
    [29_999, true],
    [30_000, false],
  ] as const)("an answer arriving %i ms after the request began is cached: %s", async (after, cached) => {
    const pending = deferred<Response>();
    const storage = new FakeStorage();
    const result = fetchReplayConfig({
      apiHost: "http://localhost:4000",
      token: TOKEN,
      storage,
      fetch: (() => pending.promise) as unknown as typeof fetch,
      now: () => Date.now(),
    });
    await advance(after);
    pending.resolve(ok({ config: { sampleRate: 1 } }));
    const stored = await result;
    expect(stored !== null).toBe(cached);
    expect(storage.store.has(CONFIG_KEY)).toBe(cached);
  });
});

describe("the project turns recording on or off (G16)", () => {
  it("code rates 0, saved sampleRate 1: the recorder starts and chunks are sent", async () => {
    const replay = link();
    const { replays } = await makeClient({}, answer({ sampleRate: 1 }));
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    expect(replays).toHaveLength(1);
    expect(replays[0].body).toMatchObject({ mode: "session", seq: 0 });
  });

  it.each([
    ["saved 0", answer({ sampleRate: 0 })],
    ["a failure without a copy", () => new Response("{}", { status: 503 })],
  ] as const)("code rates 0, %s: the recorder never starts", async (_name, config) => {
    const replay = link();
    const { replays } = await makeClient({}, config);
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(HOUR);
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    expect(replays).toHaveLength(0);
  });
});

describe("one session with slow storage (G10)", () => {
  it("a slow read of the copy: one id across events tracked before and after, one start", async () => {
    const replay = link();
    const storage = fresh({ sampleRate: 1 }, new HeldStorage());
    (storage as HeldStorage).hold(CONFIG_KEY, "get");
    const { client, sent, configCalls } = build({ storage });
    client.track("Early");
    await settle();
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    (storage as HeldStorage).open();
    await client.ready;
    await settle();
    client.track("Late");
    const events = await sent();
    const id = (name: string) => events.find((e) => e.event === name)?.properties.$session_id;
    expect(id("Early")).toBeDefined();
    expect(id("Late")).toBe(id("Early"));
    expect(record(storage)).toMatchObject({ id: id("Early"), draw: "session" });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    expect(configCalls).toHaveLength(0);
  });

  it("a slow write of the session: one id, one draw, one start", async () => {
    const replay = link();
    const storage = new HeldStorage();
    storage.hold(RECORD_KEY, "set");
    const { client, sent, configCalls } = build({ storage }, answer({ sampleRate: 1 }));
    client.track("Early");
    await settle();
    storage.open();
    await client.ready;
    await settle();
    client.track("Late");
    const events = await sent();
    const id = (name: string) => events.find((e) => e.event === name)?.properties.$session_id;
    expect(id("Late")).toBe(id("Early"));
    expect(record(storage)).toMatchObject({ id: id("Early"), draw: "session" });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    expect(configCalls.length).toBeLessThanOrEqual(1);
  });
});

describe("a pending session (G4)", () => {
  it("is stamped on events at once and starts nothing until the answer decides it", async () => {
    const replay = link();
    const reply = deferred<Response>();
    const { client, storage, sent } = await makeClient({}, () => reply.promise);
    client.track("While pending");
    const [event] = (await sent()).filter((e) => e.event === "While pending");
    expect(record(storage).draw).toBe("pending");
    expect(event.properties.$session_id).toBe(record(storage).id);
    expect(replay.mod.replayStart).not.toHaveBeenCalled();

    reply.resolve(ok({ config: { sampleRate: 1 } }));
    await settle();
    expect(record(storage)).toMatchObject({ id: event.properties.$session_id, draw: "session" });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });

  it("a failure decides it before the 3 s", async () => {
    const replay = link();
    const reply = deferred<Response>();
    const { storage } = await makeClient({ sessionReplay: { sampleRate: 1, remoteConfig: true } }, () => reply.promise);
    await advance(1000);
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    reply.resolve(new Response("{}", { status: 500 }));
    await settle();
    expect(record(storage).draw).toBe("session");
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });

  it("the 3 s decide it with the code when nothing else did", async () => {
    const replay = link();
    const { storage } = await makeClient({ sessionReplay: { sampleRate: 1, remoteConfig: true } }, hang);
    await advance(2999);
    expect(replay.mod.replayStart).not.toHaveBeenCalled();
    await advance(1);
    expect(record(storage).draw).toBe("session");
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });
});

describe("stored records (G12, G14)", () => {
  it("a record left pending (killed while it waited) is decided at the next launch by the answer", async () => {
    const replay = link();
    const storage = new FakeStorage();
    storage.store.set(RECORD_KEY, storedRecord({ draw: "pending" }));
    const { configCalls } = await makeClient({ storage }, answer({ sampleRate: 1 }));
    expect(configCalls).toHaveLength(1);
    expect(record(storage)).toMatchObject({ id: "stored-session", draw: "session" });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });

  it("a record left pending is decided at once by a fresh copy", async () => {
    const replay = link();
    const storage = fresh({ sampleRate: 1 });
    storage.store.set(RECORD_KEY, storedRecord({ draw: "pending" }));
    const { configCalls } = await makeClient({ storage }, hang);
    expect(configCalls).toHaveLength(0);
    expect(record(storage)).toMatchObject({ id: "stored-session", draw: "session" });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
  });

  it("an old record without the new fields reads as decided with no minimum duration", async () => {
    const replay = link();
    const storage = fresh({ sampleRate: 0, minDurationMs: 30_000 });
    storage.store.set(RECORD_KEY, storedRecord({ draw: "session" }));
    const { replays } = await makeClient({ storage });
    expect(record(storage)).toMatchObject({ id: "stored-session", draw: "session" });
    expect(replay.mod.replayStart).toHaveBeenCalledTimes(1);
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    // Not redrawn with the copy's sampleRate 0, and not held by its minimum duration.
    expect(replays).toHaveLength(1);
    expect(replays[0].body).toMatchObject({ session_id: "stored-session", mode: "session", seq: 0 });
  });
});

describe("minimum duration (G15)", () => {
  it("a session-mode recording that ends shorter sends nothing and takes no seq", async () => {
    const replay = link();
    const { client, storage, replays } = await makeClient({ storage: fresh({ sampleRate: 1, minDurationMs: 10_000 }) });
    expect(record(storage)).toMatchObject({ draw: "session", minDurationMs: 10_000 });
    const first = record(storage).id;
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    expect(replays).toHaveLength(0);
    expect(record(storage).seq).toBe(0);

    client.reset();
    await advance(20_000);
    expect(replays.filter((r) => r.body.session_id === first)).toHaveLength(0);
  });

  it("one that reaches it is sent whole, in order, from seq 0", async () => {
    const replay = link();
    const { replays } = await makeClient({ storage: fresh({ sampleRate: 1, minDurationMs: 10_000 }) });
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    replay.capture(touch(T0 + 5000));
    await advance(5000);
    expect(replays).toHaveLength(0);
    replay.capture(touch(T0 + 10_000));
    await advance(5000);
    expect(replays.map((r) => r.body.seq)).toEqual([0]);
    expect(replays[0].body.events).toEqual([meta(T0), full(T0), touch(T0 + 100), touch(T0 + 5000), touch(T0 + 10_000)]);

    // Nothing is held again.
    replay.capture(touch(T0 + 15_000));
    await advance(5000);
    expect(replays.map((r) => r.body.seq)).toEqual([0, 1]);
  });

  it("more than the hold cap is sent anyway, starting with its snapshot", async () => {
    const replay = link();
    const { replays } = await makeClient({ storage: fresh({ sampleRate: 1, minDurationMs: 30_000 }) });
    const size = 700_000;
    const count = Math.ceil(MIN_DURATION_HOLD_MAX_BYTES / size) + 1;
    replay.capture(meta(T0), full(T0), ...Array.from({ length: count }, (_, i) => image(T0 + 100 + i, size)));
    await advance(5000);
    await settle(50);
    expect(replays.length).toBeGreaterThan(1);
    expect(replays.map((r) => r.body.seq)).toEqual(replays.map((_, i) => i));
    expect(replays[0].body.events.slice(0, 2)).toEqual([meta(T0), full(T0)]);
    expect(replays.reduce((n, r) => n + r.body.events.length, 0)).toBe(count + 2);
  });

  it("a drain that crosses the cap never piles on the held part: the snapshot is still sent", async () => {
    const replay = link();
    const { replays } = await makeClient({ storage: fresh({ sampleRate: 1, minDurationMs: 30_000 }) });
    const size = 700_000;
    replay.capture(meta(T0), full(T0), ...Array.from({ length: 3 }, (_, i) => image(T0 + 100 + i, size)));
    await advance(5000);
    expect(replays).toHaveLength(0);
    replay.capture(...Array.from({ length: 5 }, (_, i) => image(T0 + 200 + i, size)));
    await advance(5000);
    await settle(50);
    expect(replays[0].body.seq).toBe(0);
    expect(replays[0].body.events.slice(0, 2)).toEqual([meta(T0), full(T0)]);
  });

  it("an event too large to send never counts toward the duration", async () => {
    const replay = link();
    const { replays } = await makeClient({ storage: fresh({ sampleRate: 1, minDurationMs: 10_000 }) });
    replay.capture(meta(T0), full(T0), touch(T0 + 100), image(T0 + 10_000, 1_000_000));
    await advance(5000);
    expect(replays).toHaveLength(0);
  });

  it("error mode is never held", async () => {
    const replay = link();
    const { client, replays } = await makeClient({
      storage: fresh({ sampleRate: 0, onErrorSampleRate: 1, minDurationMs: 30_000 }),
    });
    replay.capture(meta(T0), full(T0), touch(T0 + 100));
    await advance(5000);
    client.captureException(new Error("boom"));
    await settle();
    expect(replays).toHaveLength(1);
    expect(replays[0].body).toMatchObject({ mode: "error", seq: 0 });
  });
});

describe("never blocks the client (G11)", () => {
  it("ready resolves and track works while the settings request hangs", async () => {
    link();
    const { client, sent, configCalls } = build({}, hang);
    await client.ready;
    client.track("Works");
    const events = await sent();
    expect(configCalls).toHaveLength(1);
    expect(events.find((e) => e.event === "Works")?.properties.$session_id).toEqual(expect.any(String));
  });
});
