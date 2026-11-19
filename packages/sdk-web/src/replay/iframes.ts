/**
 * Parent side of cross-origin iframe recording (VEL-2152, relay.ts has the
 * child side and the message shape). Loaded with replay.ts.
 *
 * - `attach()` (before rrweb's record()) installs a capturing `message`
 *   listener that stops every rrweb message (`data.type === "rrweb"`) from an
 *   unlisted origin, from a window that is not the contentWindow of an
 *   <iframe> of this document, or from a blocked <iframe>, before rrweb's own
 *   listener sees it. Other rrweb-shaped messages are never touched. It also
 *   answers a child's `ready` and listens for iframe loads.
 * - `started()` (after record()) puts the listener that ends a child's
 *   dispatch behind rrweb's, and asks the iframes for a snapshot.
 * - `snapshot()` asks every <iframe> that is not blocked for a full snapshot,
 *   posted once per listed origin (never "*", so the browser delivers it only
 *   to a frame on that origin).
 * - `guard()` closes the nested-iframe gap: rrweb also listens for `message`
 *   on the window of every same-origin <iframe> it attached, with no origin
 *   check, so a cross-origin frame nested in one could inject rrweb events.
 *   It walks the <iframe>s of the top document and, recursively, of every
 *   open shadow root and readable (same-origin) iframe document, and installs
 *   a capturing listener on each window that stops every `data.type ===
 *   "rrweb"` message, whatever its origin (none of ours is legitimate there:
 *   children relay to the top window). Other messages are never touched.
 *   rrweb's own listener there is capturing too, so the filter must be
 *   registered first: replay.ts calls `guard()` from the emit of every full
 *   snapshot and every iframe attach mutation, which rrweb emits
 *   synchronously before it registers its listener on that window (reloaded
 *   iframes included).
 * - `release()` removes the listeners (top and guarded windows) and tells the
 *   iframes the recording stopped (only when one was asked for a snapshot
 *   since the last release).
 *
 * The listeners stay while the recorder is stopped by an idle expiry: the
 * iframes keep relaying, and an interaction inside one wakes the session
 * (`onChildEvent`).
 */
import { isRelayMessage, type RelayOp, relayMessage } from "./relay.js";

/** rrweb's default `blockClass`: an element under it is never recorded. */
const RRWEB_BLOCK_CLASS = ".rr-block";

/** In a window that is not the top one every rrweb-shaped message is foreign, from any origin. */
const nestedFilter = (event: MessageEvent) => {
  const data = event.data as { type?: unknown } | null;
  if (typeof data === "object" && data !== null && data.type === "rrweb") event.stopImmediatePropagation();
};

/**
 * The windows of the same-origin <iframe>s under `root`, nested ones and those
 * inside open shadow roots included (rrweb attaches both). A cross-origin one
 * is unreadable: skipped, like rrweb skips it.
 */
function sameOriginWindows(root: Document | ShadowRoot, out: Set<Window>): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.shadowRoot) sameOriginWindows(el.shadowRoot, out);
    if (el.tagName !== "IFRAME") continue;
    try {
      const frame = el as HTMLIFrameElement;
      const inner = frame.contentDocument;
      const win = frame.contentWindow;
      if (!inner || !win || out.has(win)) continue;
      out.add(win);
      sameOriginWindows(inner, out);
    } catch {
      // cross-origin: its window is not rrweb's to listen on either
    }
  }
}

export interface IframeBridgeOptions {
  /** Normalized `allowedIframeOrigins`. */
  origins: readonly string[] | undefined;
  /** The parent's effective rrweb `blockSelector`: an <iframe> it blocks is never asked or heard. */
  blockSelector: string;
  /** Every rrweb event a child relayed and the filter let through (before rrweb sees it). */
  onChildEvent?: (event: unknown) => void;
}

export interface IframeBridge {
  /** Installs the listeners (before record(); no-op when attached). */
  attach(): void;
  /** After record(): keeps the end-of-dispatch listener behind rrweb's, then asks for snapshots. */
  started(): void;
  snapshot(): void;
  /** Stops rrweb messages in the windows of same-origin iframes (nested at any depth); idempotent, no-op when not attached. */
  guard(): void;
  /** Removes the listeners and tells the iframes to go back to their own recording. */
  release(): void;
  /** The current event was relayed by a child (true only inside the dispatch of its message). */
  fromChild(): boolean;
}

function documentIframes(): HTMLIFrameElement[] {
  return Array.from(document.getElementsByTagName("iframe"));
}

