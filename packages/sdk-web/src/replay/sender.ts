/**
 * Sends replay chunks to `POST {apiHost}/replay` (docs/SESSION-REPLAY.md
 * section 2). Memory only, never localStorage: the outbox is bounded and the
 * oldest chunks go first past {@link MAX_OUTBOX_BYTES}. A chunk gets its seq
 * when it is queued, from its own session (so chunks queued before a
 * rotation keep their session id and seq). One regular request in flight at
 * a time; the retry policy is the SDK retry contract (429/408/5xx/network:
 * keep and back off honoring Retry-After, 413: split, 400: drop, 401: keep at
 * max backoff), plus 404: replay is not served there, stop for this page.
 */
import { VERSION } from "../version.js";

export const MAX_OUTBOX_BYTES = 5 * 1024 * 1024;
/** Browsers refuse keepalive bodies above 64 KiB in flight; a margin for the rest of the request. */
export const KEEPALIVE_BUDGET_BYTES = 63 * 1024;
/** Below this much keepalive budget left, a chunk too big is left queued whole instead of split. */
const MIN_SPLIT_BUDGET_BYTES = 16 * 1024;
export const BASE_RETRY_MS = 2000;
/** Without Retry-After on a quota refusal, wait this long before trying session mode again. */
const DEFAULT_QUOTA_PAUSE_MS = 60 * 60 * 1000;
export const QUOTA_ERROR = "replay quota exceeded";

export type ChunkMode = "session" | "error";

export interface ReplayChunk {
  sessionId: string;
  distinctId: string;
  mode: ChunkMode;
  /** The rrweb events, already serialized as a JSON array. */
  eventsJson: string;
  count: number;
  seq: number;
  /** Chunks of one error send share it: dropping one drops the batch (it is unplayable without the rest). */
  batch?: number;
  /** A regular request carries it now. */
  inFlight?: boolean;
  /** A keepalive request carries it now. */
  keepalive?: boolean;
  /** Reserved by a keepalive flush (the regular sender leaves it alone). */
  claimed?: boolean;
}

export interface SenderOptions {
  apiHost: string;
  token: string | undefined;
  maxRetryDelayMs: number;
  /** Next seq of a session (live or rotated out). */
  nextSeq: (sessionId: string) => number;
  /** A `mode: "session"` chunk was refused by the replay quota. */
  onQuotaExceeded: (retryAfterMs: number) => void;
  /** 404 on /replay: nothing more is sent from this page load. */
  onGone?: () => void;
  /** The outbox bound dropped this chunk. */
  onDropped?: (chunk: ReplayChunk) => void;
  log: (...args: unknown[]) => void;
  random?: () => number;
}

interface Encoded {
  body: Uint8Array | string;
  gzip: boolean;
  bytes: number;
}

function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).byteLength;
  return text.length;
}

/** Gzip with CompressionStream where the browser has it, else the plain JSON. */
export async function encodeBody(json: string): Promise<Encoded> {
  if (typeof CompressionStream === "function" && typeof Response === "function") {
    try {
      const source = new Response(json).body;
      if (source) {
        const stream = source.pipeThrough(new CompressionStream("gzip"));
        const body = new Uint8Array(await new Response(stream).arrayBuffer());
        return { body, gzip: true, bytes: body.byteLength };
      }
    } catch {
      // fall through to plain JSON
    }
  }
  return { body: json, gzip: false, bytes: byteLength(json) };
}

