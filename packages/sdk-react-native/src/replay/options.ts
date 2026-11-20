/**
 * The `sessionReplay` option of `init()` (VEL-2153), normalized. Rates follow
 * the web SDK (`@cohorly/web` replay/session.ts): a number is clamped to
 * 0..1, anything else counts as 0, and replay is off unless one rate is above
 * 0.
 */

/** How the native recorder describes the screen. */
export type SessionReplayMode = "screenshot" | "wireframe";

export interface SessionReplayOptions {
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
}

/** What a session records: everything, the buffer sent on errors, or nothing. */
export type ReplayDraw = "session" | "error" | "none";

export function rate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Null when replay is off: no option, not an object, or both rates 0 once normalized. */
export function replaySettings(options: SessionReplayOptions | undefined): ReplaySettings | null {
  if (typeof options !== "object" || options === null) return null;
  const sampleRate = rate(options.sampleRate);
  const onErrorSampleRate = rate(options.onErrorSampleRate);
  if (sampleRate === 0 && onErrorSampleRate === 0) return null;
  return {
    sampleRate,
    onErrorSampleRate,
    mode: options.mode === "wireframe" ? "wireframe" : "screenshot",
    maskAllImages: options.maskAllImages !== false,
  };
}

/** The sampling draw of a new session, the web SDK's `decideMode` (its `off` is `none` here). */
export function drawSession(settings: ReplaySettings, random: () => number): ReplayDraw {
  if (settings.sampleRate > 0 && random() < settings.sampleRate) return "session";
  if (settings.onErrorSampleRate > 0 && random() < settings.onErrorSampleRate) return "error";
  return "none";
}
