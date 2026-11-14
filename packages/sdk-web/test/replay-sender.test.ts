import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayChunk, SenderOptions } from "../src/replay/sender.js";
import { KEEPALIVE_BUDGET_BYTES, ReplaySender } from "../src/replay/sender.js";

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

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 14));
    vi.stubGlobal("CompressionStream", undefined);
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
      const pagehide = s.flushKeepalive(true); // arrives while the first one runs
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
      const s = sender();
      s.enqueue([chunk(s, 3)], false);
      await s.flushKeepalive(true);

      expect(calls).toHaveLength(1);
      expect(calls[0].keepalive).toBe(true);
      expect(calls[0].url).toBe(`${API_HOST}/replay?token=tok&compression=gzip`);
      expect(calls[0].headers).toEqual({ "content-type": "text/plain;charset=UTF-8" });
      expect(calls[0].chunk.events).toHaveLength(3);
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
