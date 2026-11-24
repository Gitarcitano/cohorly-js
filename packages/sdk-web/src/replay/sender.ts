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
import { gzipSync, strToU8 } from "fflate";
import { VERSION } from "../version.js";

/** A chunk is split before sending past this serialized size (the server's wire limit is 1 MB). */
export const MAX_CHUNK_BYTES = 1_000_000 - 1024;
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
  /** Holds a FullSnapshot (rrweb type 2): the session's later chunks are unplayable without it. */
  hasSnapshot?: boolean;
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

export function byteLength(text: string): number {
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

/**
 * Gzip on the calling task, for the keepalive path: a closing page (Firefox)
 * never resumes an await, so nothing may come between the handler and the
 * fetch. Plain JSON when fflate throws.
 */
export function encodeBodySync(json: string): Encoded {
  try {
    const body = gzipSync(strToU8(json));
    return { body, gzip: true, bytes: body.byteLength };
  } catch {
    return { body: json, gzip: false, bytes: byteLength(json) };
  }
}

const META = 4;
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
/** rrweb's `IncrementalSource.CanvasMutation`. */
const CANVAS_MUTATION = 9;

function eventType(event: unknown): unknown {
  return typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined;
}

/** A canvas frame (rrweb `CanvasMutation`, VEL-2155). */
function isCanvasFrame(event: unknown): boolean {
  return (
    eventType(event) === INCREMENTAL &&
    ((event as { data?: { source?: unknown } }).data?.source ?? null) === CANVAS_MUTATION
  );
}

/** A Meta and the FullSnapshot right after it are one unit: never cut between them. */
function isSnapshotPair(before: unknown, after: unknown): boolean {
  return eventType(before) === META && eventType(after) === FULL_SNAPSHOT;
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
  /** Bumped by shutdown(): responses of older requests change nothing. */
  private epoch = 0;
  private closed = false;
  private keepaliveBytes = 0;
  /** Lone canvas frames whose keepalive body is over the budget, each counted once. */
  private readonly tooBigForKeepalive = new WeakSet<ReplayChunk>();
  private canvasKeepaliveMisses = 0;
  private readonly random: () => number;

  constructor(private readonly options: SenderOptions) {
    this.random = options.random ?? Math.random;
  }

  get pending(): readonly ReplayChunk[] {
    return this.outbox;
  }

  /**
   * Chunks holding a lone canvas frame whose gzip body is over
   * {@link KEEPALIVE_BUDGET_BYTES}: no keepalive request can carry them, so
   * they are lost if the page closes before the regular sender gets to them
   * (VEL-2176). Debug log and tests only; nothing is sent about it.
   */
  get canvasFramesTooBigForKeepalive(): number {
    return this.canvasKeepaliveMisses;
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
      const enc =
        encoded ?? (keepalive ? encodeBodySync(chunkJson(chunk)) : await encodeBody(chunkJson(chunk)));
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
          this.options.log("replay chunk that cannot be split is too large, dropped");
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
   * Two chunks with about half the events each, or null when it holds a
   * single event or only a Meta and its FullSnapshot (never cut apart: the
   * Meta alone is unplayable). The first half keeps the seq; the second
   * takes a new one from the same session (the server tolerates gaps and
   * out-of-order seqs, and the player orders events by timestamp).
   */
  private split(chunk: ReplayChunk): [ReplayChunk, ReplayChunk] | null {
    if (chunk.count < 2) return null;
    const events = JSON.parse(chunk.eventsJson) as unknown[];
    const middle = Math.ceil(events.length / 2);
    let cut = -1;
    for (let offset = 0; offset < events.length && cut < 0; offset += 1) {
      for (const at of [middle - offset, middle + offset]) {
        if (at >= 1 && at < events.length && !isSnapshotPair(events[at - 1], events[at])) {
          cut = at;
          break;
        }
      }
    }
    if (cut < 0) return null;
    return this.pieces(chunk, [events.slice(0, cut), events.slice(cut)]) as [ReplayChunk, ReplayChunk];
  }

  /** Chunks of these runs of the chunk's events: the first keeps its seq, the others take new ones. */
  private pieces(chunk: ReplayChunk, parts: unknown[][]): ReplayChunk[] {
    const holds = (part: unknown[]) => part.some((e) => eventType(e) === FULL_SNAPSHOT);
    const base = { ...chunk, inFlight: false, keepalive: false, claimed: false };
    return parts.map((part, i) => ({
      ...base,
      eventsJson: JSON.stringify(part),
      count: part.length,
      hasSnapshot: holds(part),
      ...(i > 0 ? { seq: this.options.nextSeq(chunk.sessionId) } : {}),
    }));
  }

  /**
   * Keepalive only: the chunk cut around its first canvas frame (what comes
   * before, the frame alone, what comes after), so a frame that fits the
   * budget alone goes in its own request (VEL-2176). Only the first: a later
   * frame is cut out on a later turn of the pass, and only while budget is
   * left, so a closing page never fragments a chunk it cannot send. A Meta
   * and its FullSnapshot are never cut apart (a frame is never between
   * them). Null without a frame or when the chunk is one already.
   */
  private isolateFrames(chunk: ReplayChunk): ReplayChunk[] | null {
    if (chunk.count < 2) return null;
    const events = JSON.parse(chunk.eventsJson) as unknown[];
    const at = events.findIndex(isCanvasFrame);
    if (at < 0) return null;
    const parts = [events.slice(0, at), [events[at]], events.slice(at + 1)].filter((part) => part.length > 0);
    return parts.length < 2 ? null : this.pieces(chunk, parts);
  }

  /** A chunk of one canvas frame whose keepalive body is over the whole budget: counted once, logged. */
  private countTooBig(chunk: ReplayChunk, encoded: Encoded): boolean {
    if (encoded.bytes <= KEEPALIVE_BUDGET_BYTES || chunk.count !== 1) return false;
    if (!isCanvasFrame((JSON.parse(chunk.eventsJson) as unknown[])[0])) return false;
    if (!this.tooBigForKeepalive.has(chunk)) {
      this.tooBigForKeepalive.add(chunk);
      this.canvasKeepaliveMisses += 1;
      this.options.log(
        `replay canvas frame of ${encoded.bytes} bytes${encoded.gzip ? " gzipped" : ""} cannot fit a keepalive request, left queued (${this.canvasKeepaliveMisses} on this page)`,
      );
    }
    return true;
  }

  /**
   * The page is hiding or closing: queued chunks go out now with
   * `fetch(..., { keepalive: true })` (token and compression as query
   * parameters) while they fit the browser's keepalive budget. A chunk a
   * regular request carries is sent again (a closing page cancels that
   * request; the server stores a seq once). The whole flush is synchronous:
   * each body is gzipped with fflate and each fetch starts inside this call
   * (Firefox never resumes an await in a closing page). A chunk over
   * {@link MAX_CHUNK_BYTES} (UTF-8) is not even compressed (it cannot fit).
   * Only on `split` (pagehide) is a chunk too big split, and only while
   * enough budget is left; what does not fit stays queued whole for the
   * regular sender if the page comes back. A chunk holding a canvas frame is
   * first cut so that the frame goes alone (VEL-2176); a lone frame whose
   * gzip is over the whole budget can never go and is counted
   * ({@link canvasFramesTooBigForKeepalive}).
   *
   * The start of a session never goes without its snapshot: the chunks of a
   * session up to and including the first one holding a FullSnapshot still
   * queued (its head) go together, all of them only if their sum fits what
   * is left of the budget, else none (on `split`, the snapshot chunk may
   * first be split to drop what follows the snapshot). When a chunk holding
   * a FullSnapshot stays queued, so do the later chunks of its session in
   * that pass (they are unplayable without it).
   *
   * Each call (visibilitychange, then pagehide) runs its own pass right away
   * over what is neither in a keepalive request nor reserved, against the
   * same budget, so no chunk is sent twice. The regular sender resumes on a
   * later microtask, after the handlers of the current task. Ignores the
   * backoff (last chance).
   */
  flushKeepalive(split: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    const epoch = this.epoch;
    this.keepalivePass(split, epoch);
    return Promise.resolve().then(() => {
      if (epoch === this.epoch) this.pump();
    });
  }

  private keepalivePass(split: boolean, epoch: number): void {
    if (epoch !== this.epoch) return;
    const claimed = this.outbox.filter((c) => !c.keepalive && !c.claimed);
    for (const c of claimed) c.claimed = true;
    /** Sessions whose FullSnapshot stays queued in this pass. */
    const held = new Set<string>();
    const leave = (chunk: ReplayChunk) => {
      if (chunk.hasSnapshot) held.add(chunk.sessionId);
    };
    /** Sessions whose head was already dealt with in this pass. */
    const headSeen = new Set<string>();
    const encodings = new Map<ReplayChunk, Encoded | null>();
    /** The keepalive body, or null when the chunk cannot fit at all. */
    const encode = (chunk: ReplayChunk): Encoded | null => {
      let encoded = encodings.get(chunk);
      if (encoded === undefined) {
        const json = chunkJson(chunk);
        encoded = byteLength(json) > MAX_CHUNK_BYTES ? null : encodeBodySync(json);
        encodings.set(chunk, encoded);
      }
      return encoded;
    };
    const left = () => KEEPALIVE_BUDGET_BYTES - this.keepaliveBytes;
    const replace = (chunk: ReplayChunk, parts: ReplayChunk[]) => {
      for (const part of parts) part.claimed = true;
      this.outbox.splice(this.outbox.indexOf(chunk), 1, ...parts);
      claimed.splice(claimed.indexOf(chunk), 1, ...parts);
    };
    /**
     * Sends the head of the session of `claimed[from]` whole, or holds the
     * session. False when the session has no FullSnapshot queued (no head).
     */
    const sendHead = (from: number): boolean => {
      const sessionId = claimed[from].sessionId;
      for (;;) {
        const rest = claimed
          .slice(from)
          .filter((c) => c.sessionId === sessionId && this.outbox.includes(c));
        const end = rest.findIndex((c) => c.hasSnapshot);
        if (end < 0) return false;
        const head = rest.slice(0, end + 1);
        const prefix = head.slice(0, -1).map(encode);
        if (prefix.some((e) => e === null)) break;
        const prefixBytes = prefix.reduce((sum, e) => sum + (e?.bytes ?? 0), 0);
        if (prefixBytes > left()) break; // trimming the snapshot chunk cannot help
        const last = head[head.length - 1];
        const encoded = encode(last);
        if (encoded && prefixBytes + encoded.bytes <= left()) {
          const bodies = [...prefix, encoded];
          head.forEach((c, k) => {
            c.claimed = false;
            void this.send(c, true, bodies[k] as Encoded);
          });
          return true;
        }
        // Drop what follows the snapshot (pagehide only, like any split).
        if (!split || last.inFlight || left() < MIN_SPLIT_BUDGET_BYTES) break;
        const halves = this.split(last);
        if (!halves) break;
        replace(last, halves);
      }
      held.add(sessionId);
      return true;
    };
    try {
      for (let i = 0; i < claimed.length; i += 1) {
        if (epoch !== this.epoch) return;
        if (this.keepaliveBytes >= KEEPALIVE_BUDGET_BYTES) break;
        const chunk = claimed[i];
        if (!this.outbox.includes(chunk)) continue; // delivered meanwhile
        if (chunk.keepalive) continue; // went with its session's head
        if (held.has(chunk.sessionId)) continue;
        if (!headSeen.has(chunk.sessionId)) {
          headSeen.add(chunk.sessionId);
          if (sendHead(i)) continue;
        }
        const encoded = encode(chunk);
        if (!encoded || this.countTooBig(chunk, encoded)) {
          leave(chunk);
          continue;
        }
        if (this.keepaliveBytes + encoded.bytes <= KEEPALIVE_BUDGET_BYTES) {
          chunk.claimed = false;
          void this.send(chunk, true, encoded);
          continue;
        }
        // backgrounded only: never fragment the outbox; a regular request
        // carries it whole; too little budget left to be worth a split.
        if (!split || chunk.inFlight || left() < MIN_SPLIT_BUDGET_BYTES) {
          leave(chunk);
          continue;
        }
        // A canvas frame goes alone first (it fits on its own or never does), then halves.
        const parts = this.isolateFrames(chunk) ?? this.split(chunk);
        if (!parts) {
          leave(chunk);
          continue;
        }
        replace(chunk, parts);
        i -= 1;
      }
    } finally {
      for (const c of claimed) c.claimed = false;
    }
  }
}
