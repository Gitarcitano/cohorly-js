import { promisify } from "node:util";
import { gzip } from "node:zlib";

// Sends one import batch with the retry policy of `cohorly import`. Knows
// nothing about events or Mixpanel: it posts a JSON body to a URL and says
// what came back, so the profile and lexicon imports reuse it unchanged.

const gzipAsync = promisify(gzip);

export interface SenderDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

/** 429 and 503 waits in a row before a batch gives up. */
export const MAX_BUSY_WAITS = 100;
/** Attempts of one batch on 5xx (other than 503) and network errors. */
export const MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
/** Retry-After used when the header is absent or not a whole number of seconds. */
export const DEFAULT_RETRY_AFTER_SECONDS: Readonly<Record<429 | 503, number>> = { 429: 1, 503: 5 };

export interface SendRequest {
  url: string;
  token: string;
  /** Uncompressed JSON body. Sent gzipped unless `gzip` is false; the same bytes on every retry. */
  body?: Uint8Array;
  /** Default POST. */
  method?: "GET" | "POST" | "PUT";
  /** Default true. A route that does not read gzip bodies (the Lexicon API) needs false. */
  gzip?: boolean;
  /** Default true: a 2xx answer must be a JSON object with `"status": 1` (the import routes). False accepts any JSON body. */
  expectStatusOne?: boolean;
}

export type SendFailure = "auth" | "bad_request" | "client_error" | "server_error" | "network" | "busy" | "bad_response";

export type SendResult =
  | { kind: "ok"; status: number; body: unknown }
  /** 413: the caller splits the batch. */
  | { kind: "too_large" }
  | { kind: "failed"; reason: SendFailure; status: number | null; message: string };

export interface RetryNotice {
  status: number | null;
  message: string;
  delayMs: number;
  attempt: number;
}

export interface SendHooks {
  /** Called before each backoff wait after a 5xx or a network error (not on 429/503 waits). */
  onRetry?: (notice: RetryNotice) => void;
}

/** Longest single wait a Retry-After can ask for: one day, well inside a Node timer (2^31 - 1 ms). */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/** Seconds of a Retry-After header holding a whole number >= 0 (capped at a day), else `fallback`. */
export function retryAfterSeconds(header: string | null, fallback: number): number {
  const value = header?.trim() ?? "";
  return /^\d+$/.test(value) ? Math.min(Number(value), MAX_RETRY_AFTER_SECONDS) : fallback;
}

/** Wait before attempt `failures + 1`: 1 s, 2 s, 4 s ... capped at 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

async function readMessage(res: Response): Promise<string> {
  let text = "";
  try {
    text = (await res.text()).trim();
  } catch {
    return "";
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") return parsed.error.slice(0, 300);
  } catch {
    // not JSON: the text itself
  }
  return text.slice(0, 300);
}

function describe(status: number, message: string): string {
  return `HTTP ${status}${message ? `: ${message}` : ""}`;
}

export async function postWithRetry(req: SendRequest, deps: SenderDeps, hooks: SendHooks = {}): Promise<SendResult> {
  const method = req.method ?? "POST";
  const compress = req.gzip !== false;
  const body = req.body === undefined ? undefined : compress ? await gzipAsync(req.body) : Buffer.from(req.body);
  const headers: Record<string, string> = { Authorization: `Bearer ${req.token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (body !== undefined && compress) headers["Content-Encoding"] = "gzip";
  let busyWaits = 0;
  let failures = 0;

  const retryOrGiveUp = async (status: number | null, message: string, reason: SendFailure): Promise<SendResult | null> => {
    failures++;
    if (failures >= MAX_ATTEMPTS) {
      return { kind: "failed", reason, status, message: `${message} (gave up after ${MAX_ATTEMPTS} attempts)` };
    }
    const delayMs = backoffMs(failures);
    hooks.onRetry?.({ status, message, delayMs, attempt: failures });
    await deps.sleep(delayMs);
    return null;
  };

  for (;;) {
    let res: Response;
    try {
      res = await deps.fetch(req.url, { method, headers, body });
    } catch (err) {
      busyWaits = 0;
      const outcome = await retryOrGiveUp(null, `network error: ${err instanceof Error ? err.message : String(err)}`, "network");
      if (outcome) return outcome;
      continue;
    }

    const status = res.status;
    if (status === 429 || status === 503) {
      const message = await readMessage(res);
      if (busyWaits >= MAX_BUSY_WAITS) {
        return {
          kind: "failed",
          reason: "busy",
          status,
          message: `${describe(status, message)} (still busy after ${MAX_BUSY_WAITS} waits in a row)`,
        };
      }
      busyWaits++;
      await deps.sleep(retryAfterSeconds(res.headers.get("retry-after"), DEFAULT_RETRY_AFTER_SECONDS[status]) * 1000);
      continue;
    }
    busyWaits = 0;

    if (status === 413) {
      await res.body?.cancel().catch(() => {});
      return { kind: "too_large" };
    }
    if (status >= 500) {
      const outcome = await retryOrGiveUp(status, describe(status, await readMessage(res)), "server_error");
      if (outcome) return outcome;
      continue;
    }
    if (status >= 200 && status < 300) {
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        // The connection dropped while the answer was being read: the batch may
        // or may not have been stored, and sending it again is safe (deduplicated).
        const outcome = await retryOrGiveUp(null, `network error: ${err instanceof Error ? err.message : String(err)}`, "network");
        if (outcome) return outcome;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const statusOk = req.expectStatusOne === false ? parsed !== undefined : (parsed as { status?: unknown } | undefined)?.status === 1;
      if (!parsed || typeof parsed !== "object" || !statusOk) {
        return {
          kind: "failed",
          reason: "bad_response",
          status,
          message:
            req.expectStatusOne === false
              ? `the server answered HTTP ${status} with a body that is not JSON:${text.slice(0, 300)}`
              : `the server answered HTTP ${status} without "status": 1: ${text.slice(0, 300)}`,
        };
      }
      return { kind: "ok", status, body: parsed };
    }

    const message = describe(status, await readMessage(res));
    if (status === 401 || status === 403) return { kind: "failed", reason: "auth", status, message };
    if (status === 400) return { kind: "failed", reason: "bad_request", status, message };
    return { kind: "failed", reason: "client_error", status, message };
  }
}
