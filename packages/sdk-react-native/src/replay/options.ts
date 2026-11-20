/**
 * The `sessionReplay` option of `init()` (VEL-2153), normalized. Rates follow
 * the web SDK (`@cohorly/web` replay/session.ts): a number is clamped to
 * 0..1, anything else counts as 0, and replay is off unless one rate is above
 * 0 or the project's settings are read (`remoteConfig`, VEL-2238).
 */
import type { RemoteReplayConfig } from "./remote-config.js";

/** How the native recorder describes the screen. */
export type SessionReplayMode = "screenshot" | "wireframe";

export interface SessionReplayOptions {
  /**
   * Reads the project's replay settings (Settings > Session replay) from the
   * server (VEL-2238). Default false: the code decides and no request is made.
   * With true, each field the project saved (`sampleRate`,
   * `onErrorSampleRate`, the minimum duration) wins over the code's, a field
   * it never saved keeps the code's value, and with no network and no cached
   * copy the code's values apply. Kept for 1 hour per token; applies to new
   * sessions only. `mode` and `maskAllImages` always come from the code, and
   * triggers are web only. Replay starts even with both rates at 0 here
   * (needs a project token).
   */
  remoteConfig?: boolean;
  /** Share of sessions recorded whole, 0..1. Default 0. */
  sampleRate?: number;
  /**
   * Share of the remaining sessions that keep the last 30 to 60 seconds in
   * memory and send them when the SDK captures an exception, 0..1. Default 0.
   */
  onErrorSampleRate?: number;
  /**
   * `"screenshot"` (default): each screen is an image, masked before it is
   * encoded. `"wireframe"` (experimental): views described as wireframes.
   */
  mode?: SessionReplayMode;
  /** Masks every image in screenshot and wireframe mode. Default true. */
  maskAllImages?: boolean;
}

/** The options a recording runs with, every field decided. */
export interface ReplaySettings {
  sampleRate: number;
  onErrorSampleRate: number;
  mode: SessionReplayMode;
  maskAllImages: boolean;
  /** The project's settings are read (`remoteConfig: true` with a project token). */
  remoteConfig: boolean;
}

/** What new sessions are decided with: the code's rates with the project's saved fields on top. */
export interface EffectiveReplaySettings {
  sampleRate: number;
  onErrorSampleRate: number;
  /** Session mode sends nothing until the recording is this long; remote only (0 from the code). */
  minDurationMs: number;
}

/** What a session records: everything, the buffer sent on errors, or nothing. */
export type DecidedDraw = "session" | "error" | "none";
/** A session's draw as stored: `pending` until the project's settings decide it (VEL-2238). */
export type ReplayDraw = DecidedDraw | "pending";

export function rate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Null when replay is off: no option, not an object, or both rates 0 once
 * normalized, unless `remoteConfig: true` and a project token (the web rule:
 * the project's settings can turn recording on).
 */
export function replaySettings(options: SessionReplayOptions | undefined, token?: string): ReplaySettings | null {
  if (typeof options !== "object" || options === null) return null;
  const sampleRate = rate(options.sampleRate);
  const onErrorSampleRate = rate(options.onErrorSampleRate);
  const remoteConfig = options.remoteConfig === true && !!token;
  if (!remoteConfig && sampleRate === 0 && onErrorSampleRate === 0) return null;
  return {
    sampleRate,
    onErrorSampleRate,
    mode: options.mode === "wireframe" ? "wireframe" : "screenshot",
    maskAllImages: options.maskAllImages !== false,
    remoteConfig,
  };
}

/** The code's values with each field the project saved on top, per field. */
export function effectiveSettings(
  code: Pick<ReplaySettings, "sampleRate" | "onErrorSampleRate">,
  remote: RemoteReplayConfig | null,
): EffectiveReplaySettings {
  return {
    sampleRate: remote?.sampleRate ?? code.sampleRate,
    onErrorSampleRate: remote?.onErrorSampleRate ?? code.onErrorSampleRate,
    minDurationMs: remote?.minDurationMs ?? 0,
  };
}

/** The sampling draw of a new session, the web SDK's `decideMode` (its `off` is `none` here). */
export function drawSession(
  settings: Pick<ReplaySettings, "sampleRate" | "onErrorSampleRate">,
  random: () => number,
): DecidedDraw {
  if (settings.sampleRate > 0 && random() < settings.sampleRate) return "session";
  if (settings.onErrorSampleRate > 0 && random() < settings.onErrorSampleRate) return "error";
  return "none";
}
