import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Breadcrumb, CohorlyWebOptions, SessionReplayOptions, TrackedEvent } from "../src/index.js";
import { cohorly, init } from "../src/index.js";
import type { ReplayChunk } from "../src/replay/sender.js";
import { ReplaySender } from "../src/replay/sender.js";

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

  function sentChunks(host = API_HOST): SentChunk[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith(`${host}/replay`))
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
});
