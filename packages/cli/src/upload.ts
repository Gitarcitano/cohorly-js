import { gzipSync } from "node:zlib";

export type SymbolKind = "sourcemap-index" | "r8-mapping" | "symcache";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_ATTEMPTS = 3;
export const BASE_DELAY_MS = 500;
// A server's Retry-After is honored up to this many seconds.
export const MAX_RETRY_AFTER_SEC = 60;
// 429 waits: at least this long each, at most this long in total per upload.
export const BUSY_WAIT_MS = 1000;
export const MAX_BUSY_WAIT_MS = 5 * 60 * 1000;

export interface UploadDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export interface UploadRequest {
  apiUrl: string;
  token: string;
  kind: SymbolKind;
  body: Uint8Array;
  query: Record<string, string | undefined>;
}

/** `status`: the HTTP status of the last answer, absent when no answer came (network error, too large to send). */
export type UploadResult = { ok: true; id: string; attempts: number } | { ok: false; error: string; attempts: number; status?: number };

export function symbolsUrl(apiUrl: string, kind: SymbolKind, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return `${apiUrl.replace(/\/+$/, "")}/api/symbols/${kind}${qs ? `?${qs}` : ""}`;
}

async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    const text = (await res.text()).trim();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      detail = typeof parsed.error === "string" ? parsed.error : text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  return `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
}

// Retry-After in whole seconds, capped; null when absent or not a number of
// seconds (an HTTP date is not worth parsing here).
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Math.min(Number(raw), MAX_RETRY_AFTER_SEC) * 1000;
}

export async function uploadArtifact(req: UploadRequest, deps: UploadDeps): Promise<UploadResult> {
  const body = gzipSync(req.body);
  if (body.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      attempts: 0,
      error: `artifact is ${body.length} bytes after gzip, above the ${MAX_UPLOAD_BYTES} byte upload limit`,
    };
  }
  const url = symbolsUrl(req.apiUrl, req.kind, req.query);
  let lastError = "";
  let wait: number | null = null;
  let busyWaitedMs = 0;
  let requests = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await deps.sleep(wait ?? BASE_DELAY_MS * 2 ** (attempt - 2));
    wait = null;
    requests++;
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${req.token}`,
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "gzip",
        },
        body,
      });
    } catch (err) {
      lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (res.ok) {
      let id = "";
      try {
        const parsed = (await res.json()) as { id?: unknown };
        if (typeof parsed.id === "string") id = parsed.id;
      } catch {
        id = "";
      }
      return { ok: true, id, attempts: requests };
    }
    lastError = await readError(res);
    if (res.status === 429) {
      // The org already has an upload being received (a parallel build): wait
      // it out on a budget of its own, without spending an attempt.
      const ms = Math.max(retryAfterMs(res) ?? BUSY_WAIT_MS, BUSY_WAIT_MS);
      if (busyWaitedMs + ms <= MAX_BUSY_WAIT_MS) {
        busyWaitedMs += ms;
        await deps.sleep(ms);
        attempt--;
        continue;
      }
      return { ok: false, error: `${lastError} (still busy after ${Math.round(busyWaitedMs / 1000)} s)`, attempts: requests, status: 429 };
    }
    if (res.status < 500) return { ok: false, error: lastError, attempts: requests, status: res.status };
    wait = retryAfterMs(res);
  }
  return { ok: false, error: `${lastError} (gave up after ${MAX_ATTEMPTS} attempts)`, attempts: requests };
}
