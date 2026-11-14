import type {
  CohorlyFetcher,
  CohorlyGetFetcher,
  CohorlyTransport,
} from "./types.js";

/**
 * Error thrown by transports on a non-OK HTTP response. Carries the HTTP
 * `status` and, when the server sent a `Retry-After` header, the parsed
 * `retryAfterMs` so the client can honor the server's backoff hint.
 *
 * Network failures (DNS, connection reset, offline) are NOT TransportErrors -
 * they surface as whatever the underlying transport throws (e.g. a TypeError
 * from fetch), and the client treats them like a retriable 5xx.
 */
export class TransportError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, retryAfterMs?: number, message?: string) {
    super(message ?? `cohorly: request failed with status ${status}`);
    this.name = "TransportError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parses a `Retry-After` header into milliseconds. Supports both the
 * delta-seconds form (an integer, per the server contract) and the HTTP-date
 * form. Returns undefined when the header is absent or unparseable.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/**
 * Default transport: POST JSON via the global fetch (Node 18+). Throws a
 * {@link TransportError} on a non-2xx response (carrying status + parsed
 * Retry-After); network failures and an aborted `signal` reject with the
 * underlying fetch error.
 */
export const fetchTransport: CohorlyTransport = async (url, body, headers, signal) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new TransportError(
      res.status,
      parseRetryAfterMs(res.headers.get("retry-after")),
      `cohorly: request to ${url} failed with status ${res.status}`,
    );
  }
};

/**
 * Default GET fetcher (flag definitions): GET the URL with `headers` (the flag
 * secret rides in Authorization) and resolve the parsed body. Throws a
 * {@link TransportError} on a non-2xx response.
 */
export const fetchDefinitionsFetcher: CohorlyGetFetcher = async (url, headers) => {
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    throw new TransportError(
      res.status,
      parseRetryAfterMs(res.headers.get("retry-after")),
      `cohorly: request to ${url} failed with status ${res.status}`,
    );
  }
  return await res.json();
};

/**
 * Default JSON fetcher (flags): POST JSON via the global fetch and resolve the
 * parsed response body. Throws a {@link TransportError} on a non-2xx response;
 * network failures reject with the underlying fetch error.
 */
export const fetchJsonFetcher: CohorlyFetcher = async (url, body, headers) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new TransportError(
      res.status,
      parseRetryAfterMs(res.headers.get("retry-after")),
      `cohorly: request to ${url} failed with status ${res.status}`,
    );
  }
  return await res.json();
};
