/**
 * Limits on what canvas recording (`sessionReplay.canvas`, VEL-2155,
 * docs/SESSION-REPLAY.md "Canvas") puts in a chunk. replay.ts calls the filter
 * once per rrweb event, right before it is accepted. It runs whether or not
 * the option is on: a child iframe's canvas frames arrive through the relay
 * (VEL-2152) in a page that never asked for canvas itself.
 *
 * The frames kept in a session's recording share one budget across its page
 * loads (VEL-2176), counted in sessionStorage ({@link CANVAS_BUDGET_KEY}) and
 * in memory: without sessionStorage it is per page load, as it was before.
 */
import type { CohorlyStorage } from "@cohorly/core";
import { byteLength, MAX_CHUNK_BYTES } from "./sender.js";

/** A canvas frame (rrweb `CanvasMutation`) longer than this, as serialized JSON, is dropped. */
export const MAX_CANVAS_FRAME_CHARS = 400_000;
/**
 * Canvas frames kept per session, across its page loads. The server refuses a
 * session past 100 MB stored and WebP in base64 barely gzips, so without a
 * ceiling an animated canvas would use the session up and every later chunk,
 * DOM included, would be refused with 413.
 */
export const MAX_CANVAS_SESSION_CHARS = 64 * 1024 * 1024;
/**
 * sessionStorage: `{ id, chars, full }` of the one session whose frames are
 * counted. A new session overwrites it, so a rotated session's count never
 * lingers.
 */
export const CANVAS_BUDGET_KEY = "chl_replay_canvas";

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

/** What a session spent: serialized size of the frames kept, and whether a frame was refused for the ceiling. */
interface Spent {
  chars: number;
  full: boolean;
}

/**
 * The same count in memory (module level: it outlives session rotations and
 * recorder restarts), the only one when sessionStorage is missing or blocked.
 * Filters called without a session id count under "".
 */
const memory = new Map<string, Spent>();
const ceilingLogged = new Set<string>();

/** Tests only: forgets the page's memory (a new page load); sessionStorage is left as it is. */
export function resetCanvasBudget(): void {
  memory.clear();
  ceilingLogged.clear();
}

function readStored(storage: CohorlyStorage | undefined, sessionId: string): Spent | null {
  if (!storage) return null;
  try {
    const raw = storage.get(CANVAS_BUDGET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; chars?: unknown; full?: unknown } | null;
    if (parsed?.id !== sessionId || typeof parsed.chars !== "number" || !Number.isFinite(parsed.chars)) return null;
    return { chars: Math.max(0, parsed.chars), full: parsed.full === true };
  } catch {
    return null;
  }
}

/** The larger of the stored and the in-memory count: either may be missing (blocked storage, new page load). */
function spent(storage: CohorlyStorage | undefined, sessionId: string): Spent {
  const stored = readStored(storage, sessionId);
  const mem = memory.get(sessionId);
  return {
    chars: Math.max(stored?.chars ?? 0, mem?.chars ?? 0),
    full: stored?.full === true || mem?.full === true,
  };
}

function save(storage: CohorlyStorage | undefined, sessionId: string, value: Spent): void {
  memory.set(sessionId, value);
  if (!storage || sessionId === "") return;
  try {
    storage.set(CANVAS_BUDGET_KEY, JSON.stringify({ id: sessionId, chars: value.chars, full: value.full }));
  } catch {
    // storage full or blocked: the in-memory count still holds for this page load
  }
}

/** A frame of this session was already refused for the ceiling (on this page load or an earlier one). */
export function canvasBudgetFull(storage: CohorlyStorage | undefined, sessionId: string): boolean {
  return spent(storage, sessionId).full;
}

function isCanvasFrame(event: AnyEvent): boolean {
  return (
    event.type === INCREMENTAL &&
    (event.data as { source?: unknown } | undefined)?.source === CANVAS_MUTATION
  );
}

function isCanvasWithPixels(node: SnapshotNode): boolean {
  return (
    typeof node.tagName === "string" &&
    node.tagName.toLowerCase() === "canvas" &&
    !!node.attributes &&
    "rr_dataURL" in node.attributes
  );
}

/** Every canvas node with pixels under `node`, with the UTF-8 bytes its `"rr_dataURL":...,` takes. */
function collectPixels(node: SnapshotNode, found: { node: SnapshotNode; bytes: number }[]): void {
  if (isCanvasWithPixels(node)) {
    const value = JSON.stringify((node.attributes as Record<string, unknown>).rr_dataURL) ?? "";
    found.push({ node, bytes: byteLength(value) + '"rr_dataURL":,'.length });
  }
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) if (child && typeof child === "object") collectPixels(child, found);
  }
}

/**
 * The tree without `rr_dataURL` on the canvas nodes in `drop`. Only the nodes
 * on the way to a changed canvas are copied; the rest is shared with the
 * original, which is never written to.
 */
function withoutPixels(node: SnapshotNode, drop: Set<SnapshotNode>): SnapshotNode {
  let result = node;
  if (drop.has(node) && node.attributes) {
    const { rr_dataURL: _pixels, ...attributes } = node.attributes;
    result = { ...node, attributes };
  }
  if (Array.isArray(node.childNodes)) {
    let changed = false;
    const childNodes = node.childNodes.map((child) => {
      const stripped = child && typeof child === "object" ? withoutPixels(child, drop) : child;
      if (stripped !== child) changed = true;
      return stripped;
    });
    if (changed) result = { ...result, childNodes };
  }
  return result;
}

