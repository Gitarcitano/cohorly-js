import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Breadcrumb, CohorlyWebOptions, SessionReplayOptions, TrackedEvent } from "../src/index.js";
import { cohorly, init } from "../src/index.js";
import type { ReplayChunk } from "../src/replay/sender.js";
import { MAX_CHUNK_BYTES, ReplaySender } from "../src/replay/sender.js";

interface RrEvent {
  type: number;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * A stand-in for @rrweb/record that keeps rrweb's emit order: Meta +
 * FullSnapshot on start, and with `checkoutEveryNms` the checkout is taken
 * lazily, right AFTER the incremental event that crossed the interval (as
 * rrweb 2.2.0's wrappedEmit does).
 */
const rr = vi.hoisted(() => {
  const state = {
    emit: null as null | ((e: unknown) => void),
    stops: 0,
    lastFull: 0,
    checkoutMs: undefined as number | undefined,
  };
  const snapshot = () => {
    state.emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href } });
    state.emit?.({ type: 2, timestamp: Date.now(), data: { node: {} } });
    state.lastFull = Date.now();
  };
  const incremental = (data: Record<string, unknown>) => {
    const event = { type: 3, timestamp: Date.now(), data };
    state.emit?.(event);
    if (state.checkoutMs && event.timestamp - state.lastFull > state.checkoutMs) snapshot();
  };
  const record = Object.assign(
    vi.fn((options: { emit: (e: unknown) => void; checkoutEveryNms?: number }) => {
      state.emit = options.emit;
      state.checkoutMs = options.checkoutEveryNms;
      snapshot();
      return () => {
        state.stops += 1;
        state.emit = null;
      };
    }),
    {
      addCustomEvent: (tag: string, payload: unknown) =>
        state.emit?.({ type: 5, timestamp: Date.now(), data: { tag, payload } }),
      takeFullSnapshot: () => snapshot(),
    },
  );
  return { state, record, incremental };
});
vi.mock("@rrweb/record", () => ({ record: rr.record }));
// Plain keepalive bodies too (the keepalive path gzips with fflate); replay-sender.test.ts covers the gzip.
vi.mock("fflate", () => ({
  gzipSync: () => {
    throw new Error("plain bodies in this test");
  },
  strToU8: (text: string) => new TextEncoder().encode(text),
}));

const API_HOST = "https://ingest.example.com";
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

/** An rrweb incremental event (source 2 = mouse interaction) at the current fake time. */
function interaction(id = 1, extra: Record<string, unknown> = {}) {
  rr.incremental({ source: 2, type: 2, id, ...extra });
}

