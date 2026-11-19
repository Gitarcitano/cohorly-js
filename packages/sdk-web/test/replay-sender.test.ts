import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";
import * as fflate from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayChunk, SenderOptions } from "../src/replay/sender.js";
import { chunkJson, KEEPALIVE_BUDGET_BYTES, MAX_CHUNK_BYTES, ReplaySender } from "../src/replay/sender.js";

vi.mock("fflate", async (importOriginal) => {
  const real = await importOriginal<typeof import("fflate")>();
  return { ...real, gzipSync: vi.fn(real.gzipSync) };
});
const realFflate = await vi.importActual<typeof import("fflate")>("fflate");
const gzipSync = vi.mocked(fflate.gzipSync);

/** The keepalive path gzips with fflate (by default these tests keep plain bodies, sized as their JSON). */
function useRealGzip(): void {
  gzipSync.mockImplementation(realFflate.gzipSync);
}

const API_HOST = "https://ingest.example.com";

interface Call {
  url: string;
  keepalive: boolean;
  headers: Record<string, string>;
  bytes: number;
  chunk: { session_id: string; seq: number; events: unknown[] };
}

describe("ReplaySender", () => {
  let calls: Call[];
  let respond: (url: string, keepalive: boolean) => Promise<Response>;
  let seqs: Map<string, number>;

  function sender(overrides: Partial<SenderOptions> = {}): ReplaySender {
    return new ReplaySender({
      apiHost: API_HOST,
      token: "tok",
      maxRetryDelayMs: 60_000,
      nextSeq: (id) => {
        const seq = seqs.get(id) ?? 0;
        seqs.set(id, seq + 1);
        return seq;
      },
      onQuotaExceeded: () => {},
      log: () => {},
      random: () => 0.5, // no jitter
      ...overrides,
    });
  }

  /** A chunk of `count` events of about `eventBytes` serialized bytes each. */
  function chunk(s: ReplaySender, count = 1, eventBytes = 10, extra: Partial<ReplayChunk> = {}): ReplayChunk {
    const events = Array.from({ length: count }, (_, i) => ({
      type: 3,
      timestamp: 1,
      data: { i, pad: "x".repeat(Math.max(0, eventBytes - 40)) },
    }));
    return s.chunk({
      sessionId: "s1",
      distinctId: "d1",
      mode: "session",
      eventsJson: JSON.stringify(events),
      count,
      ...extra,
    });
  }

  /** A chunk of the given events. */
  function eventsChunk(s: ReplaySender, events: object[], extra: Partial<ReplayChunk> = {}): ReplayChunk {
    return s.chunk({
      sessionId: "s1",
      distinctId: "d1",
      mode: "session",
      eventsJson: JSON.stringify(events),
      count: events.length,
      ...extra,
    });
  }

  const meta = { type: 4, timestamp: 1, data: { href: "https://app.example.com/" } };
  const snapshot = (padBytes = 0) => ({ type: 2, timestamp: 1, data: { node: {}, pad: "x".repeat(padBytes) } });
  const incremental = { type: 3, timestamp: 2, data: { source: 2 } };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 14));
    vi.stubGlobal("CompressionStream", undefined);
    gzipSync.mockReset();
    gzipSync.mockImplementation(() => {
      throw new Error("plain bodies in this test");
    });
    calls = [];
    seqs = new Map();
    respond = async () => new Response('{"status":1}', { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string | Uint8Array; keepalive: boolean; headers: Record<string, string> }) => {
        const text =
          typeof init.body === "string" ? init.body : gunzipSync(Buffer.from(init.body)).toString();
        const bytes = typeof init.body === "string" ? Buffer.byteLength(init.body) : init.body.byteLength;
        calls.push({ url, keepalive: init.keepalive, headers: init.headers, bytes, chunk: JSON.parse(text) });
        return respond(url, init.keepalive);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("keepalive flush", () => {
    it("two flushes in a row (visibilitychange, then pagehide) send each chunk once", async () => {
      const s = sender();
      s.enqueue([chunk(s), chunk(s)], false);
      const first = s.flushKeepalive(false);
      const second = s.flushKeepalive(true);
      await Promise.all([first, second]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.map((c) => [c.chunk.seq, c.keepalive])).toEqual([
        [0, true],
        [1, true],
      ]);
    });

    it("stops at the 63 KiB budget and leaves the rest queued whole", async () => {
      respond = () => new Promise(() => {}); // the page is closing: nothing answers
      const s = sender();
      const chunks = [0, 1, 2, 3].map(() => chunk(s, 2, 20_000)); // ~40 KB each
      s.enqueue(chunks, false);
      await s.flushKeepalive(true);

      const keepalive = calls.filter((c) => c.keepalive);
      expect(keepalive.reduce((sum, c) => sum + c.bytes, 0)).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
      // The first chunk whole, the first half of the second; then the budget is spent.
      expect(keepalive.map((c) => [c.chunk.seq, c.chunk.events.length])).toEqual([
        [0, 2],
        [1, 1],
      ]);
      expect(s.pending.filter((c) => c.seq === 2 || c.seq === 3).map((c) => c.count)).toEqual([2, 2]);
    });

    it("a backgrounded tab never splits: a chunk too big stays whole, smaller ones still go", async () => {
      respond = () => new Promise(() => {});
      const s = sender();
      const big = chunk(s, 4, 20_000); // ~80 KB
      const small = chunk(s);
      s.enqueue([big, small], false);
      await s.flushKeepalive(false);

      expect(calls.filter((c) => c.keepalive).map((c) => c.chunk.seq)).toEqual([small.seq]);
      expect(s.pending.find((c) => c.seq === big.seq)?.count).toBe(4);
    });

    it("pagehide during a backgrounded flush still splits what is left, within the same budget", async () => {
      respond = () => new Promise(() => {}); // the page is closing: nothing answers
      const s = sender();
      const big = chunk(s, 4, 20_000); // ~80 KB: over the budget whole
      const small = chunk(s, 1, 20_000);
      s.enqueue([big, small], false);
      const hidden = s.flushKeepalive(false); // visibilitychange
      expect(calls.map((c) => c.chunk.seq)).toEqual([small.seq]);
      const pagehide = s.flushKeepalive(true); // arrives before anything resumes
      // Its fetch started inside the call: no await between the handler and the request.
      expect(calls.map((c) => [c.chunk.seq, c.chunk.events.length])).toEqual([
        [small.seq, 1],
        [big.seq, 2],
      ]);
      await Promise.all([hidden, pagehide]);

      const keepalive = calls.filter((c) => c.keepalive);
      expect(keepalive.reduce((sum, c) => sum + c.bytes, 0)).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
      // The small chunk whole, then the first half of the big one; nothing twice.
      expect(keepalive.map((c) => [c.chunk.seq, c.chunk.events.length])).toEqual([
        [small.seq, 1],
        [big.seq, 2],
      ]);
      expect(s.pending.filter((c) => !c.keepalive).map((c) => c.count)).toEqual([2]);
    });

    it("gzips keepalive bodies and puts token and compression in the query", async () => {
      vi.stubGlobal("CompressionStream", NodeCompressionStream);
      useRealGzip();
      const s = sender();
      s.enqueue([chunk(s, 3)], false);
      await s.flushKeepalive(true);

      expect(calls).toHaveLength(1);
      expect(calls[0].keepalive).toBe(true);
      expect(calls[0].url).toBe(`${API_HOST}/replay?token=tok&compression=gzip`);
      expect(calls[0].headers).toEqual({ "content-type": "text/plain;charset=UTF-8" });
      expect(calls[0].chunk.events).toHaveLength(3);
    });

    it("starts the first keepalive fetch inside the flush call, with a gzip body and no await before it", () => {
      useRealGzip();
      const s = sender();
      const queued = chunk(s, 3);
      s.enqueue([queued], false);

      void s.flushKeepalive(true);

      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: Uint8Array; keepalive: boolean }];
      expect(url).toBe(`${API_HOST}/replay?token=tok&compression=gzip`);
      expect(init.keepalive).toBe(true);
      const json = realFflate.strFromU8(realFflate.gunzipSync(init.body));
      expect(JSON.parse(json)).toEqual(JSON.parse(chunkJson(queued)));
    });

    it("sends plain JSON, still inside the flush call, when gzipSync throws", () => {
      const s = sender();
      const queued = chunk(s, 3);
      s.enqueue([queued], false);

      void s.flushKeepalive(true);

      const fetchMock = vi.mocked(fetch);
      expect(gzipSync).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: unknown; keepalive: boolean }];
      expect(url).toBe(`${API_HOST}/replay?token=tok`);
      expect(init.keepalive).toBe(true);
      expect(init.body).toBe(chunkJson(queued));
    });

    it("never compresses a chunk over MAX_CHUNK_BYTES on the keepalive path: it stays queued whole", async () => {
      useRealGzip();
      respond = () => new Promise(() => {});
      const s = sender();
      const big = chunk(s, 2, MAX_CHUNK_BYTES / 2 + 100);
      s.enqueue([big], false);
      await s.flushKeepalive(true);

      expect(gzipSync).not.toHaveBeenCalled();
      expect(calls.filter((c) => c.keepalive)).toEqual([]);
      expect(s.pending.filter((c) => c.seq === big.seq).map((c) => c.count)).toEqual([2]);
    });

    it("leaves later chunks of a session queued when its FullSnapshot does not fit; other sessions still go", async () => {
      respond = () => new Promise(() => {});
      const s = sender();
      // Only a Meta and its FullSnapshot, over the budget: never split, so it stays.
      const x0 = eventsChunk(s, [meta, snapshot(80_000)], { sessionId: "x", hasSnapshot: true });
      const y0 = eventsChunk(s, [incremental], { sessionId: "y" });
      const x1 = eventsChunk(s, [incremental], { sessionId: "x" });
      s.enqueue([x0, y0, x1], false);
      await s.flushKeepalive(true);

      expect(calls.filter((c) => c.keepalive).map((c) => c.chunk.session_id)).toEqual(["y"]);
      expect(s.pending.filter((c) => c.sessionId === "x").map((c) => c.count)).toEqual([2, 1]);
    });

    it("sends the later chunks of a session when its FullSnapshot fits", async () => {
      respond = () => new Promise(() => {});
      const s = sender();
      const x0 = eventsChunk(s, [meta, snapshot()], { sessionId: "x", hasSnapshot: true });
      const y0 = eventsChunk(s, [incremental], { sessionId: "y" });
      const x1 = eventsChunk(s, [incremental], { sessionId: "x" });
      s.enqueue([x0, y0, x1], false);
      await s.flushKeepalive(true);

      expect(calls.filter((c) => c.keepalive).map((c) => [c.chunk.session_id, c.chunk.seq])).toEqual([
        ["x", x0.seq],
        ["y", y0.seq],
        ["x", x1.seq],
      ]);
    });

    it("with little budget left, skips a chunk too big to split and still sends a smaller one after it", () => {
      respond = () => new Promise(() => {});
      const s = sender();
      const first = chunk(s, 1, 52 * 1024); // leaves about 10 KiB of the budget
      const mid = chunk(s, 3, 5_000); // ~15 KiB: does not fit, too little left to split
      const tail = chunk(s, 1, 1_000);
      s.enqueue([first, mid, tail], false);
      void s.flushKeepalive(true);

      expect(KEEPALIVE_BUDGET_BYTES - calls[0].bytes).toBeLessThan(16 * 1024);
      expect(calls.map((c) => c.chunk.seq)).toEqual([first.seq, tail.seq]);
      expect(s.pending.find((c) => c.seq === mid.seq)?.count).toBe(3);
    });

    it("measures MAX_CHUNK_BYTES in UTF-8: a chunk under it in UTF-16 but over in UTF-8 is never compressed", () => {
      useRealGzip();
      respond = () => new Promise(() => {});
      const s = sender();
      const wide = eventsChunk(s, [{ type: 3, timestamp: 1, data: { pad: "é".repeat(600_000) } }]);
      expect(chunkJson(wide).length).toBeLessThan(MAX_CHUNK_BYTES);
      expect(Buffer.byteLength(chunkJson(wide))).toBeGreaterThan(MAX_CHUNK_BYTES);
      s.enqueue([wide], false);
      void s.flushKeepalive(true);

      // Gzipped, it would fit the budget easily: only the UTF-8 size keeps it out.
      expect(gzipSync).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(s.pending.map((c) => c.count)).toEqual([1]);
    });

    it("on pagehide drops what follows the FullSnapshot from a session's head so its start still goes", () => {
      respond = () => new Promise(() => {});
      const s = sender();
      const x0 = eventsChunk(s, [incremental], { sessionId: "x" });
      const tail = { type: 3, timestamp: 2, data: { source: 2, pad: "z".repeat(40_000) } };
      const x1 = eventsChunk(s, [meta, snapshot(30_000), tail], { sessionId: "x", hasSnapshot: true });
      s.enqueue([x0, x1], false);
      void s.flushKeepalive(true);

      expect(calls.map((c) => [c.chunk.seq, (c.chunk.events as { type: number }[]).map((e) => e.type)])).toEqual([
        [x0.seq, [3]],
        [x1.seq, [4, 2]],
      ]);
      expect(s.pending.filter((c) => !c.keepalive).map((c) => [c.count, c.hasSnapshot])).toEqual([[1, false]]);
    });

    describe("with real gzip", () => {
      /** Text gzip barely shrinks (deterministic pseudo-random base 36). */
      function noise(length: number): string {
        let state = 1;
        const out: string[] = [];
        while (out.length < length) {
          state = (state + 0x6d2b79f5) | 0;
          let t = Math.imul(state ^ (state >>> 15), state | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          out.push((((t ^ (t >>> 14)) >>> 0) % 36).toString(36));
        }
        return out.join("");
      }

      beforeEach(() => {
        useRealGzip();
        respond = () => new Promise(() => {}); // the page is closing: nothing answers
      });

      it("never sends the start of a session without its snapshot: a small prefix waits with a FullSnapshot whose gzip is over the budget", () => {
        const s = sender();
        const x0 = eventsChunk(s, [incremental], { sessionId: "x" });
        const x1 = eventsChunk(s, [meta, { ...snapshot(), data: { node: {}, pad: noise(150_000) } }], {
          sessionId: "x",
          hasSnapshot: true,
        });
        const y0 = eventsChunk(s, [incremental], { sessionId: "y" });
        const x2 = eventsChunk(s, [incremental], { sessionId: "x" });
        s.enqueue([x0, x1, y0, x2], false);
        void s.flushKeepalive(true);

        expect(calls.map((c) => [c.chunk.session_id, c.chunk.seq])).toEqual([["y", y0.seq]]);
        expect(calls.every((c) => c.keepalive)).toBe(true);
        expect(s.pending.filter((c) => c.sessionId === "x").map((c) => c.seq)).toEqual([x0.seq, x1.seq, x2.seq]);
      });

      it("sends a session's whole head in order when its gzip fits, within the budget", () => {
        const s = sender();
        const x0 = eventsChunk(s, [incremental], { sessionId: "x" });
        // 500 KB as JSON, about 1 KB gzipped: only the gzip makes it fit.
        const x1 = eventsChunk(s, [meta, snapshot(500_000)], { sessionId: "x", hasSnapshot: true });
        const y0 = eventsChunk(s, [incremental], { sessionId: "y" });
        const x2 = eventsChunk(s, [incremental], { sessionId: "x" });
        s.enqueue([x0, x1, y0, x2], false);
        void s.flushKeepalive(true);

        expect(calls.map((c) => [c.chunk.session_id, c.chunk.seq])).toEqual([
          ["x", x0.seq],
          ["x", x1.seq],
          ["y", y0.seq],
          ["x", x2.seq],
        ]);
        expect(calls.every((c) => c.url.endsWith("compression=gzip"))).toBe(true);
        expect(calls.reduce((sum, c) => sum + c.bytes, 0)).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);
      });

      it("stops at the budget measured on the gzip bodies and leaves the rest queued whole", () => {
        const s = sender();
        const chunks = [0, 1, 2].map((i) =>
          eventsChunk(s, [{ ...incremental, data: { source: 2, i, pad: noise(60_000) } }]),
        ); // ~40 KB gzipped each: one fits, two do not
        s.enqueue(chunks, false);
        void s.flushKeepalive(false);

        expect(calls.map((c) => c.chunk.seq)).toEqual([chunks[0].seq]);
        expect(calls[0].bytes).toBeLessThan(60_000);
        expect(s.pending.filter((c) => !c.keepalive).map((c) => c.seq)).toEqual([chunks[1].seq, chunks[2].seq]);
      });
    });
  });

  describe("Meta + FullSnapshot pair", () => {
    it("a split never cuts between a Meta and the FullSnapshot after it", async () => {
      const responses = [413, 200, 200];
      respond = async () => new Response("{}", { status: responses.shift() ?? 200 });
      const s = sender();
      s.enqueue([eventsChunk(s, [incremental, meta, snapshot()])]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.map((c) => (c.chunk.events as { type: number }[]).map((e) => e.type))).toEqual([
        [3, 4, 2],
        [3],
        [4, 2],
      ]);
    });

    it("a chunk with only the pair cannot be split: on 413 it is dropped, never half sent", async () => {
      respond = async () => new Response("{}", { status: 413 });
      const s = sender();
      s.enqueue([eventsChunk(s, [meta, snapshot()], { hasSnapshot: true })]);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(calls.map((c) => c.chunk.events.length)).toEqual([2]);
      expect(s.pending).toHaveLength(0);
    });
  });

  describe("retry contract", () => {
    it("400 drops the chunk and moves on", async () => {
      respond = async () => new Response("{}", { status: 400 });
      const s = sender();
      s.enqueue([chunk(s)]);
      await vi.advanceTimersByTimeAsync(0);
      respond = async () => new Response("{}", { status: 200 });
      s.enqueue([chunk(s)]);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(calls.map((c) => c.chunk.seq)).toEqual([0, 1]);
    });

    it("401 keeps the chunk and waits the maximum backoff", async () => {
      respond = async () => new Response("{}", { status: 401 });
      const s = sender();
      s.enqueue([chunk(s)]);
      await vi.advanceTimersByTimeAsync(0);
      respond = async () => new Response("{}", { status: 200 });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.map((c) => c.chunk.seq)).toEqual([0, 0]);
      expect(s.pending).toHaveLength(0);
    });

    it("a network error backs off exponentially from 2 s", async () => {
      respond = async () => {
        throw new TypeError("Failed to fetch");
      };
      const s = sender();
      s.enqueue([chunk(s)]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(3999);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);
    });

    it.each([
      ["503 with Retry-After: 0", 503, { "retry-after": "0" }],
      ["408", 408, {}],
    ])("%s is retried after the base delay, never in a tight loop", async (_, status, headers) => {
      respond = async () => new Response("{}", { status, headers });
      const s = sender();
      s.enqueue([chunk(s)]);
      await vi.advanceTimersByTimeAsync(0);
      respond = async () => new Response("{}", { status: 200 });
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      expect(s.pending).toHaveLength(0);
    });

    it("404 stops the sender for good and reports it", async () => {
      respond = async () => new Response("{}", { status: 404 });
      const onGone = vi.fn();
      const s = sender({ onGone });
      s.enqueue([chunk(s), chunk(s)]);
      await vi.advanceTimersByTimeAsync(0);
      s.enqueue([chunk(s)]);
      await vi.advanceTimersByTimeAsync(600_000);
      await s.flushKeepalive(true);

      expect(onGone).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
    });
  });

  describe("memory bound", () => {
    it("drops a whole error batch past 5 MB (a batch without its snapshot is unplayable)", async () => {
      const onDropped = vi.fn();
      const s = sender({ onDropped });
      const batch = [0, 1, 2].map(() => chunk(s, 1, 2_000_000, { mode: "error", batch: 7 }));
      const later = chunk(s, 1, 10, { mode: "error", batch: 8 });
      s.enqueue([...batch, later]);
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.map((c) => c.chunk.seq)).toEqual([later.seq]);
      expect(onDropped).toHaveBeenCalledTimes(1);
    });

    it("drops the oldest session chunk past 5 MB and reports it", async () => {
      const onDropped = vi.fn();
      const s = sender({ onDropped });
      const chunks = [0, 1, 2, 3, 4, 5].map(() => chunk(s, 1, 900_000));
      s.enqueue(chunks);
      await vi.advanceTimersByTimeAsync(0);

      expect(onDropped).toHaveBeenCalledWith(expect.objectContaining({ seq: 0, mode: "session" }));
      expect(calls.map((c) => c.chunk.seq)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