/**
 * The event, or a copy whose largest canvas pixels are gone, largest first,
 * only until it fits {@link MAX_CHUNK_BYTES} with `overhead` (the smaller
 * canvases keep theirs). `rebuild` makes the copy from the stripped roots.
 * Same object when it fits or holds no canvas pixels.
 */
function trimPixels<T>(
  event: T,
  roots: SnapshotNode[],
  overhead: number,
  rebuild: (roots: SnapshotNode[]) => T,
): T {
  const found: { node: SnapshotNode; bytes: number }[] = [];
  for (const root of roots) collectPixels(root, found);
  // Walk first: an event with no canvas pixels (most) never pays for serializing it to measure it.
  if (found.length === 0) return event;
  let size = byteLength(JSON.stringify(event)) + overhead;
  if (size <= MAX_CHUNK_BYTES) return event;
  found.sort((a, b) => b.bytes - a.bytes);
  const drop = new Set<SnapshotNode>();
  let result = event;
  for (const [i, canvas] of found.entries()) {
    drop.add(canvas.node);
    size -= canvas.bytes;
    // The estimate can only be off by a comma: measure the copy before stopping.
    if (size > MAX_CHUNK_BYTES && i < found.length - 1) continue;
    result = rebuild(roots.map((root) => withoutPixels(root, drop)));
    size = byteLength(JSON.stringify(result)) + overhead;
    if (size <= MAX_CHUNK_BYTES) return result;
  }
  return result;
}

/** What the caller knows about the event it hands over. */
export interface CanvasFilterContext {
  /**
   * Counts a kept frame against the session budget. Only a recording going to
   * the server needs it: the error buffer is a bounded ring whose frames
   * mostly never leave the page.
   */
  budget?: boolean;
  /** The session the frame is recorded in; absent counts in memory under "" (tests). */
  sessionId?: string;
  /**
   * Looks for canvas pixels in snapshots and mutations. Off for a page that
   * records no canvas of its own and gets nothing from a child iframe, so it
   * never walks a tree for nothing.
   */
  pixels?: boolean;
}

export interface CanvasFilterOptions {
  /** sessionStorage, where the session budget outlives the page load. */
  storage?: CohorlyStorage;
  /** A frame was refused because the session budget is spent (called for each one). */
  onCeiling?: (sessionId: string) => void;
}

/**
 * Per recorder: remembers the size of the last Meta, which a snapshot cannot
 * be split from (enqueue keeps the pair in one chunk, and one event over the
 * chunk limit would get the whole chunk refused with 413). Returns the event
 * to accept (the same object when nothing changes) or null to drop it.
 */
export function canvasFilter(
  log: (...args: unknown[]) => void,
  { storage, onCeiling }: CanvasFilterOptions = {},
): <T extends AnyEvent>(event: T, context?: CanvasFilterContext) => T | null {
  let metaBytes = 0;
  return <T extends AnyEvent>(
    event: T,
    { budget = true, sessionId = "", pixels = true }: CanvasFilterContext = {},
  ): T | null => {
    if (event.type === META) {
      metaBytes = byteLength(JSON.stringify(event));
      return event;
    }
    if (isCanvasFrame(event)) {
      const size = JSON.stringify(event).length;
      if (size > MAX_CANVAS_FRAME_CHARS) return null;
      if (!budget) return event;
      const used = spent(storage, sessionId);
      if (used.full || used.chars + size > MAX_CANVAS_SESSION_CHARS) {
        if (!used.full) save(storage, sessionId, { chars: used.chars, full: true });
        if (!ceilingLogged.has(sessionId)) {
          ceilingLogged.add(sessionId);
          log("session replay canvas frames over 64 MiB in this session, dropping the next ones");
        }
        onCeiling?.(sessionId);
        return null;
      }
      save(storage, sessionId, { chars: used.chars + size, full: false });
      return event;
    }
    if (!pixels) return event;
    // The overheads below are enqueue's accounting (replay.ts): 2 for the brackets and 1 per event for its comma.
    if (event.type === FULL_SNAPSHOT) {
      const node = (event.data as { node?: SnapshotNode } | undefined)?.node;
      if (!node || typeof node !== "object") return event;
      return trimPixels(event, [node], metaBytes + 4, ([stripped]) => ({
        ...event,
        data: { ...(event.data as object), node: stripped },
      }));
    }
    if (event.type === INCREMENTAL && (event.data as { source?: unknown } | undefined)?.source === DOM_MUTATION) {
      // A canvas added to the page after the snapshot (a chart mounted by a route change) carries its pixels too.
      const data = event.data as { adds?: { node?: SnapshotNode }[] };
      if (!Array.isArray(data.adds)) return event;
      const at: number[] = [];
      const roots: SnapshotNode[] = [];
      data.adds.forEach((add, i) => {
        if (add?.node && typeof add.node === "object") {
          at.push(i);
          roots.push(add.node);
        }
      });
      return trimPixels(event, roots, 3, (stripped) => {
        const adds = [...(data.adds as { node?: SnapshotNode }[])];
        at.forEach((i, k) => {
          if (stripped[k] !== roots[k]) adds[i] = { ...adds[i], node: stripped[k] };
        });
        return { ...event, data: { ...data, adds } };
      });
    }
    return event;
  };
}
