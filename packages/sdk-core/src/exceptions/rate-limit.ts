import type { ExceptionListEntry } from "../types.js";

/** At most this many exceptions with the same local fingerprint... */
export const MAX_EXCEPTIONS_PER_FINGERPRINT = 10;
/** ...within this rolling window (ms); the rest are dropped before queueing. */
export const EXCEPTION_DEDUP_WINDOW_MS = 60_000;
/** Distinct fingerprints remembered by the local rate limit; least recent goes first. */
export const MAX_DEDUP_FINGERPRINTS = 200;

/**
 * Local fingerprint: type + value + crashing frame (filename:function:lineno).
 * Only for client-side throttling; the server derives the real one.
 */
export function localFingerprint(list: ExceptionListEntry[]): string {
  const top = list[0];
  const frames = top.stacktrace?.frames ?? [];
  const crash = frames[frames.length - 1];
  const where = crash
    ? `${crash.filename ?? ""}:${crash.function ?? ""}:${crash.lineno ?? ""}`
    : "";
  return `${top.type}\n${top.value}\n${where}`;
}

/**
 * Local rate limit of a client SDK: at most
 * {@link MAX_EXCEPTIONS_PER_FINGERPRINT} exceptions per local fingerprint per
 * rolling {@link EXCEPTION_DEDUP_WINDOW_MS}. A render loop or a timer that
 * throws every frame must not fill the exception queue with one error. One
 * instance per client, cleared on init().
 */
export class ExceptionRateLimiter {
  private readonly recent = new Map<string, number[]>();

  allow(list: ExceptionListEntry[], now = Date.now()): boolean {
    if (list.length === 0) return false;
    const key = localFingerprint(list);
    const recent = (this.recent.get(key) ?? []).filter(
      (at) => now - at < EXCEPTION_DEDUP_WINDOW_MS,
    );
    // Delete and re-insert: Map order is the LRU order.
    this.recent.delete(key);
    if (recent.length >= MAX_EXCEPTIONS_PER_FINGERPRINT) {
      this.recent.set(key, recent);
      return false;
    }
    recent.push(now);
    this.recent.set(key, recent);
    if (this.recent.size > MAX_DEDUP_FINGERPRINTS) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
    return true;
  }

  reset(): void {
    this.recent.clear();
  }
}
