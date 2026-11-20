/**
 * The project's replay settings, read with `sessionReplay.remoteConfig: true`
 * (VEL-2185, docs/SESSION-REPLAY.md "Remote settings"). Main bundle: never
 * imports replay.ts or rrweb.
 *
 * `GET {apiHost}/replay/config?token=` answers only the fields the project
 * saved. The answer is kept in localStorage per token for an hour; a fresh
 * copy is used with no request. Without one, a single simple request (no
 * custom header, no credentials, so no CORS preflight) is made, and the
 * decision waits for it at most 3 s. A failure falls back to the expired
 * copy, else to nothing (the code's values). A copy stamped in the future is
 * no copy, and an answer never replaces a copy fetched after its request
 * began (another tab's).
 */
import type { CohorlyStorage } from "@cohorly/core";
import type { ReplayTrigger } from "./triggers.js";
import { parseTriggers } from "./triggers.js";

/** localStorage key prefix; the project token follows. */
export const REPLAY_CONFIG_KEY_PREFIX = "chl_replay_config:";
/** A stored copy younger than this is used with no request. */
export const REPLAY_CONFIG_TTL_MS = 60 * 60 * 1000;
/** How long the decision waits for the request (the request itself keeps going). */
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
  /** The project's triggers (VEL-2187), at least one; absent = none saved (or none readable). */
  triggers?: ReplayTrigger[];
}

export interface LoadReplayConfigOptions {
  apiHost: string;
  token: string;
  /** localStorage. */
  storage: CohorlyStorage;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
}

export interface ReplayConfigLoad {
  /** The stored copy, fresh or expired, or null. */
  cached: RemoteReplayConfig | null;
  /** When the stored copy was fetched, or null without one. */
  fetchedAt: number | null;
  /** The stored copy is younger than REPLAY_CONFIG_TTL_MS: `ready` already has it, no request. */
  fresh: boolean;
  /** The settings to decide with: the answer, else the stored copy, else null. Never rejects. */
  ready: Promise<RemoteReplayConfig | null>;
}

const isRate = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * The only fields read from the server or the stored copy. Anything else
 * (`maskTextSelector`, `blockSelector`, `allowedIframeOrigins`, ...) is
 * dropped: privacy settings come from the code only. A field with an invalid
 * value counts as not saved, and an unreadable trigger is skipped (triggers.ts
 * `parseTriggers`). Null when the value is not an object.
 */
export function parseReplayConfig(value: unknown): RemoteReplayConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { sampleRate, onErrorSampleRate, minDurationMs, triggers } = value as Record<string, unknown>;
  const config: RemoteReplayConfig = {};
  if (isRate(sampleRate)) config.sampleRate = sampleRate;
  if (isRate(onErrorSampleRate)) config.onErrorSampleRate = onErrorSampleRate;
  if (typeof minDurationMs === "number" && Number.isFinite(minDurationMs) && minDurationMs >= 0) {
    config.minDurationMs = Math.min(minDurationMs, MAX_MIN_DURATION_MS);
  }
  // No readable trigger and none saved act the same: kept only when there is one.
  const parsed = parseTriggers(triggers);
  if (parsed.length > 0) config.triggers = parsed;
  return config;
}

export interface StoredReplayConfig {
  fetchedAt: number;
  config: RemoteReplayConfig;
}

function readStored(storage: CohorlyStorage, key: string, now: number): StoredReplayConfig | null {
  try {
    const raw = storage.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; config?: unknown } | null;
    const config = parseReplayConfig(parsed?.config);
    const fetchedAt = parsed?.fetchedAt;
    if (!config || typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt > now) {
      return null;
    }
    return { fetchedAt, config };
  } catch {
    return null;
  }
}

/** False when the storage refuses the write. */
function writeStored(storage: CohorlyStorage, key: string, stored: StoredReplayConfig): boolean {
  try {
    storage.set(key, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/** The token's stored copy, fresh or expired; null without one (or one fetched in the future). */
export function readReplayConfig(
  storage: CohorlyStorage,
  token: string,
  now: number,
): StoredReplayConfig | null {
  return readStored(storage, `${REPLAY_CONFIG_KEY_PREFIX}${token}`, now);
}

export function loadReplayConfig(options: LoadReplayConfigOptions): ReplayConfigLoad {
  const { storage, now } = options;
  const key = `${REPLAY_CONFIG_KEY_PREFIX}${options.token}`;
  const stored = readStored(storage, key, now());
  const cached = stored?.config ?? null;
  const fetchedAt = stored?.fetchedAt ?? null;
  if (stored && now() - stored.fetchedAt < REPLAY_CONFIG_TTL_MS) {
    return { cached, fetchedAt, fresh: true, ready: Promise.resolve(cached) };
  }

  const ready = new Promise<RemoteReplayConfig | null>((resolve) => {
    let settled = false;
    const finish = (config: RemoteReplayConfig | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(waiting);
      resolve(config);
    };
    const waiting = setTimeout(() => finish(cached), options.timeoutMs ?? REPLAY_CONFIG_TIMEOUT_MS);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const abort = controller ? setTimeout(() => controller.abort(), REPLAY_CONFIG_ABORT_MS) : null;
    const url = `${options.apiHost.replace(/\/+$/, "")}/replay/config?token=${encodeURIComponent(options.token)}`;
    const request = async (): Promise<RemoteReplayConfig | null> => {
      const startedAt = now();
      const res = await options.fetch(url, {
        credentials: "omit",
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) return null;
      const config = parseReplayConfig(((await res.json()) as { config?: unknown } | null)?.config);
      if (!config) return null;
      const latest = readStored(storage, key, now());
      if (!latest || latest.fetchedAt <= startedAt) writeStored(storage, key, { fetchedAt: now(), config });
      return config;
    };
    request()
      .catch(() => null)
      .then((config) => {
        if (abort) clearTimeout(abort);
        finish(config ?? cached);
      });
  });
  return { cached, fetchedAt, fresh: false, ready };
}