/** Null (nothing installed, rrweb gets no iframe flag) without origins, or outside the top frame. */
export function iframeBridge(options: IframeBridgeOptions): IframeBridge | null {
  const { origins, blockSelector } = options;
  if (!origins || origins.length === 0) return null;
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  // In a child frame rrweb's flag would forward events to the parent instead of emitting them.
  if (window.parent !== window) return null;

  let attached = false;
  /** Frames asked for a snapshot since the last release: they may be relaying, blocked since or not. */
  const asked = new Set<HTMLIFrameElement>();
  /** Windows of same-origin iframes carrying `nestedFilter`. */
  const guarded = new Set<Window>();
  let childDispatch = false;
  let childDispatchTimer: ReturnType<typeof setTimeout> | null = null;

  /** rrweb records an <iframe> it blocks as a placeholder, but still listens to it: never ask or hear one. */
  const blocked = (frame: HTMLIFrameElement): boolean => {
    try {
      return frame.closest(RRWEB_BLOCK_CLASS) !== null || frame.closest(blockSelector) !== null;
    } catch {
      return true; // an invalid selector: fail closed
    }
  };

  const recordedIframes = () => documentIframes().filter((frame) => !blocked(frame));

  /** The <iframe> of this document whose window sent the message, or null. */
  const frameOf = (source: MessageEventSource | null): HTMLIFrameElement | null => {
    if (source === null) return null;
    return documentIframes().find((frame) => frame.contentWindow === source) ?? null;
  };

  const post = (op: RelayOp, frames: HTMLIFrameElement[], targets: readonly string[] = origins) => {
    const message = relayMessage(op);
    for (const frame of frames) {
      if (op === "snapshot") asked.add(frame);
      const target = frame.contentWindow;
      if (!target) continue;
      for (const origin of targets) {
        try {
          target.postMessage(message, origin);
        } catch {
          // a detached frame: nothing to ask
        }
      }
    }
  };

  const endChildDispatch = () => {
    childDispatch = false;
    if (childDispatchTimer !== null) clearTimeout(childDispatchTimer);
    childDispatchTimer = null;
  };

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; event?: unknown } | null;
    if (typeof data !== "object" || data === null) return;
    if (isRelayMessage(data)) {
      // A child that called init() after our requests (or again): it gets a snapshot request of its own.
      if (data.op !== "ready" || !origins.includes(event.origin)) return;
      const frame = frameOf(event.source);
      if (frame && !blocked(frame)) post("snapshot", [frame], [event.origin]);
      return;
    }
    if (data.type !== "rrweb") return;
    const frame = frameOf(event.source);
    if (!frame || blocked(frame) || !origins.includes(event.origin)) {
      event.stopImmediatePropagation();
      return;
    }
    // rrweb emits synchronously in its own listener, which runs after this one
    // and before `onDispatchEnd`. A microtask would not do: the browser runs
    // microtasks between two listeners of a postMessage dispatch.
    childDispatch = true;
    if (childDispatchTimer === null) childDispatchTimer = setTimeout(endChildDispatch, 0);
    options.onChildEvent?.(data.event);
  };

  const unguard = (win: Window) => {
    try {
      win.removeEventListener("message", nestedFilter, true);
    } catch {
      // a window that is gone
    }
  };

  const onDispatchEnd = () => {
    if (childDispatch) endChildDispatch();
  };

  const onLoad = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.tagName === "IFRAME" && !blocked(target as HTMLIFrameElement)) {
      post("snapshot", [target as HTMLIFrameElement]);
    }
  };

  return {
    attach() {
      if (attached) return;
      attached = true;
      window.addEventListener("message", onMessage, true);
      // load does not bubble and never reaches the window (DOM spec): captured at the document, it covers every iframe.
      document.addEventListener("load", onLoad, true);
    },
    started() {
      if (!attached) return;
      // Registered again after record() added rrweb's listener: it runs last.
      window.removeEventListener("message", onDispatchEnd);
      window.addEventListener("message", onDispatchEnd);
      post("snapshot", recordedIframes());
    },
    snapshot() {
      if (attached) post("snapshot", recordedIframes());
    },
    guard() {
      if (!attached) return;
      // A window keeps its filter until release (re-adding it would put it behind rrweb's listener); a closed one is dropped.
      for (const win of guarded) {
        if (win.closed) guarded.delete(win);
      }
      const current = new Set<Window>();
      sameOriginWindows(document, current);
      for (const win of current) {
        try {
          win.addEventListener("message", nestedFilter, true);
          guarded.add(win);
        } catch {
          // gone between the walk and now
        }
      }
    },
    release() {
      for (const win of guarded) unguard(win);
      guarded.clear();
      if (attached) {
        attached = false;
        window.removeEventListener("message", onMessage, true);
        window.removeEventListener("message", onDispatchEnd);
        document.removeEventListener("load", onLoad, true);
        endChildDispatch();
      }
      if (asked.size === 0) return;
      // Every frame that may be relaying, even one blocked or detached since: it goes back to its own recording.
      const frames = [...asked];
      asked.clear();
      post("stop", frames);
    },
    fromChild() {
      return childDispatch;
    },
  };
}