export function chunkJson(chunk: ReplayChunk): string {
  const head = JSON.stringify({
    session_id: chunk.sessionId,
    distinct_id: chunk.distinctId,
    seq: chunk.seq,
    mode: chunk.mode,
    lib: "web",
    lib_version: VERSION,
  });
  return `${head.slice(0, -1)},"events":${chunk.eventsJson}}`;
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

export class ReplaySender {
  private outbox: ReplayChunk[] = [];
  private failures = 0;
  private backoffUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  /** The keepalive flush running now (passes chained by {@link flushKeepalive}). */
  private flushRun: Promise<void> | null = null;
  /** A split pass was asked for while a flush ran: it runs right after. */
  private splitQueued = false;
  /** Bumped by shutdown(): responses of older requests change nothing. */
  private epoch = 0;
  private closed = false;
  private keepaliveBytes = 0;
  private readonly random: () => number;

  constructor(private readonly options: SenderOptions) {
    this.random = options.random ?? Math.random;
  }

  get pending(): readonly ReplayChunk[] {
    return this.outbox;
  }

  /** Builds a chunk with its seq taken now, from its own session. */
  chunk(
    fields: Omit<ReplayChunk, "seq" | "inFlight" | "keepalive" | "claimed">,
  ): ReplayChunk {
    return { ...fields, seq: this.options.nextSeq(fields.sessionId) };
  }

  /** Queues chunks; `send: false` leaves them for flushKeepalive() (the page is hiding). */
  enqueue(chunks: ReplayChunk[], send = true): void {
    if (this.closed) return;
    this.outbox.push(...chunks);
    this.enforceBound();
    if (send) this.pump();
  }

  /**
   * Stops: nothing is sent or retried after this. Returns what was still
   * queued (a later init() on this page adopts it; opt-out drops it).
   */
  shutdown(): ReplayChunk[] {
    this.epoch += 1;
    this.closed = true;
    const left = this.outbox.map((c) => ({
      ...c,
      inFlight: false,
      keepalive: false,
      claimed: false,
    }));
    this.outbox = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return left;
  }

  /** Chunks a previous sender of this page left (re-init), sent first. */
  adopt(chunks: ReplayChunk[]): void {
    if (this.closed || chunks.length === 0) return;
    this.outbox.unshift(...chunks);
    this.enforceBound();
    this.pump();
  }

  /** Drops the session-mode chunks of a session (refused by the quota). */
  dropSessionChunks(sessionId: string): void {
    this.outbox = this.outbox.filter(
      (c) => c.inFlight || c.keepalive || c.mode !== "session" || c.sessionId !== sessionId,
    );
  }

  private url(query: boolean, gzip: boolean): string {
    const base = `${this.options.apiHost.replace(/\/+$/, "")}/replay`;
    if (!query) return base;
    const params: string[] = [];
    if (this.options.token !== undefined) {
      params.push(`token=${encodeURIComponent(this.options.token)}`);
    }
    if (gzip) params.push("compression=gzip");
    return params.length > 0 ? `${base}?${params.join("&")}` : base;
  }

  private enforceBound(): void {
    let total = this.outbox.reduce((sum, c) => sum + c.eventsJson.length, 0);
    while (total > MAX_OUTBOX_BYTES) {
      const victim = this.outbox.find((c) => !c.inFlight && !c.keepalive);
      if (!victim) break;
      // An error batch without its first chunk has no snapshot: all of it goes.
      const gone =
        victim.batch === undefined
          ? [victim]
          : this.outbox.filter((c) => c.batch === victim.batch && !c.inFlight && !c.keepalive);
      this.outbox = this.outbox.filter((c) => !gone.includes(c));
      for (const c of gone) total -= c.eventsJson.length;
      this.options.log("replay outbox over 5 MB, dropped the oldest chunk");
      this.options.onDropped?.(victim);
    }
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delay));
  }

  /** Sends the head of the outbox, one request at a time, honoring the backoff. */
  pump(): void {
    if (this.sending || this.closed) return;
    const wait = this.backoffUntil - Date.now();
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    const chunk = this.outbox.find((c) => !c.inFlight && !c.keepalive && !c.claimed);
    if (!chunk) return;
    this.sending = true;
    void this.send(chunk, false).finally(() => {
      this.sending = false;
      this.pump();
    });
  }

  private remove(chunk: ReplayChunk): void {
    const index = this.outbox.indexOf(chunk);
    if (index >= 0) this.outbox.splice(index, 1);
  }

  private async send(chunk: ReplayChunk, keepalive: boolean, encoded?: Encoded): Promise<void> {
    const epoch = this.epoch;
    if (keepalive) chunk.keepalive = true;
    else chunk.inFlight = true;
    let outcome: Outcome;
    let bytes = 0;
    try {
      const enc = encoded ?? (await encodeBody(chunkJson(chunk)));
      if (epoch !== this.epoch) return;
      const headers: Record<string, string> = keepalive
        ? // CORS-safelisted: a keepalive request cannot wait for a preflight.
          { "content-type": "text/plain;charset=UTF-8" }
        : {
            "content-type": "application/json",
            ...(this.options.token !== undefined ? { "x-cohorly-token": this.options.token } : {}),
            ...(enc.gzip ? { "content-encoding": "gzip" } : {}),
          };
      if (keepalive) {
        bytes = enc.bytes;
        this.keepaliveBytes += bytes;
      }
      const res = await fetch(this.url(keepalive, keepalive && enc.gzip), {
        method: "POST",
        headers,
        body: enc.body as BodyInit,
        keepalive,
      });
      outcome = await classify(res);
    } catch (err) {
      this.options.log("replay chunk send failed", err);
      outcome = { kind: "retry" };
    } finally {
      this.keepaliveBytes -= bytes;
      if (keepalive) chunk.keepalive = false;
      else chunk.inFlight = false;
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
    // The other path (regular or keepalive) already delivered it.
    if (!this.outbox.includes(chunk)) return;
    switch (outcome.kind) {
      case "drop":
        this.options.log("replay chunk refused (4xx), dropped");
        this.remove(chunk);
        return;
      case "gone":
        this.options.log("replay endpoint not found (404), session replay stopped for this page");
        this.shutdown();
        this.options.onGone?.();
        return;
      case "split": {
        const halves = this.split(chunk);
        const index = this.outbox.indexOf(chunk);
        if (!halves) {
          this.options.log("replay chunk with a single event is too large, dropped");
          this.outbox.splice(index, 1);
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
   * Two chunks with half the events each, or null when it holds a single
   * event. The first half keeps the seq; the second takes a new one from the
   * same session (the server tolerates gaps and out-of-order seqs, and the
   * player orders events by timestamp).
   */
  private split(chunk: ReplayChunk): [ReplayChunk, ReplayChunk] | null {
    if (chunk.count < 2) return null;
    const events = JSON.parse(chunk.eventsJson) as unknown[];
    const half = Math.ceil(events.length / 2);
    const first = events.slice(0, half);
    const second = events.slice(half);
    const base = { ...chunk, inFlight: false, keepalive: false, claimed: false };
    return [
      { ...base, eventsJson: JSON.stringify(first), count: first.length },
      {
        ...base,
        eventsJson: JSON.stringify(second),
        count: second.length,
        seq: this.options.nextSeq(chunk.sessionId),
      },
    ];
  }

  /**
   * The page is hiding or closing: queued chunks go out now with
   * `fetch(..., { keepalive: true })` (token and compression as query
   * parameters) while they fit the browser's keepalive budget. A chunk a
   * regular request carries is sent again (a closing page cancels that
   * request; the server stores a seq once). Chunks are claimed before the
   * first await, so the regular sender never sends them at the same time.
   * Only on `split` (pagehide) is a chunk too big split, and only while
   * enough budget is left; what does not fit stays queued whole for the
   * regular sender if the page comes back. Re-entry (visibilitychange then
   * pagehide) never sends a chunk twice: a call while a flush runs queues a
   * split pass (pagehide) after it, over what is left and with what is left
   * of the same budget; a plain call then is a no-op. Ignores the backoff
   * (last chance).
   */
  flushKeepalive(split: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flushRun) {
      if (split) this.splitQueued = true;
      return this.flushRun;
    }
    const run = this.runKeepalive(split).finally(() => {
      this.flushRun = null;
    });
    this.flushRun = run;
    return run;
  }

  private async runKeepalive(split: boolean): Promise<void> {
    const epoch = this.epoch;
    let pass = split;
    for (;;) {
      this.splitQueued = false;
      await this.keepalivePass(pass, epoch);
      if (!this.splitQueued || epoch !== this.epoch) break;
      pass = true;
    }
    this.splitQueued = false;
    if (epoch === this.epoch) this.pump();
  }

  private async keepalivePass(split: boolean, epoch: number): Promise<void> {
    if (epoch !== this.epoch) return;
    const claimed = this.outbox.filter((c) => !c.keepalive && !c.claimed);
    for (const c of claimed) c.claimed = true;
    try {
      for (let i = 0; i < claimed.length; i += 1) {
        if (epoch !== this.epoch) return;
        if (this.keepaliveBytes >= KEEPALIVE_BUDGET_BYTES) break;
        const chunk = claimed[i];
        if (!this.outbox.includes(chunk)) continue; // delivered meanwhile
        const encoded = await encodeBody(chunkJson(chunk));
        if (epoch !== this.epoch) return;
        if (!this.outbox.includes(chunk)) continue;
        if (this.keepaliveBytes + encoded.bytes <= KEEPALIVE_BUDGET_BYTES) {
          chunk.claimed = false;
          void this.send(chunk, true, encoded);
          continue;
        }
        if (!split) continue; // backgrounded only: never fragment the outbox
        if (KEEPALIVE_BUDGET_BYTES - this.keepaliveBytes < MIN_SPLIT_BUDGET_BYTES) break;
        if (chunk.inFlight) continue; // a regular request carries it whole
        const halves = this.split(chunk);
        if (!halves) continue;
        for (const half of halves) half.claimed = true;
        this.outbox.splice(this.outbox.indexOf(chunk), 1, ...halves);
        claimed.splice(i, 1, ...halves);
        i -= 1;
      }
    } finally {
      for (const c of claimed) c.claimed = false;
    }
  }
}
