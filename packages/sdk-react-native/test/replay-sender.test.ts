import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChunkMode, type ReplayChunk, utf8Length } from "../src/replay/chunks.js";
import { MAX_OUTBOX_BYTES, ReplaySender } from "../src/replay/sender.js";
import { full, meta, type RrEvent, settle, touch, useClock } from "./replay-helpers.js";

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const MAX_RETRY = 60_000;

beforeEach(() => useClock(T0));
afterEach(() => {
  vi.useRealTimers();
});

interface Sent {
  sessionId: string;
  seq: number;
  mode: ChunkMode;
  events: RrEvent[];
}

type Answer = Response | Error | "hang";

/** A sender whose fetch answers from `answers` in order (then 200), recording each body. */
function makeSender(answers: Answer[] = [], beforeSend?: () => Promise<void>) {
  const sent: Sent[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const seqs = new Map<string, number>();
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ sessionId: body.session_id, seq: body.seq, mode: body.mode, events: body.events });
    const answer = answers.shift() ?? new Response("", { status: 200 });
    if (answer === "hang") return new Promise<Response>(() => {});
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const onQuotaExceeded = vi.fn<(ms: number) => void>();
  const onGone = vi.fn();
  const onDropped = vi.fn<(chunk: ReplayChunk) => void>();
  const sender = new ReplaySender({
    apiHost: "http://localhost:4000",
    token: "proj_test",
    fetch: () => fetchImpl as unknown as typeof fetch,
    maxRetryDelayMs: MAX_RETRY,
    random: () => 0.5, // no jitter: the first backoff is exactly 2 s
    nextSeq: (sessionId) => {
      const seq = seqs.get(sessionId) ?? 0;
      seqs.set(sessionId, seq + 1);
      return seq;
    },
    onQuotaExceeded,
    onGone,
    onDropped,
    beforeSend,
  });
  const chunk = (events: RrEvent[], fields: { sessionId?: string; mode?: ChunkMode; batch?: number } = {}) =>
    sender.chunk({
      sessionId: fields.sessionId ?? "s1",
      distinctId: "u1",
      mode: fields.mode ?? "session",
      eventsJson: JSON.stringify(events),
      ...(fields.batch !== undefined ? { batch: fields.batch } : {}),
    });
  return { sender, chunk, sent, fetchImpl, onQuotaExceeded, onGone, onDropped, maxInFlight: () => maxInFlight };
}

const status = (code: number, headers: Record<string, string> = {}, body = "") =>
  new Response(body, { status: code, headers });

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

