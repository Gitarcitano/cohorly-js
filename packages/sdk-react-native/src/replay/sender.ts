/**
 * Sends replay chunks to `POST {apiHost}/replay`, the web SDK's sender
 * (`@cohorly/web` replay/sender.ts) without its page-unload paths. Memory
 * only, never persisted: the outbox is bounded and the oldest chunks go
 * first past {@link MAX_OUTBOX_BYTES} (UTF-8 bytes of the events). One
 * request in flight at a time, each after `beforeSend` (the seq it carries
 * is persisted first).
 * Outcomes, as on the web:
 * - 2xx: done.
 * - 408, 429, 5xx, network error: kept, retried with exponential backoff
 *   honoring `Retry-After`.
 * - 401: kept, retried at the maximum backoff.
 * - 413: split in two (a chunk of one event, or of a Meta and its
 *   FullSnapshot only, is dropped).
 * - 404: replay is not served there; nothing more is sent by this process.
 * - 429 `replay quota exceeded`: dropped, with the session's other
 *   session-mode chunks, and `onQuotaExceeded` pauses session recording.
 * - any other 4xx: dropped.
 */
import type { ChunkMode, ReplayChunk } from "./chunks.js";
import { chunkJson, eventType, FULL_SNAPSHOT, META, utf8Length } from "./chunks.js";

export const MAX_OUTBOX_BYTES = 5 * 1024 * 1024;
export const BASE_RETRY_MS = 2000;
/** Without Retry-After on a quota refusal, session recording waits this long. */
export const DEFAULT_QUOTA_PAUSE_MS = 60 * 60 * 1000;
export const QUOTA_ERROR = "replay quota exceeded";

export interface SenderOptions {
  apiHost: string;
  token: string | undefined;
  /** The client's fetch, read on every send. */
  fetch: () => typeof fetch | undefined;
  maxRetryDelayMs: number;
  /** Next seq of a session (live or rotated out). */
  nextSeq: (sessionId: string) => number;
  /** A `mode: "session"` chunk was refused by the replay quota. */
  onQuotaExceeded: (retryAfterMs: number) => void;
  /** 404 on /replay: nothing more is sent. */
  onGone: () => void;
  /** The outbox bound or an unsplittable 413 dropped this chunk. */
  onDropped?: (chunk: ReplayChunk) => void;
  /** Awaited before each request: the seqs taken so far are persisted. */
  beforeSend?: () => Promise<void>;
  random?: () => number;
}

type Outcome =
  | { kind: "ok" }
  | { kind: "retry"; retryAfterMs?: number; max?: boolean }
  | { kind: "split" }
  | { kind: "drop" }
  | { kind: "gone" }
  | { kind: "quota"; retryAfterMs?: number };

async function classify(res: Response): Promise<Outcome> {
  if (res.ok) return { kind: "ok" };
  const header = res.headers?.get?.("retry-after") ?? null;
  const seconds = header === null ? Number.NaN : Number(header.trim());
  const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
  if (res.status === 429) {
    let error: unknown;
    try {
      error = ((await res.json()) as { error?: unknown } | null)?.error;
    } catch {
      error = undefined;
    }
    if (error === QUOTA_ERROR) return { kind: "quota", retryAfterMs };
    return { kind: "retry", retryAfterMs };
  }
  if (res.status === 413) return { kind: "split" };
  if (res.status === 401) return { kind: "retry", max: true };
  if (res.status === 404) return { kind: "gone" };
  if (res.status === 408 || res.status >= 500) return { kind: "retry", retryAfterMs };
  return { kind: "drop" };
}

/** UTF-8 size of each chunk's events, computed once per chunk object. */
const sizes = new WeakMap<ReplayChunk, number>();
function chunkBytes(chunk: ReplayChunk): number {
  let size = sizes.get(chunk);
  if (size === undefined) {
    size = utf8Length(chunk.eventsJson);
    sizes.set(chunk, size);
  }
  return size;
}

export class ReplaySender {
  private outbox: ReplayChunk[] = [];
  private failures = 0;
  private backoffUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  /** Bumped by shutdown(): responses of older requests change nothing. */
  private epoch = 0;
  private closed = false;
  private readonly random: () => number;

  constructor(private readonly options: SenderOptions) {
    this.random = options.random ?? Math.random;
  }