function ok(body: unknown = { status: 1 }, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

interface SentChunk {
  url: string;
  headers: Record<string, string>;
  keepalive: boolean;
  bytes: number;
  chunk: {
    session_id: string;
    distinct_id: string;
    seq: number;
    mode: string;
    lib: string;
    events: RrEvent[];
  };
}

const isMarked = (id: number) => (e: RrEvent) => e.type === 3 && e.data.id === id;

describe("session replay", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let replayResponses: (Response | Promise<Response>)[];

  function start(sessionReplay: SessionReplayOptions, options: Partial<CohorlyWebOptions> = {}) {
    init({
      apiHost: API_HOST,
      token: "tok-web",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      sessionReplay,
      ...options,
    });
  }

  /** Waits for the dynamic imports + record() of the n-th recorder. */
  async function recording(times = 1) {
    await vi.waitFor(() => expect(rr.record).toHaveBeenCalledTimes(times));
  }

  /** Like recording(), without moving the fake clock (vi.waitFor advances it on each check). */
  async function recordingWithoutClock(times = 1) {
    for (let i = 0; i < 200 && rr.record.mock.calls.length < times; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(rr.record).toHaveBeenCalledTimes(times);
  }

  function sentChunks(host = API_HOST): SentChunk[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith(`${host}/replay`) && !String(url).includes("/replay/config"))
      .map(([url, req]) => {
        const { headers, body, keepalive } = req as {
          headers: Record<string, string>;
          body: string | Uint8Array;
          keepalive: boolean;
        };
        const text = typeof body === "string" ? body : gunzipSync(Buffer.from(body)).toString();
        return { url: String(url), headers, keepalive, bytes: text.length, chunk: JSON.parse(text) };
      });
  }

  const networkEvents = () =>
    sentChunks()
      .flatMap((c) => c.chunk.events)
      .filter((e) => e.type === 5 && e.data.tag === "$network")
      .map((e) => e.data.payload as Record<string, unknown>);

  /** Tracks an event, flushes, and returns the $session_id it was sent with. */
  async function trackedSession(name: string): Promise<unknown> {
    cohorly.track(name);
    // Let a flush already in flight (started by an earlier capture) settle,
    // or this flush() returns early and the event goes out with the next one.
    await vi.advanceTimersByTimeAsync(0);
    await cohorly.flush();
    const sent = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/track"))
      .flatMap(([, req]) => JSON.parse((req as { body: string }).body) as TrackedEvent[]);
    return sent.filter((e) => e.event === name).at(-1)?.properties.$session_id;
  }

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    rr.record.mockClear();
    rr.state.stops = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    // Plain JSON bodies unless a test brings CompressionStream back.
    vi.stubGlobal("CompressionStream", undefined);
    replayResponses = [];
    fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes("/replay")) return replayResponses.shift() ?? ok();
      if (target.startsWith("https://app.example.com/down")) throw new TypeError("Failed to fetch");
      if (target.startsWith("https://app.example.com/")) return ok({ items: [] }, 201);
      return ok();
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    // Opt-out drops what the replay sender still holds (a plain re-init would hand it over).
    cohorly.optOutTracking();
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  describe("sampling (K2)", () => {
    it("sampleRate 1 records the whole session; sampleRate 0 + onErrorSampleRate 1 only buffers for errors", async () => {
      start({ sampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks().map((c) => c.chunk.mode)).toEqual(["session"]);

      window.sessionStorage.clear(); // a new session
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording(2);
      interaction();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sentChunks()).toHaveLength(1);
      cohorly.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks().map((c) => c.chunk.mode)).toEqual(["session", "error"]);
      // The SDK times the checkouts: rrweb never gets checkoutEveryNms.
      expect(rr.record.mock.calls.every(([options]) => !("checkoutEveryNms" in options))).toBe(true);
    });

    it("decides once per session: a reload of the same session keeps the decision", async () => {
      start({ sampleRate: 0.5 });
      await recording();
      const sessionId = (cohorly.captureException(new Error("a")) as TrackedEvent).properties.$session_id;

      // Same session after a reload, and this draw would now say "not sampled".
      vi.mocked(Math.random).mockReturnValue(0.99);
      start({ sampleRate: 0.5 });
      await recording(2);
      expect((cohorly.captureException(new Error("b")) as TrackedEvent).properties.$session_id).toBe(sessionId);

      // A new session draws again.
      cohorly.reset();
      await vi.advanceTimersByTimeAsync(10);
      expect(rr.state.stops).toBeGreaterThanOrEqual(1);
      expect(rr.record).toHaveBeenCalledTimes(2);
    });
  });

  describe("session mode (K3)", () => {
    it("posts gzip chunks to /replay with the token header every 5 seconds", async () => {
      vi.stubGlobal("CompressionStream", NodeCompressionStream);
      start({ sampleRate: 1 });
      await recording();
      interaction();
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(sentChunks()).toHaveLength(1));

      const [sent] = sentChunks();
      expect(sent.url).toBe(`${API_HOST}/replay`);
      expect(sent.headers["x-cohorly-token"]).toBe("tok-web");
      expect(sent.headers["content-encoding"]).toBe("gzip");
      expect(sent.chunk).toMatchObject({ seq: 0, mode: "session", lib: "web", distinct_id: cohorly.getDistinctId() });
      expect(sent.chunk.events.map((e) => e.type)).toEqual([4, 2, 3]);
    });

    it("falls back to plain JSON without CompressionStream, and seq keeps growing across a reload", async () => {
      start({ sampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(5000);
      interaction();
      await vi.advanceTimersByTimeAsync(5000);

      start({ sampleRate: 1 }); // reload, same session
      await recording(2);
      await vi.advanceTimersByTimeAsync(5000);

      const chunks = sentChunks();
      expect(chunks.every((c) => c.headers["content-encoding"] === undefined)).toBe(true);
      expect(new Set(chunks.map((c) => c.chunk.session_id)).size).toBe(1);
      expect(chunks.map((c) => c.chunk.seq)).toEqual([0, 1, 2]);
    });

    it("flushes at 1000 events without waiting for the timer", async () => {
      start({ sampleRate: 1 });
      await recording();
      for (let i = 0; i < 998; i += 1) interaction();
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks()).toHaveLength(1);
      expect(sentChunks()[0].chunk.events).toHaveLength(1000);
    });

    it("splits a chunk over 1 MB serialized before sending it", async () => {
      start({ sampleRate: 1 });
      await recording();
      for (let i = 0; i < 3; i += 1) interaction(100 + i, { blob: "x".repeat(400_000) });
      await vi.advanceTimersByTimeAsync(5000);

      const chunks = sentChunks();
      expect(chunks).toHaveLength(2);
      expect(chunks.every((c) => c.bytes <= 1_000_000)).toBe(true);
      expect(chunks.map((c) => c.chunk.seq)).toEqual([0, 1]);
      expect(chunks.flatMap((c) => c.chunk.events).map((e) => e.type)).toEqual([4, 2, 3, 3, 3]);
    });

    it("keeps a Meta and the FullSnapshot after it in one chunk, even past 1 MB", async () => {
      start({ sampleRate: 1 });
      await recording();
      interaction(100, { blob: "x".repeat(600_000) });
      rr.state.emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href } });
      rr.state.emit?.({ type: 2, timestamp: Date.now(), data: { node: {}, blob: "y".repeat(1_200_000) } });
      interaction(101);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(sentChunks()).toHaveLength(3));

      const chunks = sentChunks();
      expect(chunks.map((c) => c.chunk.events.map((e) => e.type))).toEqual([[4, 2, 3], [4, 2], [3]]);
      expect(chunks[1].bytes).toBeGreaterThan(1_000_000);
    });

    it("keeps a Meta that is the 1000th pending event with the FullSnapshot after it", async () => {
      start({ sampleRate: 1 });
      await recording(); // Meta + FullSnapshot: 2 pending
      for (let i = 0; i < 997; i += 1) interaction();
      rr.record.takeFullSnapshot(); // the Meta is the 1000th event, its FullSnapshot the 1001st
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(sentChunks()).toHaveLength(2));

      const chunks = sentChunks();
      expect(chunks.map((c) => c.chunk.events.length)).toEqual([999, 2]);
      expect(chunks[1].chunk.events.map((e) => e.type)).toEqual([4, 2]);
    });

    it("marks hasSnapshot only on the chunk holding the FullSnapshot, and on the right half after a split", async () => {
      const enqueued = vi.spyOn(ReplaySender.prototype, "enqueue");
      const split = vi.spyOn(
        ReplaySender.prototype as unknown as { split: (chunk: ReplayChunk) => [ReplayChunk, ReplayChunk] | null },
        "split",
      );
      start({ sampleRate: 1 });
      await recording();
      interaction(1);
      replayResponses.push(ok({ status: 0, error: "too large" }, 413));
      await vi.advanceTimersByTimeAsync(5000);
      interaction(2);
      await vi.advanceTimersByTimeAsync(5000);

      const summary = (c: ReplayChunk) => ({
        types: (JSON.parse(c.eventsJson) as RrEvent[]).map((e) => e.type),
        hasSnapshot: c.hasSnapshot === true,
      });
      expect(enqueued.mock.calls.flatMap(([chunks]) => chunks).map(summary)).toEqual([
        { types: [4, 2, 3], hasSnapshot: true },
        { types: [3], hasSnapshot: false },
      ]);
      const halves = split.mock.results[0]?.value as [ReplayChunk, ReplayChunk];
      expect(halves.map(summary)).toEqual([
        { types: [4, 2], hasSnapshot: true },
        { types: [3], hasSnapshot: false },
      ]);
    });

    it("keeps a chunk on 5xx and retries it after Retry-After; splits it on 413", async () => {
      start({ sampleRate: 1 });
      await recording();
      interaction(); // the Meta + FullSnapshot pair is never split: something after it to split off
      replayResponses.push(ok({ status: 0 }, 503, { "retry-after": "20" }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sentChunks()).toHaveLength(1);
      replayResponses.push(ok({ status: 0, error: "too large" }, 413));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      const chunks = sentChunks();
      // 503, then the 413, then the two halves.
      expect(chunks.map((c) => c.chunk.events.length)).toEqual([3, 3, 2, 1]);
      expect(chunks.map((c) => c.chunk.seq)).toEqual([0, 0, 0, 1]);
    });

    it("sends what is pending with fetch keepalive and the token in the query when the page hides", async () => {
      start({ sampleRate: 1 });
      await recording();
      interaction();
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);

      const [sent] = sentChunks();
      expect(sent.keepalive).toBe(true);
      expect(sent.url).toBe(`${API_HOST}/replay?token=tok-web`);
      expect(sent.chunk.events).toHaveLength(3);
    });

    it("visibilitychange then pagehide sends each chunk once", async () => {
      start({ sampleRate: 1 });
      await recording();
      interaction();
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      try {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("pagehide"));
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        delete (document as { visibilityState?: unknown }).visibilityState;
      }

      const chunks = sentChunks();
      expect(chunks).toHaveLength(1);
      expect(chunks[0].keepalive).toBe(true);
    });

    it("a chunk a regular request still carries is sent again with keepalive when the page closes", async () => {
      start({ sampleRate: 1 });
      await recording();
      replayResponses.push(new Promise<Response>(() => {})); // never answers: the page closes first
      await vi.advanceTimersByTimeAsync(5000);
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);

      const chunks = sentChunks();
      expect(chunks.map((c) => [c.chunk.seq, c.keepalive])).toEqual([
        [0, false],
        [0, true],
      ]);
    });

    it("when the 5 MB outbox drops a chunk, the next chunk starts with a fresh full snapshot", async () => {
      start({ sampleRate: 1 });
      await recording();
      for (let i = 0; i < 6; i += 1) interaction(100 + i, { blob: "x".repeat(900_000) });
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const chunks = sentChunks();
      // The oldest chunk (seq 0, with the first snapshot) was dropped.
      expect(chunks.map((c) => c.chunk.seq)).not.toContain(0);
      expect(chunks.at(-1)?.chunk.events.map((e) => e.type)).toEqual([4, 2]);
    });

    it("chunks queued when reset() rotates keep the outgoing session id and seq", async () => {
      start({ sampleRate: 1 });
      await recording();
      replayResponses.push(ok({ status: 0 }, 503));
      await vi.advanceTimersByTimeAsync(5000); // seq 0 fails, backs off
      interaction();
      const outgoing = sentChunks()[0].chunk.session_id;
      cohorly.reset(); // the pending interaction is queued as seq 1 of the outgoing session
      await vi.advanceTimersByTimeAsync(0);
      await recording(2);
      await vi.advanceTimersByTimeAsync(5000);

      const chunks = sentChunks();
      expect(chunks.filter((c) => c.chunk.session_id === outgoing).map((c) => c.chunk.seq)).toEqual([0, 0, 1]);
      const next = chunks.filter((c) => c.chunk.session_id !== outgoing);
      expect(next.map((c) => c.chunk.seq)).toEqual([0]);
      expect(next[0].chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
    });

    it("a re-init stops the previous sender: it never retries with its old settings", async () => {
      start({ sampleRate: 1 });
      await recording();
      replayResponses.push(ok({ status: 0 }, 503, { "retry-after": "10" }));
      await vi.advanceTimersByTimeAsync(5000);
      const before = fetchMock.mock.calls.length;

      start({ sampleRate: 1 }, { token: "tok-other" });
      await recording(2);
      await vi.advanceTimersByTimeAsync(30_000);

      const later = fetchMock.mock.calls
        .slice(before)
        .filter(([url]) => String(url).includes("/replay"))
        .map(([, req]) => (req as { headers: Record<string, string> }).headers["x-cohorly-token"]);
      expect(later.length).toBeGreaterThan(0);
      expect(later.every((token) => token === "tok-other")).toBe(true);
    });

    it("a 404 on /replay stops recording for this page load", async () => {
      start({ sampleRate: 1 });
      await recording();
      replayResponses.push(ok({ error: "not found" }, 404));
      await vi.advanceTimersByTimeAsync(5000);
      expect(rr.state.stops).toBe(1);

      interaction();
      cohorly.reset();
      await vi.advanceTimersByTimeAsync(30_000);
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks()).toHaveLength(1);
      expect(rr.record).toHaveBeenCalledTimes(1);
    });
  });

  describe("idle sessions", () => {
    it("an expired session stops the recorder and sends nothing until the next interaction, which starts a new session from a full snapshot", async () => {
      start({ sampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(1);
      const first = sentChunks()[0].chunk.session_id;

      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(sentChunks()).toHaveLength(1);
      expect(rr.record).toHaveBeenCalledTimes(1);
      expect(rr.state.stops).toBe(1);

      window.dispatchEvent(new Event("pointerdown"));
      await recording(2);
      await vi.advanceTimersByTimeAsync(5000);
      const [, next] = sentChunks();
      expect(next.chunk.session_id).not.toBe(first);
      expect(next.chunk.seq).toBe(0);
      expect(next.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
    });

    it("a tracked event after the expiry starts a new session; $metric does not", async () => {
      start({ sampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      cohorly.metrics.count("probe", 1);
      cohorly.metrics.flush();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(rr.state.stops).toBe(1); // the $metric did not keep it alive

      const id = await trackedSession("Back");
      await recording(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks().at(-1)?.chunk).toMatchObject({ session_id: id, seq: 0 });
    });

    it("an interaction recorded after the expiry rotates the session and starts it: a full snapshot, then that interaction", async () => {
      start({ sampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(5000);
      const first = sentChunks()[0].chunk.session_id;

      vi.setSystemTime(Date.now() + 31 * 60_000); // no tick ran yet
      interaction(777);
      await vi.advanceTimersByTimeAsync(0);
      await recording(2);
      await vi.advanceTimersByTimeAsync(5000);

      const next = sentChunks().filter((c) => c.chunk.session_id !== first);
      expect(next.map((c) => c.chunk.seq)).toEqual([0]);
      expect(next[0].chunk.events.map((e) => e.type)).toEqual([4, 2, 3]);
      expect(isMarked(777)(next[0].chunk.events[2])).toBe(true);
      // The old session never got it.
      expect(sentChunks().filter((c) => c.chunk.session_id === first).flatMap((c) => c.chunk.events).some(isMarked(777))).toBe(false);
    });
  });

  describe("error mode (K4)", () => {
    it("sends 30 to 60 s from a full snapshot, ending with the interaction that led to the error", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording();
      for (let s = 0; s < 100; s += 1) {
        interaction();
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(sentChunks()).toHaveLength(0);

      interaction(999);
      const now = Date.now();
      cohorly.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);

      const [sent] = sentChunks();
      const events = sent.chunk.events;
      expect(sent.chunk.mode).toBe("error");
      expect(events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(events[0].timestamp).toBeGreaterThanOrEqual(now - 60_000);
      expect(events[0].timestamp).toBeLessThanOrEqual(now - 30_000);
      expect(events.every((e) => e.timestamp >= now - 60_000)).toBe(true);
      expect(isMarked(999)(events.at(-1) as RrEvent)).toBe(true);
    });

    it("keeps the triggering interaction even when it is the one that crossed the checkout interval", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(1000);
      interaction();
      await vi.advanceTimersByTimeAsync(69_000);

      interaction(999); // rrweb's own checkoutEveryNms would snapshot right after this one
      cohorly.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);

      const events = sentChunks()[0].chunk.events;
      expect(events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(events.some(isMarked(999))).toBe(true);
    });

    it("on a page idle for minutes, sends the snapshot from before the gap stamped at the window start, with the interaction", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      interaction(999);
      const now = Date.now();
      cohorly.captureException(new Error("late"));
      await vi.advanceTimersByTimeAsync(0);

      const events = sentChunks()[0].chunk.events;
      expect(events.map((e) => e.type)).toEqual([4, 2, 3]);
      expect(events[0].timestamp).toBe(now - 60_000);
      expect(events.every((e) => e.timestamp >= now - 60_000)).toBe(true);
      expect(isMarked(999)(events[2])).toBe(true);
    });

    it("an error right after the interaction that woke a 31 min idle session is sent under the new session id", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording();
      interaction();
      await vi.advanceTimersByTimeAsync(1000);
      const idle = (cohorly.captureException(new Error("before")) as TrackedEvent).properties.$session_id;
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks()).toHaveLength(1);

      // A stale tab: the click that throws is the first activity in 31 min.
      vi.setSystemTime(Date.now() + 31 * 60_000);
      interaction(999);
      const sessionId = (cohorly.captureException(new Error("stale")) as TrackedEvent).properties.$session_id;
      expect(sessionId).not.toBe(idle);
      await recording(2);
      await vi.advanceTimersByTimeAsync(0);

      const sent = sentChunks().filter((c) => c.chunk.session_id === sessionId);
      expect(sent).toHaveLength(1);
      expect(sent[0].chunk.mode).toBe("error");
      expect(sent[0].chunk.seq).toBe(0);
      expect(sent[0].chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(sent[0].chunk.events.some(isMarked(999))).toBe(true);
    });

    it("an error while the recorder of a session woken from idle is still starting is sent once it is up", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(31 * 60_000); // the tick stops the recorder
      expect(rr.state.stops).toBe(1);

      window.dispatchEvent(new Event("pointerdown"));
      const sessionId = (cohorly.captureException(new Error("stale")) as TrackedEvent).properties.$session_id;
      await recording(2);
      await vi.advanceTimersByTimeAsync(0);

      const [sent] = sentChunks();
      expect(sent.chunk).toMatchObject({ session_id: sessionId, mode: "error", seq: 0 });
      expect(sent.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
    });

    it("keeps buffering after a send; a second error within 5 s waits for the gap and sends what came since", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording();
      interaction();
      await vi.advanceTimersByTimeAsync(1000);
      cohorly.captureException(new Error("first"));
      await vi.advanceTimersByTimeAsync(0);
      const [first] = sentChunks();

      await vi.advanceTimersByTimeAsync(1000);
      interaction(500);
      cohorly.captureException(new Error("second"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(4000);
      const second = sentChunks()[1];
      expect(second.chunk.mode).toBe("error");
      expect(second.chunk.seq).toBe(first.chunk.seq + 1);
      expect(second.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(second.chunk.events.some(isMarked(500))).toBe(true);
    });

    it("bounds the buffer at 10 MB, dropping whole oldest segments", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(1000);
      for (let i = 0; i < 10; i += 1) interaction(100 + i, { blob: "a".repeat(650_000) });
      await vi.advanceTimersByTimeAsync(30_000); // SDK checkout: a new segment
      for (let i = 0; i < 6; i += 1) interaction(200 + i, { blob: "b".repeat(700_000) });
      cohorly.captureException(new Error("big"));
      await vi.advanceTimersByTimeAsync(0);

      const events = sentChunks().flatMap((c) => c.chunk.events);
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => Number(e.data.id) >= 100 && Number(e.data.id) < 110)).toBe(false);
      expect(events.filter((e) => Number(e.data.id) >= 200).length).toBe(6);
    });
  });

  describe("replay quota (K5)", () => {
    it("pauses session recording until Retry-After, across reloads, while error chunks still go out", async () => {
      start({ sampleRate: 1, onErrorSampleRate: 1 });
      await recording();
      replayResponses.push(ok({ status: 0, error: "replay quota exceeded" }, 429, { "retry-after": "3600" }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(1);
      await recording(2); // restarted as an error buffer

      interaction();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sentChunks()).toHaveLength(1);
      cohorly.captureException(new Error("during pause"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks().map((c) => c.chunk.mode)).toEqual(["session", "error"]);

      start({ sampleRate: 1, onErrorSampleRate: 1 }); // reload inside the pause
      await recording(3);
      interaction();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sentChunks()).toHaveLength(2);

      vi.setSystemTime(T0 + 3_700_000);
      start({ sampleRate: 1, onErrorSampleRate: 1 }); // after Retry-After
      await trackedSession("Back"); // the old session expired meanwhile: activity starts a new one
      await recording(4);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks().at(-1)?.chunk.mode).toBe("session");
    });

    it("a plain 429 rate limit is retried and never pauses session recording", async () => {
      start({ sampleRate: 1 });
      await recording();
      replayResponses.push(ok({ status: 0, error: "rate limited" }, 429, { "retry-after": "2" }));
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(2000);
      interaction();
      await vi.advanceTimersByTimeAsync(5000);

      expect(window.localStorage.getItem("chl_replay_quota_until")).toBeNull();
      expect(rr.record).toHaveBeenCalledTimes(1);
      expect(sentChunks().map((c) => [c.chunk.seq, c.chunk.mode])).toEqual([
        [0, "session"],
        [0, "session"],
        [1, "session"],
      ]);
    });
  });

  describe("minimum duration (VEL-2185)", () => {
    /** A fresh copy of the project's settings: decided at once, no request to /replay/config. */
    const saveRemote = (config: Record<string, number>) =>
      window.localStorage.setItem("chl_replay_config:tok-web", JSON.stringify({ fetchedAt: Date.now(), config }));
    const storedSession = () => JSON.parse(window.sessionStorage.getItem("chl_replay_session") as string);
    const replayRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/replay"));

    it("a session recording shorter than the minimum sends nothing: not on the tick, the 1000-event cut, hiding or closing", async () => {
      saveRemote({ sampleRate: 1, minDurationMs: 10_000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction();
      await vi.advanceTimersByTimeAsync(5000);
      for (let i = 0; i < 1200; i += 1) interaction(10 + i);
      await vi.advanceTimersByTimeAsync(0);
      expect(replayRequests()).toHaveLength(0);

      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      try {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("pagehide"));
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
      expect(replayRequests()).toHaveLength(0);
      expect(storedSession().seq).toBe(0);
    });

    it("past the minimum, the first chunk sent is seq 0 and starts with the Meta and FullSnapshot", async () => {
      saveRemote({ sampleRate: 1, minDurationMs: 5000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      interaction(2);
      await vi.advanceTimersByTimeAsync(5000);

      const chunks = sentChunks();
      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunk).toMatchObject({ seq: 0, mode: "session" });
      expect(chunks[0].chunk.events.map((e) => e.type)).toEqual([4, 2, 3, 3]);
      expect(chunks[0].chunk.events.some(isMarked(1))).toBe(true);
    });

    it("error mode sends its buffer on an exception whatever the minimum", async () => {
      saveRemote({ onErrorSampleRate: 1, minDurationMs: 30_000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction(999);
      cohorly.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);

      const [sent] = sentChunks();
      expect(sent.chunk.mode).toBe("error");
      expect(sent.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(sent.chunk.events.some(isMarked(999))).toBe(true);
    });

    it("counts from the session's first recorded event across its pages", async () => {
      saveRemote({ sampleRate: 1, minDurationMs: 10_000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction();
      const { recStart } = storedSession();
      expect(typeof recStart).toBe("number");
      await vi.advanceTimersByTimeAsync(4000);

      start({ sampleRate: 0, remoteConfig: true }); // the session's next page
      await recording(2);
      expect(storedSession().recStart).toBe(recStart);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2000);
      interaction(3); // 11 s after the first page's first event
      await vi.advanceTimersByTimeAsync(5000);
      const [first] = sentChunks();
      expect(first.chunk.seq).toBe(0);
      expect(first.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(first.chunk.events.some(isMarked(3))).toBe(true);
    });

    it("a session keeps the minimum it was decided with: a stored 10 s still holds when the settings now say 0", async () => {
      window.sessionStorage.setItem(
        "chl_replay_session",
        JSON.stringify({ id: "held-1", startedAt: T0, lastActivity: T0, mode: "session", seq: 0, minDurationMs: 10_000 }),
      );
      saveRemote({ sampleRate: 1, minDurationMs: 0 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5000);
      interaction(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()[0].chunk).toMatchObject({ session_id: "held-1", seq: 0 });
    });

    it("a record without a minimum (written before it existed) never holds, whatever the settings", async () => {
      window.sessionStorage.setItem(
        "chl_replay_session",
        JSON.stringify({ id: "old-1", startedAt: T0, lastActivity: T0, mode: "session", seq: 0 }),
      );
      saveRemote({ sampleRate: 1, minDurationMs: 10_000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()[0].chunk).toMatchObject({ session_id: "old-1", seq: 0 });
    });

    it("a held recording past half the outbox bound is sent anyway, its first chunk holding the snapshot", async () => {
      const enqueued = vi.spyOn(ReplaySender.prototype, "enqueue");
      saveRemote({ sampleRate: 1, minDurationMs: 30_000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      const pad = "x".repeat(700_000);
      for (let id = 1; id <= 3; id += 1) interaction(id, { pad });
      expect(enqueued).not.toHaveBeenCalled();

      interaction(4, { pad });
      expect(enqueued).toHaveBeenCalledTimes(1);
      const [chunks] = enqueued.mock.calls[0] as [ReplayChunk[], boolean | undefined];
      expect(chunks[0]).toMatchObject({ seq: 0, mode: "session", hasSnapshot: true });
      expect(chunks.reduce((sum, c) => sum + c.count, 0)).toBe(6);

      await vi.advanceTimersByTimeAsync(0);
      const [first] = sentChunks();
      expect(first.chunk.seq).toBe(0);
      expect(first.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
    });

    it("once past the minimum a recording never holds again, even for an event stamped earlier", async () => {
      saveRemote({ sampleRate: 1, minDurationMs: 5000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction(1);
      await vi.advanceTimersByTimeAsync(6000);
      interaction(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(1);

      rr.state.emit?.({ type: 3, timestamp: T0 + 1, data: { source: 2, type: 2, id: 3 } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(2);
      expect(sentChunks()[1].chunk.events.some(isMarked(3))).toBe(true);
    });

    it("hiding the tab while held sends and drops nothing: past the minimum the snapshot still goes first", async () => {
      saveRemote({ sampleRate: 1, minDurationMs: 10_000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction(1);
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      try {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
      expect(replayRequests()).toHaveLength(0);

      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10_000);
      interaction(2);
      await vi.advanceTimersByTimeAsync(5000);
      const [first] = sentChunks();
      expect(first.chunk.seq).toBe(0);
      expect(first.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(first.chunk.events.some(isMarked(1))).toBe(true);
      expect(first.chunk.events.some(isMarked(2))).toBe(true);
    });

    it("session mode paused by the quota buffers like error mode and sends on an exception, whatever the minimum", async () => {
      window.localStorage.setItem("chl_replay_quota_until", String(T0 + 60 * 60_000));
      saveRemote({ sampleRate: 1, minDurationMs: 30_000 });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      expect(storedSession()).toMatchObject({ mode: "session", minDurationMs: 30_000 });
      interaction(7);
      cohorly.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);

      const [sent] = sentChunks();
      expect(sent.chunk.mode).toBe("error");
      expect(sent.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(sent.chunk.events.some(isMarked(7))).toBe(true);
    });

    it("a recording session that rotates into a pending decision stops, then records in the mode decided", async () => {
      saveRemote({ sampleRate: 1 });
      let release: (res: Response) => void = () => {};
      const base = fetchMock.getMockImplementation();
      fetchMock.mockImplementation((url: string, requestInit?: RequestInit) =>
        String(url).includes("/replay/config")
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : base?.(url, requestInit),
      );
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      const first = storedSession().id;

      vi.setSystemTime(T0 + 61 * 60_000);
      cohorly.reset();
      expect(storedSession().mode).toBe("pending");
      await vi.advanceTimersByTimeAsync(0);
      expect(rr.state.stops).toBe(1);

      release(ok({ config: { sampleRate: 0, onErrorSampleRate: 1 } }));
      await recording(2);
      expect(storedSession().mode).toBe("error");
      interaction(5);
      cohorly.captureException(new Error("after"));
      await vi.advanceTimersByTimeAsync(0);

      const [sent] = sentChunks().filter((c) => c.chunk.mode === "error");
      expect(sent.chunk.session_id).toBe(storedSession().id);
      expect(sent.chunk.session_id).not.toBe(first);
      expect(sent.chunk.events.some(isMarked(5))).toBe(true);
    });
  });

  describe("privacy (K6)", () => {
    it("masks every input type (hidden included) and always applies the Cohorly mask and block selectors", async () => {
      start({ sampleRate: 1 });
      await recording();
      const options = rr.record.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(options).toMatchObject({
        maskTextSelector: "[data-cohorly-mask]",
        blockSelector: "[data-cohorly-block]",
        maskInputOptions: { hidden: true, password: true, text: true, email: true, textarea: true, select: true },
      });

      start({
        sampleRate: 1,
        maskTextSelector: ".pii",
        blockSelector: ".ads",
        maskAllInputs: false,
        maskInputOptions: {},
      } as SessionReplayOptions);
      await recording(2);
      const second = rr.record.mock.calls[1][0] as unknown as Record<string, unknown>;
      expect(second.maskAllInputs).toBeUndefined();
      expect(second.maskInputOptions).toMatchObject({ hidden: true, text: true });
      expect(String(second.blockSelector).split(", ")).toEqual(["[data-cohorly-block]", ".ads"]);
      expect(String(second.maskTextSelector).split(", ")).toEqual(["[data-cohorly-mask]", ".pii"]);
    });

    it("strips the query and fragment from the page URL of Meta events", async () => {
      window.history.replaceState(null, "", "/checkout?card=4242#step-2");
      start({ sampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(5000);

      const meta = sentChunks()[0].chunk.events.find((e) => e.type === 4);
      expect(meta?.data.href).toBe(`${location.origin}/checkout`);
    });
  });

  describe("network (K7)", () => {
    it("records method, query-less URL, status and duration only, skips the Cohorly API and hands the app its response", async () => {
      start({ sampleRate: 1 });
      await recording();
      const res = await fetch("https://app.example.com/api/items?secret=1#frag", {
        method: "post",
        headers: { authorization: "Bearer secret" },
        body: "secret-body",
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ items: [] });
      await fetch(`${API_HOST}/flags/evaluate?x=1`, { method: "POST" });
      await vi.advanceTimersByTimeAsync(5000);

      const network = networkEvents();
      expect(network).toHaveLength(1);
      expect(Object.keys(network[0]).sort()).toEqual(["duration_ms", "method", "status", "url"]);
      expect(network[0]).toMatchObject({ method: "POST", url: "https://app.example.com/api/items", status: 201 });
      expect(typeof network[0].duration_ms).toBe("number");
    });

    it("records only http(s) requests, and a rejected fetch with status 0", async () => {
      start({ sampleRate: 1 });
      await recording();
      await fetch("data:text/plain,secret");
      await fetch("blob:https://app.example.com/0f6a");
      await expect(fetch("https://app.example.com/down")).rejects.toThrow(TypeError);
      await vi.advanceTimersByTimeAsync(5000);

      expect(networkEvents()).toEqual([
        expect.objectContaining({ method: "GET", url: "https://app.example.com/down", status: 0 }),
      ]);
    });

    it("with apiHost on the page's own origin, skips only the SDK endpoints", async () => {
      const origin = location.origin;
      start({ sampleRate: 1 }, { apiHost: origin });
      await recording();
      await fetch(`${origin}/api/items`);
      await fetch(`${origin}/track`, { method: "POST" });
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const chunks = sentChunks(origin);
      expect(chunks.length).toBeGreaterThan(0);
      const urls = chunks
        .flatMap((c) => c.chunk.events)
        .filter((e) => e.type === 5)
        .map((e) => (e.data.payload as { url: string }).url);
      expect(urls).toEqual([`${origin}/api/items`]);
    });

    it("records an XHR's status, never an aborted one, and leaves the app its response", async () => {
      class FakeXHR extends EventTarget {
        status = 0;
        readyState = 0;
        responseText = "";
        open() {}
        send() {
          this.dispatchEvent(new Event("loadstart"));
        }
        finish(status: number) {
          this.status = status;
          this.readyState = 4;
          this.responseText = '{"ok":true}';
          this.dispatchEvent(new Event("readystatechange"));
          this.dispatchEvent(new Event("load"));
        }
        abort() {
          this.status = 0;
          this.readyState = 4;
          this.dispatchEvent(new Event("readystatechange"));
          this.dispatchEvent(new Event("abort"));
        }
      }
      vi.stubGlobal("XMLHttpRequest", FakeXHR);
      start({ sampleRate: 1 });
      await recording();

      const done = new XMLHttpRequest() as unknown as FakeXHR;
      (done as unknown as XMLHttpRequest).open("PUT", "https://app.example.com/api/items/1?x=2");
      done.send();
      done.finish(204);
      const aborted = new XMLHttpRequest() as unknown as FakeXHR;
      (aborted as unknown as XMLHttpRequest).open("GET", "https://app.example.com/api/slow");
      aborted.send();
      aborted.abort();
      await vi.advanceTimersByTimeAsync(5000);

      expect(done.responseText).toBe('{"ok":true}');
      expect(networkEvents()).toEqual([
        expect.objectContaining({ method: "PUT", url: "https://app.example.com/api/items/1", status: 204 }),
      ]);
    });

    it("wraps fetch once per page: a recorder restart keeps the same wrapper", async () => {
      start({ sampleRate: 1 });
      await recording();
      const wrapped = globalThis.fetch;
      cohorly.reset();
      await vi.advanceTimersByTimeAsync(0);
      await recording(2);
      expect(globalThis.fetch).toBe(wrapped);
    });

    it("shares the exception breadcrumb wrapper: fetch is wrapped once with both on", async () => {
      const before = globalThis.fetch;
      start({ sampleRate: 1 }, { captureExceptions: true });
      await recording();
      const wrapped = globalThis.fetch;
      expect(wrapped).not.toBe(before);
      // Unwrapping once restores the original: there is one layer, not two.
      init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
      expect(globalThis.fetch).toBe(before);
    });

    it("a failed /replay post adds no breadcrumb", async () => {
      start({ sampleRate: 1 }, { captureExceptions: true });
      await recording();
      replayResponses.push(ok({ status: 0 }, 500));
      await vi.advanceTimersByTimeAsync(5000);
      // The 500 was answered (and possibly retried once inside the window).
      expect(sentChunks().length).toBeGreaterThanOrEqual(1);

      const event = cohorly.captureException(new Error("probe")) as TrackedEvent;
      const crumbs = (event.properties.$exception_breadcrumbs as Breadcrumb[] | undefined) ?? [];
      expect(crumbs.filter((c) => JSON.stringify(c).includes("/replay"))).toEqual([]);
    });

    it("with the network option, records headers and bodies of allowed URLs; breadcrumbs stay as they were", async () => {
      start(
        {
          sampleRate: 1,
          network: { headers: true, bodies: true, allowUrls: ["https://app.example.com/api/"] },
        },
        { captureExceptions: true },
      );
      await recording();
      const respondedAt = Date.now();
      const res = await fetch("https://app.example.com/api/items?x=1", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ email: "ana@example.com", password: "x" }),
      });
      expect(await res.json()).toEqual({ items: [] });
      await fetch("https://app.example.com/other");
      await expect(fetch("https://app.example.com/down")).rejects.toThrow(TypeError);
      // The SDK's copy of the response body is read in the background.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(5000);

      // A request whose body is read is recorded after those without: find each by URL.
      const byUrl = (url: string) => networkEvents().find((e) => e.url === url);
      const items = byUrl("https://app.example.com/api/items");
      const other = byUrl("https://app.example.com/other");
      const down = byUrl("https://app.example.com/down");
      expect(networkEvents()).toHaveLength(3);
      expect(items).toMatchObject({
        method: "POST",
        url: "https://app.example.com/api/items",
        status: 201,
        kind: "fetch",
        ts: respondedAt,
        request: {
          headers: { "content-type": "application/json" },
          body: '{"email":"[email]","password":"[token]"}',
        },
        response: { body: '{"items":[]}' },
      });
      expect(JSON.stringify(items)).not.toContain("secret");
      expect(other).toEqual({
        method: "GET",
        url: "https://app.example.com/other",
        status: 201,
        duration_ms: expect.any(Number),
        capture: "not_allowed",
      });
      expect(down).toMatchObject({ status: 0, capture: "not_allowed" });

      const event = cohorly.captureException(new Error("probe")) as TrackedEvent;
      const crumbs = (event.properties.$exception_breadcrumbs as Breadcrumb[] | undefined) ?? [];
      expect(crumbs.filter((c) => c.category === "fetch").map((c) => c.data)).toEqual([
        { method: "GET", url: "https://app.example.com/down" },
      ]);
    });
  });

  describe("network detail in error mode (VEL-2145)", () => {
    it("an error captured while a failed request's body is still read waits for its $network", async () => {
      start({
        sampleRate: 0,
        onErrorSampleRate: 1,
        network: { bodies: true, allowUrls: ["https://app.example.com/api/"] },
      });
      await recording();
      let finishBody: () => void = () => {};
      const page = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (url: string, init?: unknown) => {
        if (!String(url).startsWith("https://app.example.com/api/")) return page?.(url, init);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":'));
            finishBody = () => {
              controller.enqueue(new TextEncoder().encode('"boom"}'));
              controller.close();
            };
          },
        });
        return new Response(body, { status: 500, headers: { "content-type": "application/json" } });
      });

      const res = await fetch("https://app.example.com/api/pay");
      expect(res.status).toBe(500);
      cohorly.captureException(new Error("payment failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks()).toHaveLength(0);

      finishBody();
      await vi.advanceTimersByTimeAsync(10);
      const [sent] = sentChunks();
      expect(sent.chunk.mode).toBe("error");
      const network = sent.chunk.events
        .filter((e) => e.type === 5 && e.data.tag === "$network")
        .map((e) => e.data.payload as Record<string, unknown>);
      expect(network).toEqual([
        expect.objectContaining({
          url: "https://app.example.com/api/pay",
          status: 500,
          response: { body: '{"error":"boom"}' },
        }),
      ]);
    });
  });

  describe("console (VEL-2144)", () => {
    const LEVELS = ["log", "info", "warn", "error"] as const;
    type Level = (typeof LEVELS)[number];
    let page: Record<Level, MockInstance<(...args: unknown[]) => unknown>>;

    const consoleLines = () =>
      sentChunks()
        .flatMap((c) => c.chunk.events)
        .filter((e) => e.type === 5 && e.data.tag === "$console")
        .map((e) => e.data.payload as Record<string, unknown>);

    beforeEach(() => {
      // The page's own console, before the SDK wraps it.
      const own = (level: Level, result?: unknown) =>
        vi.spyOn(console, level).mockImplementation(() => result) as unknown as MockInstance<
          (...args: unknown[]) => unknown
        >;
      page = { log: own("log", "log-result"), info: own("info"), warn: own("warn"), error: own("error") };
    });

    it("records log, info, warn and error as $console custom events; the page's console gets the same this and arguments and its result comes back", async () => {
      start({ sampleRate: 1 });
      await recording();
      const target = { owner: "app" };
      const payload = { step: 2 };
      const result = console.log.call(target, "checkout", payload);
      console.info("info line");
      console.warn("warn line", 3);
      console.error("error line");
      await vi.advanceTimersByTimeAsync(5000);

      expect(consoleLines()).toEqual([
        { level: "log", message: 'checkout {"step":2}' },
        { level: "info", message: "info line" },
        { level: "warn", message: "warn line 3" },
        { level: "error", message: "error line" },
      ]);
      expect(result).toBe("log-result");
      expect(page.log.mock.calls).toEqual([["checkout", payload]]);
      expect(page.log.mock.calls[0][1]).toBe(payload);
      expect(page.log.mock.contexts[0]).toBe(target);
      expect(page.warn.mock.calls).toEqual([["warn line", 3]]);
    });

    it("scrubs the line before it leaves the page", async () => {
      start({ sampleRate: 1 });
      await recording();
      console.error({ email: "a@b.co", password: "hunter2" }, "for jane.doe@example.com");
      await vi.advanceTimersByTimeAsync(5000);
      expect(consoleLines()).toEqual([
        { level: "error", message: '{"email":"[email]","password":"[token]"} for [email]' },
      ]);
      const raw = sentChunks().map((c) => JSON.stringify(c.chunk)).join("");
      expect(raw).not.toContain("hunter2");
      expect(raw).not.toContain("example.com");
    });

    it("with console: false records no line and never wraps the console", async () => {
      const before = { log: console.log, info: console.info, warn: console.warn, error: console.error };
      start({ sampleRate: 1, console: false });
      await recording();
      for (const level of LEVELS) expect(console[level]).toBe(before[level]);
      console.log("not recorded");
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks().length).toBeGreaterThan(0);
      expect(consoleLines()).toEqual([]);
    });

    it("never records the SDK's own [cohorly] messages", async () => {
      start({ sampleRate: 1 });
      await recording();
      console.warn("[cohorly] dropping a repeated exception (local rate limit)");
      console.warn("[cohorly]", "session replay could not load");
      console.log("app line");
      await vi.advanceTimersByTimeAsync(5000);
      expect(consoleLines()).toEqual([{ level: "log", message: "app line" }]);
      expect(page.warn).toHaveBeenCalledTimes(2);
    });

    it("does not record a console call made from inside the SDK while it records a line", async () => {
      start({ sampleRate: 1 });
      await recording();
      const add = rr.record.addCustomEvent;
      rr.record.addCustomEvent = (tag: string, payload: unknown) => {
        console.warn("rrweb noise");
        add(tag, payload);
      };
      try {
        console.log("app line");
      } finally {
        rr.record.addCustomEvent = add;
      }
      await vi.advanceTimersByTimeAsync(5000);
      expect(consoleLines()).toEqual([{ level: "log", message: "app line" }]);
      expect(page.warn).toHaveBeenCalledWith("rrweb noise");
    });

    it("never throws into the page when recording fails", async () => {
      start({ sampleRate: 1 });
      await recording();
      const add = rr.record.addCustomEvent;
      rr.record.addCustomEvent = () => {
        throw new Error("rrweb blew up");
      };
      try {
        expect(() => console.error("still logged")).not.toThrow();
      } finally {
        rr.record.addCustomEvent = add;
      }
      expect(page.error).toHaveBeenCalledWith("still logged");
    });

    it("does not keep a line logged while the session is expired", async () => {
      start({ sampleRate: 1 });
      await recording();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(rr.state.stops).toBe(1);
      console.log("while idle");

      window.dispatchEvent(new Event("pointerdown"));
      await recording(2);
      console.log("after wake");
      await vi.advanceTimersByTimeAsync(5000);
      expect(consoleLines()).toEqual([{ level: "log", message: "after wake" }]);
      expect(page.log).toHaveBeenCalledWith("while idle");
    });

    it("error mode keeps lines in the buffer sent with the error", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      await recording();
      console.warn("before the error");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sentChunks()).toEqual([]);
      cohorly.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks().map((c) => c.chunk.mode)).toEqual(["error"]);
      expect(consoleLines()).toEqual([{ level: "warn", message: "before the error" }]);
    });

    it("wraps the console once per page: a session rotation and an error to session mode switch keep the wrapper, which goes when replay and exception capture stop", async () => {
      const before = { log: console.log, error: console.error };
      // Session-mode recording paused by the replay quota: it buffers as error mode until then.
      window.localStorage.setItem("chl_replay_quota_until", String(T0 + 7000));
      start({ sampleRate: 1 }, { captureExceptions: true });
      await recording();
      const wrapped = { log: console.log, error: console.error };
      expect(wrapped.log).not.toBe(before.log);
      expect(wrapped.error).not.toBe(before.error);

      console.log("buffered in error mode");
      cohorly.captureException(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sentChunks().map((c) => c.chunk.mode)).toEqual(["error"]);

      // The pause ran out: the next tick restarts the recorder in session mode.
      await vi.advanceTimersByTimeAsync(10_000);
      await recording(2);
      expect(console.log).toBe(wrapped.log);
      console.log("in session mode");

      cohorly.reset();
      await vi.advanceTimersByTimeAsync(0);
      await recording(3);
      expect(console.log).toBe(wrapped.log);
      expect(console.error).toBe(wrapped.error);
      console.log("after rotation");
      await vi.advanceTimersByTimeAsync(5000);

      expect(consoleLines().map((l) => l.message)).toEqual([
        "buffered in error mode",
        "in session mode",
        "after rotation",
      ]);
      expect(page.log).toHaveBeenCalledTimes(3);

      init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
      expect(console.log).toBe(before.log);
      expect(console.error).toBe(before.error);
    });

    it("with exception capture and replay on, one console.error is one breadcrumb and one $console line", async () => {
      start({ sampleRate: 1 }, { captureExceptions: true });
      await recording();
      console.error("payment failed", { code: 42 });
      const event = cohorly.captureException(new Error("probe")) as TrackedEvent;
      await vi.advanceTimersByTimeAsync(5000);

      const crumbs = ((event.properties.$exception_breadcrumbs as Breadcrumb[] | undefined) ?? []).filter(
        (c) => c.category === "console",
      );
      expect(crumbs.map((c) => [c.level, c.message])).toEqual([["error", 'payment failed {"code":42}']]);
      expect(consoleLines()).toEqual([{ level: "error", message: 'payment failed {"code":42}' }]);
      expect(page.error).toHaveBeenCalledTimes(1);
    });

    it("with only one of them on, each records once: replay alone adds no breadcrumb, exception capture alone wraps only console.error", async () => {
      start({ sampleRate: 1 });
      await recording();
      console.error("replay only");
      const event = cohorly.captureException(new Error("probe")) as TrackedEvent;
      await vi.advanceTimersByTimeAsync(5000);
      const crumbs = (event.properties.$exception_breadcrumbs as Breadcrumb[] | undefined) ?? [];
      expect(crumbs.filter((c) => c.category === "console")).toEqual([]);
      expect(consoleLines()).toEqual([{ level: "error", message: "replay only" }]);

      cohorly.optOutTracking();
      cohorly.optInTracking();
      const logBefore = console.log;
      const errorBefore = console.error;
      init({ apiHost: API_HOST, token: "tok-web", loadFeatureFlags: false, flushIntervalMs: 0, captureExceptions: true });
      expect(console.log).toBe(logBefore);
      expect(console.error).not.toBe(errorBefore);
      console.error("exceptions only");
      const second = cohorly.captureException(new Error("probe 2")) as TrackedEvent;
      const trail = (second.properties.$exception_breadcrumbs as Breadcrumb[] | undefined) ?? [];
      expect(trail.filter((c) => c.category === "console").map((c) => c.message)).toEqual(["exceptions only"]);
      expect(page.error).toHaveBeenCalledTimes(2);
    });

    it("caps lines at 500 per minute without ever making a chunk too big, then writes the dropped count", async () => {
      start({ sampleRate: 1 });
      await recording();
      const firstDrop = Date.now();
      for (let i = 0; i < 503; i++) console.log(`${i} ${"x".repeat(3000)}`);
      await vi.advanceTimersByTimeAsync(5000);

      const lines = consoleLines();
      expect(lines).toHaveLength(500);
      expect(lines.every((l) => typeof l.message === "string" && l.message.length === 2048)).toBe(true);
      expect(sentChunks().length).toBeGreaterThan(1);
      expect(sentChunks().every((c) => JSON.stringify(c.chunk.events).length <= MAX_CHUNK_BYTES)).toBe(true);
      expect(sentChunks().every((c) => c.bytes <= 1_000_000)).toBe(true);
      expect(page.log).toHaveBeenCalledTimes(503);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(consoleLines().at(-1)).toEqual({ level: "warn", message: "", dropped: 3, at: firstDrop });
      expect(consoleLines()).toHaveLength(501);
    });
  });

  describe("opt-out (K8)", () => {
    it("stops the recorder, drops what is pending and sends nothing afterwards, even after opting back in", async () => {
      start({ sampleRate: 1, onErrorSampleRate: 1 });
      await recording();
      interaction();
      cohorly.optOutTracking();
      expect(rr.state.stops).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      window.dispatchEvent(new Event("pagehide"));
      cohorly.optInTracking();
      cohorly.captureException(new Error("after opt-in"));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(sentChunks()).toEqual([]);
      expect(rr.record).toHaveBeenCalledTimes(1);
    });
  });

  describe("$session_id (K9)", () => {
    const sessionOf = (message: string) =>
      (cohorly.captureException(new Error(message)) as TrackedEvent).properties.$session_id as string;

    it("is stamped on $exception and tracked events, rotates on activity after 30 min idle, and on reset()", async () => {
      start({ sampleRate: 0, onErrorSampleRate: 1 });
      const first = sessionOf("one");
      expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(await trackedSession("Clicked")).toBe(first);

      vi.setSystemTime(T0 + 29 * 60_000);
      expect(await trackedSession("Still here")).toBe(first);
      vi.setSystemTime(T0 + 29 * 60_000 + 31 * 60_000);
      // An exception is not activity: it keeps the expired id, no rotation.
      expect(sessionOf("two")).toBe(first);
      const second = await trackedSession("Back");
      expect(second).not.toBe(first);

      cohorly.reset();
      const third = sessionOf("three");
      expect(third).not.toBe(second);
      expect(third).not.toBe(first);
    });
  });

  describe("triggers (VEL-2187)", () => {
    const TRIGGER_ID = "11111111-1111-4111-8111-111111111111";
    const trigger = { id: TRIGGER_ID, kind: "event", event: "Checkout Started", filters: [], rate: 1 };
    /** A fresh copy of the project's settings: adopted at once, no request to /replay/config. */
    const saveRemote = (config: Record<string, unknown>) =>
      window.localStorage.setItem("chl_replay_config:tok-web", JSON.stringify({ fetchedAt: Date.now(), config }));
    const storedSession = () => JSON.parse(window.sessionStorage.getItem("chl_replay_session") as string);

    it("off: the hit loads rrweb and records the session from a full snapshot, its first chunk marked hasSnapshot", async () => {
      const enqueued = vi.spyOn(ReplaySender.prototype, "enqueue");
      saveRemote({ triggers: [trigger] });
      start({ sampleRate: 0, remoteConfig: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rr.record).not.toHaveBeenCalled();
      const { id } = storedSession();

      cohorly.track("Checkout Started");
      await recording();
      interaction(1);
      await vi.advanceTimersByTimeAsync(5000);

      expect(storedSession()).toMatchObject({ id, mode: "session", triggered: [TRIGGER_ID] });
      const [first] = sentChunks();
      expect(first.chunk).toMatchObject({ session_id: id, seq: 0, mode: "session" });
      expect(first.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(first.chunk.events.some(isMarked(1))).toBe(true);
      expect(enqueued.mock.calls[0][0][0].hasSnapshot).toBe(true);
    });

    it("error: the hit sends the error buffer as an error would, then records the session from a new snapshot", async () => {
      saveRemote({ onErrorSampleRate: 1, triggers: [trigger] });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction(5);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sentChunks()).toHaveLength(0);

      cohorly.track("Checkout Started");
      await vi.advanceTimersByTimeAsync(0);
      const [buffer] = sentChunks();
      expect(buffer.chunk.mode).toBe("error");
      expect(buffer.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(buffer.chunk.events.some(isMarked(5))).toBe(true);

      await recording(2);
      interaction(6);
      await vi.advanceTimersByTimeAsync(5000);
      const chunks = sentChunks();
      expect(chunks.map((c) => c.chunk.mode)).toEqual(["error", "session"]);
      expect(chunks[1].chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(chunks[1].chunk.events.some(isMarked(5))).toBe(false);
      expect(chunks[1].chunk.events.some(isMarked(6))).toBe(true);
      expect(storedSession()).toMatchObject({ mode: "session", triggered: [TRIGGER_ID] });
    });

    it("session: nothing changes, nothing is drawn or marked", async () => {
      saveRemote({ sampleRate: 1, triggers: [trigger] });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      cohorly.track("Checkout Started");
      await vi.advanceTimersByTimeAsync(5000);
      expect(rr.record).toHaveBeenCalledTimes(1);
      expect(rr.state.stops).toBe(0);
      expect(storedSession()).toMatchObject({ mode: "session", triggered: [] });
    });

    it("the minimum duration counts from the hit, not from the session's start", async () => {
      saveRemote({ minDurationMs: 10_000, triggers: [trigger] });
      start({ sampleRate: 0, remoteConfig: true });
      await vi.advanceTimersByTimeAsync(20_000);
      cohorly.track("Checkout Started");
      await recording();
      interaction(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(6000);
      interaction(2);
      await vi.advanceTimersByTimeAsync(5000);
      const [first] = sentChunks();
      expect(first.chunk).toMatchObject({ seq: 0, mode: "session" });
      expect(first.chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
    });

    it("a hit during a quota pause keeps buffering; when the pause ends the buffer is sent before the session records", async () => {
      window.localStorage.setItem("chl_replay_quota_until", String(T0 + 7000));
      saveRemote({ triggers: [trigger] });
      start({ sampleRate: 0, remoteConfig: true });
      cohorly.track("Checkout Started");
      expect(storedSession().mode).toBe("session");
      await recording();
      interaction(7);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sentChunks()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5000); // the first tick after the pause
      await recording(2);
      interaction(8);
      await vi.advanceTimersByTimeAsync(5000);
      const chunks = sentChunks();
      expect(chunks.map((c) => c.chunk.mode)).toEqual(["error", "session"]);
      expect(chunks[0].chunk.events.some(isMarked(7))).toBe(true);
      expect(chunks[1].chunk.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(chunks[1].chunk.events.some(isMarked(7))).toBe(false);
      expect(chunks[1].chunk.events.some(isMarked(8))).toBe(true);
    });

    it("error: a tick between the hit and the promotion's restart still sends the buffer first", async () => {
      saveRemote({ onErrorSampleRate: 1, triggers: [trigger] });
      // Due with the recorder's first tick and scheduled before it, so it runs
      // first: the tick then comes between the hit and the next task.
      setTimeout(() => cohorly.track("Checkout Started"), 5000);
      start({ sampleRate: 0, remoteConfig: true });
      await recordingWithoutClock();
      interaction(5);
      await vi.advanceTimersByTimeAsync(5000);
      await recording(2);
      interaction(6);
      await vi.advanceTimersByTimeAsync(5000);

      const chunks = sentChunks();
      expect(chunks.map((c) => c.chunk.mode)).toEqual(["error", "session"]);
      expect(chunks[0].chunk.events.some(isMarked(5))).toBe(true);
      expect(chunks[1].chunk.events.some(isMarked(6))).toBe(true);
      // One switch: the promotion's own restart found it done.
      expect(rr.record).toHaveBeenCalledTimes(2);
    });

    it("error: a pagehide right after the hit, before any timer, sends the buffer with keepalive", async () => {
      saveRemote({ onErrorSampleRate: 1, triggers: [trigger] });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      interaction(5);
      replayResponses.push(new Promise<Response>(() => {})); // a regular send never answers: the page closes first

      cohorly.track("Checkout Started");
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);

      const kept = sentChunks().filter((c) => c.keepalive);
      expect(kept.map((c) => c.chunk.mode)).toEqual(["error"]);
      expect(kept[0].chunk.events.some(isMarked(5))).toBe(true);
    });

    it("error: reset() right after the hit queues the old session's buffer and never promotes the new session", async () => {
      saveRemote({ onErrorSampleRate: 1, triggers: [trigger] });
      start({ sampleRate: 0, remoteConfig: true });
      await recording();
      const { id: old } = storedSession();
      interaction(5);

      cohorly.track("Checkout Started");
      cohorly.reset();
      const fresh = storedSession();
      expect(fresh.id).not.toBe(old);
      await recording(2);
      interaction(6);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(storedSession()).toMatchObject({ id: fresh.id, mode: "error", triggered: [] });
      const chunks = sentChunks();
      expect(chunks.map((c) => [c.chunk.session_id, c.chunk.mode])).toEqual([[old, "error"]]);
      expect(chunks[0].chunk.events.some(isMarked(5))).toBe(true);
      expect(rr.record).toHaveBeenCalledTimes(2);
    });
  });
});
