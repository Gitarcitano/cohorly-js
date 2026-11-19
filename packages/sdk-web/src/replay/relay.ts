/**
 * Cross-origin iframes in session replay (VEL-2152, docs/SESSION-REPLAY.md
 * "Cross-origin iframes"). This module ships in the main bundle and holds
 * only what must run eagerly: the option's normalization, the Cohorly message
 * shape and the child frame's small `message` listener. The child loads
 * rrweb (the same lazy chunk as its own recording) only when its parent asks
 * for a snapshot.
 *
 * rrweb 2.2.0 relays a cross-origin child's events to `window.parent` with
 * `postMessage(..., "*")` and has no list of origins. The Cohorly layer:
 * - the child starts relaying only after a `snapshot` request from
 *   `window.parent`, from a listed origin, while the parent is cross-origin;
 * - at every init() the child posts `ready` to `window.parent`, once per
 *   listed origin, so a parent already recording asks it again (late init,
 *   re-init during a relay);
 * - the parent (iframes.ts) drops rrweb messages from unlisted origins, from
 *   windows that are not one of its <iframe>s, or from an <iframe> it blocks,
 *   before rrweb sees them.
 */
import type { RecordModule } from "./replay.js";
import type { SessionReplayOptions } from "./session.js";

/** `source` of every Cohorly replay message: `snapshot`/`stop` parent to child, `ready` child to parent. */
export const RELAY_MESSAGE_SOURCE = "cohorly-replay";
export const RELAY_MESSAGE_VERSION = 1;

export type RelayOp = "snapshot" | "stop" | "ready";

export interface RelayMessage {
  source: typeof RELAY_MESSAGE_SOURCE;
  v: typeof RELAY_MESSAGE_VERSION;
  op: RelayOp;
}

export function relayMessage(op: RelayOp): RelayMessage {
  return { source: RELAY_MESSAGE_SOURCE, v: RELAY_MESSAGE_VERSION, op };
}

export function isRelayMessage(data: unknown): data is RelayMessage {
  const d = data as Partial<RelayMessage> | null;
  return (
    typeof d === "object" &&
    d !== null &&
    d.source === RELAY_MESSAGE_SOURCE &&
    d.v === RELAY_MESSAGE_VERSION &&
    (d.op === "snapshot" || d.op === "stop" || d.op === "ready")
  );
}

/**
 * The exact http(s) origins of `allowedIframeOrigins`: an item is kept only
 * when `new URL(item).origin === item` ("https://pay.example.com", never
 * "*", a path, a trailing slash or another scheme). Each ignored item is
 * logged.
 */
export function normalizeIframeOrigins(
  value: unknown,
  log: (...args: unknown[]) => void,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    log("allowedIframeOrigins is not an array, ignored:", value);
    return [];
  }
  const origins: string[] = [];
  for (const item of value) {
    let origin: string | null = null;
    if (typeof item === "string") {
      try {
        const url = new URL(item);
        if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === item) origin = item;
      } catch {
        // not a URL
      }
    }
    if (origin === null) {
      log("allowedIframeOrigins: ignored, not an http(s) origin:", item);
    } else if (!origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
}

/** What the child needs from replay.ts (loaded with import(), never eagerly). */
export interface RelayReplayModule {
  recordOptions(options: SessionReplayOptions): Record<string, unknown>;
  loadRecorder(): Promise<RecordModule>;
}

export interface IframeRelayDeps {
  /** The child's own `sessionReplay` options (its mask and block selectors apply). */
  options: SessionReplayOptions;
  /** Normalized `allowedIframeOrigins`. */
  origins: string[];
  /** Loads replay.ts. */
  load: () => Promise<RelayReplayModule>;
  /** Stops the child's own recording while the parent records this frame. */
  suspend: () => void;
  /** The parent stopped: the child's own recording starts again (if it had one). */
  resume: () => void;
  log: (...args: unknown[]) => void;
  /** `window.parent` (tests). */
  parent?: Window;
  /** Whether the parent is on another origin (tests). */
  parentIsCrossOrigin?: () => boolean;
}

function parentIsCrossOrigin(): boolean {
  try {
    // Reading a cross-origin parent's document throws.
    void window.parent.document;
    return false;
  } catch {
    return true;
  }
}

export interface IframeRelay {
  /** Removes the listener and stops relaying, without resuming the child's own recording (re-init, opt-out). */
  dispose(): void;
}

/**
 * Child side: when this frame is a cross-origin iframe and the list is not
 * empty, listens for the parent's `snapshot`/`stop` and posts `ready` to the
 * parent once per listed origin. Independent of the sampling rates: whether
 * to record is the parent's decision. Returns null (no listener) otherwise.
 */
export function startIframeRelay(deps: IframeRelayDeps): IframeRelay | null {
  if (typeof window === "undefined" || deps.origins.length === 0) return null;
  const parent = deps.parent ?? window.parent;
  if (!parent || parent === window) return null;
  // A same-origin parent records this frame through its contentDocument.
  if (!(deps.parentIsCrossOrigin ?? parentIsCrossOrigin)()) return null;

  let state: "idle" | "starting" | "relaying" = "idle";
  let generation = 0;
  let stopRecord: (() => void) | null = null;
  let takeSnapshot: ((isCheckout?: boolean) => void) | undefined;

  const end = (resume: boolean) => {
    if (state === "idle") return;
    generation += 1;
    state = "idle";
    try {
      stopRecord?.();
    } catch {
      // rrweb teardown errors must not reach the app
    }
    stopRecord = null;
    takeSnapshot = undefined;
    if (resume) deps.resume();
  };

  const begin = () => {
    state = "starting";
    const mine = ++generation;
    deps.suspend();
    deps
      .load()
      .then(async (mod) => {
        const { record } = await mod.loadRecorder();
        if (mine !== generation) return;
        // In a cross-origin child rrweb forwards every event to window.parent itself.
        stopRecord = record({ ...mod.recordOptions(deps.options), recordCrossOriginIframes: true }) ?? null;
        takeSnapshot = record.takeFullSnapshot;
        state = "relaying";
      })
      .catch((err: unknown) => {
        deps.log("iframe relay could not load rrweb", err);
        if (mine === generation) end(true);
      });
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== parent || !deps.origins.includes(event.origin) || !isRelayMessage(event.data)) return;
    if (event.data.op === "ready") return; // child to parent only
    if (event.data.op === "stop") {
      end(true);
    } else if (state === "idle") {
      begin(); // record() takes the first full snapshot
    } else if (state === "relaying") {
      try {
        takeSnapshot?.(true);
      } catch {
        // rrweb errors must not reach the app
      }
    }
  };
  window.addEventListener("message", onMessage);
  // A parent that asked before this listener existed (late init, re-init) asks again.
  const ready = relayMessage("ready");
  for (const origin of deps.origins) {
    try {
      parent.postMessage(ready, origin);
    } catch {
      // a parent gone meanwhile
    }
  }

  return {
    dispose() {
      window.removeEventListener("message", onMessage);
      end(false);
    },
  };
}