describe("ReplaySender", () => {
  it("sends chunks in order, one request at a time, and forgets them once accepted", async () => {
    const { sender, chunk, sent, maxInFlight } = makeSender();
    sender.enqueue([chunk([meta(T0), full(T0)]), chunk([touch(T0 + 1)])]);
    await settle();
    expect(sent.map((s) => s.seq)).toEqual([0, 1]);
    expect(maxInFlight()).toBe(1);
    expect(sender.pending).toHaveLength(0);
  });

  it.each([
    ["408", () => status(408)],
    ["429 rate limit", () => status(429, {}, JSON.stringify({ status: 0, error: "rate limited" }))],
    ["500", () => status(500)],
    ["503", () => status(503)],
    ["a network error", () => new TypeError("Network request failed")],
  ])("keeps the chunk on %s and retries it after the 2 s backoff", async (_label, answer) => {
    const { sender, chunk, sent } = makeSender([answer()]);
    sender.enqueue([chunk([touch(T0)])]);
    await settle();
    expect(sent).toHaveLength(1);
    await advance(1999);
    expect(sent).toHaveLength(1);
    await advance(1);
    expect(sent.map((s) => s.seq)).toEqual([0, 0]);
    expect(sender.pending).toHaveLength(0);
  });

  it("doubles the delay on a second consecutive failure", async () => {
    const { sender, chunk, sent } = makeSender([status(500), status(500)]);
    sender.enqueue([chunk([touch(T0)])]);
    await settle();
    await advance(2000);
    expect(sent).toHaveLength(2);
    await advance(3999);
    expect(sent).toHaveLength(2);
    await advance(1);
    expect(sent).toHaveLength(3);
    expect(sender.pending).toHaveLength(0);
  });

  it("sends nothing until beforeSend resolved (the seq is persisted first)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sender, chunk, sent } = makeSender([], () => gate);
    sender.enqueue([chunk([touch(T0)])]);
    await settle();
    expect(sent).toHaveLength(0);
    release();
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("honors Retry-After", async () => {
    const { sender, chunk, sent } = makeSender([status(503, { "retry-after": "7" })]);
    sender.enqueue([chunk([touch(T0)])]);
    await settle();
    await advance(6999);
    expect(sent).toHaveLength(1);
    await advance(1);
    expect(sent).toHaveLength(2);
  });

  it("keeps the chunk on 401 and retries only after the maximum backoff", async () => {
    const { sender, chunk, sent } = makeSender([status(401)]);
    sender.enqueue([chunk([touch(T0)])]);
    await settle();
    await advance(MAX_RETRY - 1);
    expect(sent).toHaveLength(1);
    await advance(1);
    expect(sent).toHaveLength(2);
  });

  it("splits a chunk refused with 413 in two, the second with a new seq", async () => {
    const { sender, chunk, sent } = makeSender([status(413)]);
    const events = [meta(T0), full(T0), touch(T0 + 1), touch(T0 + 2)];
    sender.enqueue([chunk(events)]);
    await settle();
    expect(sent.slice(1)).toEqual([
      { sessionId: "s1", seq: 0, mode: "session", events: [meta(T0), full(T0)] },
      { sessionId: "s1", seq: 1, mode: "session", events: [touch(T0 + 1), touch(T0 + 2)] },
    ]);
  });

  it.each([
    ["a single event", [touch(T0)]],
    ["a Meta and its FullSnapshot only", [meta(T0), full(T0)]],
  ])("drops a chunk of %s refused with 413 instead of retrying it", async (_label, events) => {
    const { sender, chunk, sent, onDropped } = makeSender([status(413)]);
    sender.enqueue([chunk(events)]);
    await advance(MAX_RETRY * 2);
    expect(sent).toHaveLength(1);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(sender.pending).toHaveLength(0);
  });

  it.each([400, 422])("drops a chunk refused with %i and goes on with the next one at once", async (code) => {
    const { sender, chunk, sent } = makeSender([status(code)]);
    sender.enqueue([chunk([touch(T0)]), chunk([touch(T0 + 1)])]);
    await settle();
    expect(sent.map((s) => s.seq)).toEqual([0, 1]);
    expect(sender.pending).toHaveLength(0);
  });

  it("stops for good on 404", async () => {
    const { sender, chunk, sent, onGone } = makeSender([status(404)]);
    sender.enqueue([chunk([touch(T0)]), chunk([touch(T0 + 1)])]);
    await settle();
    expect(onGone).toHaveBeenCalledTimes(1);
    sender.enqueue([chunk([touch(T0 + 2)])]);
    await advance(MAX_RETRY * 2);
    expect(sent).toHaveLength(1);
  });

  it("on a quota refusal drops that session's session-mode chunks, keeps the rest, and reports the Retry-After", async () => {
    const quota = JSON.stringify({ status: 0, error: "replay quota exceeded" });
    const { sender, chunk, sent, onQuotaExceeded } = makeSender([status(429, { "retry-after": "120" }, quota)]);
    sender.enqueue([
      chunk([touch(T0)]),
      chunk([touch(T0 + 1)]),
      chunk([touch(T0 + 2)], { mode: "error", batch: 1 }),
      chunk([touch(T0 + 3)], { sessionId: "s2" }),
    ]);
    await settle();
    expect(onQuotaExceeded).toHaveBeenCalledWith(120_000);
    expect(sent.map((s) => [s.sessionId, s.mode, s.seq])).toEqual([
      ["s1", "session", 0],
      ["s1", "error", 2],
      ["s2", "session", 0],
    ]);
  });

  it("pauses an hour when the quota refusal has no Retry-After", async () => {
    const quota = JSON.stringify({ status: 0, error: "replay quota exceeded" });
    const { sender, chunk, onQuotaExceeded } = makeSender([status(429, {}, quota)]);
    sender.enqueue([chunk([touch(T0)])]);
    await settle();
    expect(onQuotaExceeded).toHaveBeenCalledWith(3_600_000);
  });

  it("drops the oldest chunks past 5 MB, a whole error batch at a time, never the one on the wire", async () => {
    const { sender, chunk, sent, onDropped } = makeSender(["hang"]);
    const mb = (ts: number) => ({ type: 3, timestamp: ts, data: { blob: "x".repeat(1024 * 1024) } });
    sender.enqueue([chunk([mb(T0)])]); // on the wire, never answered
    await settle();
    sender.enqueue([
      chunk([mb(T0 + 1)], { mode: "error", batch: 7 }),
      chunk([mb(T0 + 2)], { mode: "error", batch: 7 }),
      chunk([mb(T0 + 3)]),
      chunk([mb(T0 + 4)]),
      chunk([mb(T0 + 5)]),
    ]);
    const total = sender.pending.reduce((sum, c) => sum + c.eventsJson.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_OUTBOX_BYTES);
    // The on-the-wire chunk stays, the whole error batch went.
    expect(sender.pending.map((c) => (JSON.parse(c.eventsJson) as RrEvent[])[0].timestamp)).toEqual([
      T0,
      T0 + 3,
      T0 + 4,
      T0 + 5,
    ]);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("bounds the outbox in UTF-8 bytes, so multibyte events cannot exceed 5 MB", async () => {
    const { sender, chunk } = makeSender(["hang"]);
    // 750 K "é": 0.75 MB of UTF-16 units, 1.5 MB of UTF-8 each.
    const accented = (ts: number) => ({ type: 3, timestamp: ts, data: { text: "é".repeat(750 * 1024) } });
    sender.enqueue([chunk([accented(T0)])]); // on the wire
    await settle();
    sender.enqueue([1, 2, 3, 4].map((i) => chunk([accented(T0 + i)])));
    const bytes = sender.pending.reduce((sum, c) => sum + utf8Length(c.eventsJson), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_OUTBOX_BYTES);
    // 5 chunks are only 3.75 MB of UTF-16 units: counted that way, none would go.
    expect(sender.pending.length).toBeLessThan(5);
  });

  it("flushNow() sends at once, past the backoff", async () => {
    const { sender, chunk, sent } = makeSender([status(500)]);
    sender.enqueue([chunk([touch(T0)])]);
    await settle();
    expect(sent).toHaveLength(1);
    sender.flushNow();
    await settle();
    expect(sent).toHaveLength(2);
  });
});