  get pending(): readonly ReplayChunk[] {
    return this.outbox;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Builds a chunk with its seq taken now, from its own session. */
  chunk(fields: { sessionId: string; distinctId: string; mode: ChunkMode; eventsJson: string; batch?: number }): ReplayChunk {
    return { ...fields, seq: this.options.nextSeq(fields.sessionId) };
  }

  enqueue(chunks: ReplayChunk[]): void {
    if (this.closed || chunks.length === 0) return;
    this.outbox.push(...chunks);
    this.enforceBound();
    this.pump();
  }

  /** Sends now, past the backoff (an app about to die). */
  flushNow(): void {
    if (this.closed) return;
    this.backoffUntil = 0;
    this.pump();
  }

  /** Stops for good: the outbox is dropped and nothing is sent or retried. */
  shutdown(): void {
    this.epoch += 1;
    this.closed = true;
    this.outbox = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drops the session-mode chunks of a session not on the wire (refused by the quota). */
  dropSessionChunks(sessionId: string): void {
    this.outbox = this.outbox.filter((c) => c.inFlight || c.mode !== "session" || c.sessionId !== sessionId);
  }

  private url(): string {
    return `${this.options.apiHost.replace(/\/+$/, "")}/replay`;
  }

  private enforceBound(): void {
    let total = this.outbox.reduce((sum, c) => sum + chunkBytes(c), 0);
    while (total > MAX_OUTBOX_BYTES) {
      const victim = this.outbox.find((c) => !c.inFlight);
      if (!victim) break;
      // An error batch without its first chunk has no snapshot: all of it goes.
      const gone =
        victim.batch === undefined
          ? [victim]
          : this.outbox.filter((c) => c.batch === victim.batch && !c.inFlight);
      this.outbox = this.outbox.filter((c) => !gone.includes(c));
      for (const c of gone) total -= chunkBytes(c);
      this.options.onDropped?.(victim);
    }
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.pump();
      },
      Math.max(0, delay),
    );
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Sends the head of the outbox, one request at a time, honoring the backoff. */
  pump(): void {
    if (this.sending || this.closed) return;
    const wait = this.backoffUntil - Date.now();
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    const chunk = this.outbox.find((c) => !c.inFlight);
    if (!chunk) return;
    this.sending = true;
    void this.send(chunk).finally(() => {
      this.sending = false;
      this.pump();
    });
  }

  private remove(chunk: ReplayChunk): void {
    const index = this.outbox.indexOf(chunk);
    if (index >= 0) this.outbox.splice(index, 1);
  }

  private async send(chunk: ReplayChunk): Promise<void> {
    const epoch = this.epoch;
    chunk.inFlight = true;
    let outcome: Outcome;
    try {
      // The seq this chunk carries must survive a relaunch before the server sees it.
      await this.options.beforeSend?.();
      if (epoch !== this.epoch) return;
      const fetchImpl = this.options.fetch();
      if (!fetchImpl) throw new Error("no fetch");
      const res = await fetchImpl(this.url(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.token !== undefined ? { "x-cohorly-token": this.options.token } : {}),
        },
        body: chunkJson(chunk),
      });
      outcome = await classify(res);
    } catch {
      outcome = { kind: "retry" };
    } finally {
      chunk.inFlight = false;
    }
    if (epoch !== this.epoch) return;
    this.handle(chunk, outcome);
  }

  private handle(chunk: ReplayChunk, outcome: Outcome): void {
    if (outcome.kind === "ok") {
      this.remove(chunk);
      this.failures = 0;
      this.backoffUntil = 0;
      return;
    }
    if (!this.outbox.includes(chunk)) return;
    switch (outcome.kind) {
      case "drop":
        this.remove(chunk);
        return;
      case "gone":
        this.shutdown();
        this.options.onGone();
        return;
      case "split": {
        const halves = this.split(chunk);
        const index = this.outbox.indexOf(chunk);
        if (!halves) {
          this.outbox.splice(index, 1);
          this.options.onDropped?.(chunk);
          return;
        }
        this.outbox.splice(index, 1, ...halves);
        return;
      }
      case "quota": {
        this.remove(chunk);
        if (chunk.mode === "session") this.dropSessionChunks(chunk.sessionId);
        this.options.onQuotaExceeded(outcome.retryAfterMs ?? DEFAULT_QUOTA_PAUSE_MS);
        return;
      }
      case "retry": {
        this.failures += 1;
        const max = this.options.maxRetryDelayMs;
        let delay: number;
        if (outcome.max) {
          delay = max;
        } else if (outcome.retryAfterMs !== undefined && outcome.retryAfterMs > 0) {
          delay = Math.min(outcome.retryAfterMs, max);
        } else {
          // No Retry-After, or Retry-After: 0 - never a tight loop.
          const capped = Math.min(BASE_RETRY_MS * 2 ** (this.failures - 1), max);
          delay = Math.max(0, Math.round(capped + capped * 0.2 * (this.random() * 2 - 1)));
        }
        this.backoffUntil = Date.now() + delay;
        return;
      }
    }
  }

  /**
   * Two chunks with about half the events each, or null when it holds a
   * single event or only a Meta and its FullSnapshot (never cut apart). The
   * first half keeps the seq; the second takes a new one from the same
   * session (the server tolerates gaps and orders events by timestamp).
   */
  private split(chunk: ReplayChunk): [ReplayChunk, ReplayChunk] | null {
    let events: unknown[];
    try {
      events = JSON.parse(chunk.eventsJson) as unknown[];
    } catch {
      return null;
    }
    if (!Array.isArray(events) || events.length < 2) return null;
    const middle = Math.ceil(events.length / 2);
    let cut = -1;
    for (let offset = 0; offset < events.length && cut < 0; offset += 1) {
      for (const at of [middle - offset, middle + offset]) {
        if (
          at >= 1 &&
          at < events.length &&
          !(eventType(events[at - 1]) === META && eventType(events[at]) === FULL_SNAPSHOT)
        ) {
          cut = at;
          break;
        }
      }
    }
    if (cut < 0) return null;
    const base = { ...chunk, inFlight: false };
    return [
      { ...base, eventsJson: JSON.stringify(events.slice(0, cut)) },
      { ...base, eventsJson: JSON.stringify(events.slice(cut)), seq: this.options.nextSeq(chunk.sessionId) },
    ];
  }
}
