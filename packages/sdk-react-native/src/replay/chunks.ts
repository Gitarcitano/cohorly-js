/**
 * Turning drained events into `POST /replay` bodies (docs/SESSION-REPLAY.md
 * section 2 and "Mobile"). JSON only: Hermes has no CompressionStream, so
 * the body is sent uncompressed and must fit the server's 1 MB wire limit.
 * Events stay serialized: a native batch that fits is spliced into a chunk
 * as it came (never re-serialized), and the chunk header is spliced in front
 * of the events like the web SDK's `chunkJson`.
 */
import { LIB_VERSION } from "../version.js";

/** Body bytes (UTF-8, header included) a chunk stays under; the server refuses more than 1 MB. */
export const MAX_CHUNK_BYTES = 900 * 1024;
/** Events per chunk (the server accepts up to 5000). */
export const MAX_CHUNK_EVENTS = 1000;
export const LIB = "react-native";

export const FULL_SNAPSHOT = 2;
export const INCREMENTAL = 3;
export const META = 4;
export const CUSTOM = 5;

export type ChunkMode = "session" | "error";

export interface ReplayChunk {
  sessionId: string;
  distinctId: string;
  mode: ChunkMode;
  /** The events, serialized as a JSON array. */
  eventsJson: string;
  seq: number;
  /** Chunks of one error send share it: dropping one drops the batch. */
  batch?: number;
  /** A request carries it now. */
  inFlight?: boolean;
}

/** UTF-8 byte length without TextEncoder (not on every Hermes). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

export function chunkHeader(chunk: Pick<ReplayChunk, "sessionId" | "distinctId" | "seq" | "mode">): string {
  return JSON.stringify({
    session_id: chunk.sessionId,
    distinct_id: chunk.distinctId,
    seq: chunk.seq,
    mode: chunk.mode,
    lib: LIB,
    lib_version: LIB_VERSION,
  });
}

/** The request body: the header with the events array spliced in, never reparsed. */
export function chunkJson(chunk: ReplayChunk): string {
  const head = chunkHeader(chunk);
  return `${head.slice(0, -1)},"events":${chunk.eventsJson}}`;
}

/** Bytes of the body around the events (the largest seq the server accepts, so it never undercounts). */
export function headerBytes(sessionId: string, distinctId: string, mode: ChunkMode): number {
  return utf8Length(chunkJson({ sessionId, distinctId, mode, seq: 1_000_000, eventsJson: "" }));
}

export function eventType(event: unknown): unknown {
  return typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined;
}

/** Something the packer places whole: a native batch, one event, or a Meta with its FullSnapshot. */
export interface Unit {
  /** Serialized events joined by commas, without the brackets. */
  json: string;
  count: number;
  /** UTF-8 bytes of `json` plus its separating comma. */
  bytes: number;
  hasSnapshot: boolean;
  /** The rrweb type of each event, in order. */
  types: unknown[];
}

/**
 * Units of single serialized events, where a Meta and the FullSnapshot right
 * after it are one unit (the Meta alone is unplayable).
 */
export function eventUnits(serialized: readonly string[], types: readonly unknown[]): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < serialized.length; ) {
    const size = types[i] === META && types[i + 1] === FULL_SNAPSHOT ? 2 : 1;
    const part = serialized.slice(i, i + size);
    const json = part.join(",");
    units.push({
      json,
      count: part.length,
      bytes: utf8Length(json) + 1,
      hasSnapshot: types.slice(i, i + size).includes(FULL_SNAPSHOT),
      types: types.slice(i, i + size),
    });
    i += size;
  }
  return units;
}

/**
 * A drained native batch as units: the batch whole when it fits, else its
 * events one by one. Null when it is not a JSON array.
 */
export function batchUnits(batch: string, budget: number): { units: Unit[]; events: unknown[] } | null {
  let events: unknown;
  try {
    events = JSON.parse(batch);
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  if (events.length === 0) return { units: [], events };
  const types = events.map(eventType);
  const trimmed = batch.trim();
  const inner = trimmed.slice(1, -1);
  const bytes = utf8Length(inner) + 1;
  // The same test packUnits() applies (a unit plus the array brackets).
  if (bytes + 2 <= budget && events.length <= MAX_CHUNK_EVENTS) {
    return {
      units: [{ json: inner, count: events.length, bytes, hasSnapshot: types.includes(FULL_SNAPSHOT), types }],
      events,
    };
  }
  return { units: eventUnits(events.map((e) => JSON.stringify(e)), types), events };
}

/**
 * Groups units into event arrays of at most `budget` bytes and
 * {@link MAX_CHUNK_EVENTS} events, in order. A unit larger than the budget
 * on its own can never be sent: it is returned in `dropped`.
 */
export function packUnits(units: readonly Unit[], budget: number): { parts: string[]; dropped: Unit[] } {
  const parts: string[] = [];
  const dropped: Unit[] = [];
  let current: string[] = [];
  let bytes = 2;
  let count = 0;
  const close = () => {
    if (current.length === 0) return;
    parts.push(`[${current.join(",")}]`);
    current = [];
    bytes = 2;
    count = 0;
  };
  for (const unit of units) {
    if (unit.bytes + 2 > budget) {
      dropped.push(unit);
      continue;
    }
    if (current.length > 0 && (bytes + unit.bytes > budget || count + unit.count > MAX_CHUNK_EVENTS)) close();
    current.push(unit.json);
    bytes += unit.bytes;
    count += unit.count;
  }
  close();
  return { parts, dropped };
}

/**
 * The units that may go, in order, before packing. A snapshot unit too large
 * for `budget` is dropped and, from there, every IncrementalSnapshot is
 * dropped too until a snapshot unit that fits (a mutation against a screen
 * the player never saw is unplayable); an IncrementalSnapshot unit too large
 * for `budget` breaks the chain the same way. `suppress` carries that state from
 * one call to the next for the same recording; the result says whether a
 * snapshot was dropped (the caller asks for a new one).
 */
export function admitUnits(
  units: readonly Unit[],
  budget: number,
  suppress: boolean,
): { kept: Unit[]; droppedSnapshot: boolean; suppress: boolean } {
  const kept: Unit[] = [];
  let droppedSnapshot = false;
  let suppressing = suppress;
  for (const unit of units) {
    if (unit.hasSnapshot) {
      if (unit.bytes + 2 <= budget) {
        suppressing = false;
        kept.push(unit);
      } else {
        suppressing = true;
        droppedSnapshot = true;
      }
      continue;
    }
    if (!suppressing && unit.bytes + 2 > budget && unit.types.includes(INCREMENTAL)) {
      // A mutation too large to send breaks the chain like a lost snapshot:
      // nothing that may depend on it goes until the next full snapshot.
      suppressing = true;
      droppedSnapshot = true;
      continue;
    }
    if (!suppressing) {
      kept.push(unit);
      continue;
    }
    if (unit.types.every((t) => t === INCREMENTAL)) continue;
    // A batch mixing other events: only its incremental ones go.
    let events: unknown[];
    try {
      events = JSON.parse(`[${unit.json}]`) as unknown[];
    } catch {
      continue;
    }
    const rest = events.filter((e) => eventType(e) !== INCREMENTAL);
    kept.push(
      ...eventUnits(
        rest.map((e) => JSON.stringify(e)),
        rest.map(eventType),
      ),
    );
  }
  return { kept, droppedSnapshot, suppress: suppressing };
}
