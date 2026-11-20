/**
 * The project's replay settings, read with `sessionReplay.remoteConfig: true`
 * (VEL-2238, docs/SESSION-REPLAY.md "Remote settings"), adapted from the web
 * SDK's `replay/remote-config.ts` (the packages never import each other).
 *
 * `GET {apiHost}/replay/config?token=` answers only the fields the project
 * saved. The answer is kept in the SDK storage (AsyncStorage) per token for
 * an hour; a fresh copy is used with no request. Reading and writing the copy
 * are async and never throw. A copy stamped in the future is no copy, and an
 * answer never replaces a copy fetched after its request began. The request
 * is aborted at 30 s; an answer arriving 30 s or more after it began is
 * ignored and never cached. The 3 s wait of a session's decision lives in the
 * controller (replay.ts), not here.
 */
import type { AsyncStorageLike } from "../types.js";

/** Storage key prefix; the project token follows. */
export const REPLAY_CONFIG_KEY_PREFIX = "cohorly:replay_config:";
/** A stored copy younger than this is used with no request. */
export const REPLAY_CONFIG_TTL_MS = 60 * 60 * 1000;
/** How long a session's decision waits for the request (the request itself keeps going). */
export const REPLAY_CONFIG_TIMEOUT_MS = 3000;
/** The request is aborted after this, so a late answer can still refresh the copy. */
export const REPLAY_CONFIG_ABORT_MS = 30_000;
/** The longest minimum duration the dashboard offers. */
export const MAX_MIN_DURATION_MS = 30_000;

/** The fields the project saved; an absent field keeps the code's value. */
export interface RemoteReplayConfig {
  sampleRate?: number;
  onErrorSampleRate?: number;
  minDurationMs?: number;
}

export interface StoredReplayConfig {
  fetchedAt: number;
  config: RemoteReplayConfig;
}

export function replayConfigKey(token: string): string {
  return `${REPLAY_CONFIG_KEY_PREFIX}${token}`;
}

const isRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * The only fields read from the server or the stored copy. `triggers` (web
 * only) and anything else are dropped. A field with an invalid value counts
 * as not saved. Null when the value is not an object.
 */
export function parseReplayConfig(value: unknown): RemoteReplayConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { sampleRate, onErrorSampleRate, minDurationMs } = value as Record<string, unknown>;
  const config: RemoteReplayConfig = {};
  if (isRate(sampleRate)) config.sampleRate = sampleRate;
  if (isRate(onErrorSampleRate)) config.onErrorSampleRate = onErrorSampleRate;
  if (typeof minDurationMs === "number" && Number.isFinite(minDurationMs) && minDurationMs >= 0) {
    config.minDurationMs = Math.min(minDurationMs, MAX_MIN_DURATION_MS);
  }
  return config;
}

function parseStored(raw: string | null, now: number): StoredReplayConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; config?: unknown } | null;
    const config = parseReplayConfig(parsed?.config);
    const fetchedAt = parsed?.fetchedAt;
    if (!config || typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt > now) return null;
    return { fetchedAt, config };
  } catch {
    return null;
  }
}

/** The token's stored copy, fresh or expired; null without one (or one fetched in the future, or unreadable storage). */
export async function readReplayConfig(
  storage: AsyncStorageLike,
  token: string,
  now: () => number,
): Promise<StoredReplayConfig | null> {
  try {
    return parseStored(await storage.getItem(replayConfigKey(token)), now());
  } catch {
    return null;
  }
}

/** A copy younger than {@link REPLAY_CONFIG_TTL_MS}. */
export function isFresh(stored: StoredReplayConfig | null, now: number): boolean {
  return stored !== null && now - stored.fetchedAt < REPLAY_CONFIG_TTL_MS;
}

export interface FetchReplayConfigOptions {
  apiHost: string;
  token: string;
  storage: AsyncStorageLike;
  fetch: typeof fetch | undefined;
  now: () => number;
  /** Called with a valid answer before it is written to storage, so a slow write never delays it. */
  onAnswer?: (answer: StoredReplayConfig) => void;
  /** Checked before the write: false keeps the answer out of storage (the controller was stopped). */
  persist?: () => boolean;
}

/** Copy writes per token, one at a time: each compares with what the previous one left. */
const writes = new Map<string, Promise<void>>();

function serialized(key: string, task: () => Promise<void>): Promise<void> {
  const next = (writes.get(key) ?? Promise.resolve()).then(task, task);
  writes.set(key, next);
  void next.then(() => {
    if (writes.get(key) === next) writes.delete(key);
  });
  return next;
}

async function request(
  options: FetchReplayConfigOptions,
  startedAt: number,
  signal: AbortSignal | undefined,
): Promise<StoredReplayConfig | null> {
  try {
    const fetchImpl = options.fetch;
    if (typeof fetchImpl !== "function") return null;
    const url = `${options.apiHost.replace(/\/+$/, "")}/replay/config?token=${encodeURIComponent(options.token)}`;
    const res = await fetchImpl(url, { method: "GET", credentials: "omit", ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const config = parseReplayConfig(((await res.json()) as { config?: unknown } | null)?.config);
    // Late past the abort (no AbortController, or a body read after it): ignored, never cached.
    if (!config || options.now() - startedAt >= REPLAY_CONFIG_ABORT_MS) return null;
    return { fetchedAt: options.now(), config };
  } catch {
    return null;
  }
}

/** Writes `answer` unless the stored copy was fetched after `startedAt`. Never throws. */
function storeAnswer(options: FetchReplayConfigOptions, startedAt: number, answer: StoredReplayConfig): Promise<void> {
  const { storage, now } = options;
  const key = replayConfigKey(options.token);
  return serialized(key, async () => {
    let latest: StoredReplayConfig | null = null;
    try {
      latest = parseStored(await storage.getItem(key), now());
    } catch {
      latest = null;
    }
    if (latest && latest.fetchedAt > startedAt) return;
    try {
      await storage.setItem(key, JSON.stringify(answer));
    } catch {
      // storage full or broken: the answer still decides this process
    }
  });
}

/**
 * One request for the project's settings. Resolves with the answer (also
 * written to storage unless a newer copy is there), or null on any failure
 * (network, non-2xx, invalid JSON, abort, an answer 30 s late). It resolves
 * by 30 s even when the host's fetch ignores the abort. A failure writes
 * nothing. Never rejects.
 */
export async function fetchReplayConfig(options: FetchReplayConfigOptions): Promise<StoredReplayConfig | null> {
  const startedAt = options.now();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let abort: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    abort = setTimeout(() => {
      controller?.abort();
      resolve(null);
    }, REPLAY_CONFIG_ABORT_MS);
    (abort as { unref?: () => void }).unref?.();
  });
  try {
    const answer = await Promise.race([request(options, startedAt, controller?.signal), expired]);
    if (!answer) return null;
    options.onAnswer?.(answer);
    if (options.persist?.() !== false) await storeAnswer(options, startedAt, answer);
    return answer;
  } finally {
    clearTimeout(abort);
  }
}
