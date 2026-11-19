/**
 * Limits on what canvas recording (`sessionReplay.canvas`, VEL-2155,
 * docs/SESSION-REPLAY.md "Canvas") puts in a chunk. replay.ts calls the filter
 * once per rrweb event, right before it is accepted. It runs whether or not
 * the option is on: a child iframe's canvas frames arrive through the relay
 * (VEL-2152) in a page that never asked for canvas itself.
 */
import { byteLength, MAX_CHUNK_BYTES } from "./sender.js";

/** A canvas frame (rrweb `CanvasMutation`) longer than this, as serialized JSON, is dropped. */
export const MAX_CANVAS_FRAME_CHARS = 400_000;
/**
 * Canvas frames kept per page load. The server refuses a session past 100 MB
 * stored and WebP in base64 barely gzips, so without a ceiling an animated
 * canvas would use the session up and every later chunk, DOM included, would
 * be refused with 413.
 */
export const MAX_CANVAS_PAGE_CHARS = 64 * 1024 * 1024;

const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
/** rrweb's `IncrementalSource.Mutation` (DOM) and `CanvasMutation`. */
const DOM_MUTATION = 0;
const CANVAS_MUTATION = 9;

interface AnyEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

interface SnapshotNode {
  tagName?: unknown;
  attributes?: Record<string, unknown>;
  childNodes?: SnapshotNode[];
}

/** Serialized size of the frames kept on this page load (module level: it outlives session rotations and recorder restarts). */
let pageChars = 0;
let ceilingLogged = false;

/** Tests only. */
export function resetCanvasBudget(): void {
  pageChars = 0;
  ceilingLogged = false;
}

function isCanvasFrame(event: AnyEvent): boolean {
  return (
    event.type === INCREMENTAL &&
    (event.data as { source?: unknown } | undefined)?.source === CANVAS_MUTATION
  );
}

/**
 * The tree without `rr_dataURL` on its canvas nodes. Only the nodes on the way
 * to a changed canvas are copied; the rest is shared with the original, which
 * is never written to.
 */
function withoutCanvasPixels(node: SnapshotNode): SnapshotNode {
  let result = node;
  if (
    typeof node.tagName === "string" &&
    node.tagName.toLowerCase() === "canvas" &&
    node.attributes &&
    "rr_dataURL" in node.attributes
  ) {
    const { rr_dataURL: _pixels, ...attributes } = node.attributes;
    result = { ...node, attributes };
  }
  if (Array.isArray(node.childNodes)) {
    let changed = false;
    const childNodes = node.childNodes.map((child) => {
      const stripped = child && typeof child === "object" ? withoutCanvasPixels(child) : child;
      if (stripped !== child) changed = true;
      return stripped;
    });
    if (changed) result = { ...result, childNodes };
  }
  return result;
}

/** What the caller knows about the event it hands over. */
export interface CanvasFilterContext {
  /**
   * Counts a kept frame against the page budget. Only a recording going to the
   * server needs it: the error buffer is a bounded ring whose frames mostly
   * never leave the page.
   */
  budget?: boolean;
  /**
   * Looks for canvas pixels in snapshots and mutations. Off for a page that
   * records no canvas of its own and gets nothing from a child iframe, so it
   * never walks a tree for nothing.
   */
  pixels?: boolean;
}

/**
 * Per recorder: remembers the size of the last Meta, which a snapshot cannot
 * be split from (enqueue keeps the pair in one chunk, and one event over the
 * chunk limit would get the whole chunk refused with 413). Returns the event
 * to accept (the same object when nothing changes) or null to drop it.
 */
export function canvasFilter(
  log: (...args: unknown[]) => void,
): <T extends AnyEvent>(event: T, context?: CanvasFilterContext) => T | null {
  let metaBytes = 0;
  return <T extends AnyEvent>(event: T, { budget = true, pixels = true }: CanvasFilterContext = {}): T | null => {
    if (event.type === META) {
      metaBytes = byteLength(JSON.stringify(event));
      return event;
    }
    if (isCanvasFrame(event)) {
      const size = JSON.stringify(event).length;
      if (size > MAX_CANVAS_FRAME_CHARS) return null;
      if (!budget) return event;
      if (pageChars + size > MAX_CANVAS_PAGE_CHARS) {
        if (!ceilingLogged) {
          ceilingLogged = true;
          log("session replay canvas frames over 64 MiB on this page load, dropping the next ones");
        }
        return null;
      }
      pageChars += size;
      return event;
    }
    if (!pixels) return event;
    // Walk first: an event with no canvas pixels (most) never pays for serializing it to measure it. The sizes
    // below are enqueue's accounting (replay.ts): 2 for the brackets and 1 per event for its comma.
    if (event.type === FULL_SNAPSHOT) {
      const node = (event.data as { node?: SnapshotNode } | undefined)?.node;
      if (!node || typeof node !== "object") return event;
      const stripped = withoutCanvasPixels(node);
      if (stripped === node) return event;
      if (byteLength(JSON.stringify(event)) + metaBytes + 4 <= MAX_CHUNK_BYTES) return event;
      return { ...event, data: { ...(event.data as object), node: stripped } };
    }
    if (event.type === INCREMENTAL && (event.data as { source?: unknown } | undefined)?.source === DOM_MUTATION) {
      // A canvas added to the page after the snapshot (a chart mounted by a route change) carries its pixels too.
      const data = event.data as { adds?: { node?: SnapshotNode }[] };
      if (!Array.isArray(data.adds)) return event;
      let changed = false;
      const adds = data.adds.map((add) => {
        const node = add?.node;
        if (!node || typeof node !== "object") return add;
        const stripped = withoutCanvasPixels(node);
        if (stripped === node) return add;
        changed = true;
        return { ...add, node: stripped };
      });
      if (!changed) return event;
      if (byteLength(JSON.stringify(event)) + 3 <= MAX_CHUNK_BYTES) return event;
      return { ...event, data: { ...data, adds } };
    }
    return event;
  };
}
