export const INDEX_MAGIC = "CSMI";
export const INDEX_VERSION = 1;
export const NONE = 0xffffffff;
const HEADER_BYTES = 32;

export type Segment = readonly number[];

export interface DecodedMap {
  sources: readonly (string | null)[];
  names: readonly string[];
  mappings: readonly (readonly Segment[])[];
}

export interface OriginalPosition {
  source: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
}

export interface SourceMapIndex {
  lineOffsets: Uint32Array;
  columns: Uint32Array;
  sources: Uint32Array;
  lines: Uint32Array;
  sourceColumns: Uint32Array;
  names: Uint32Array;
  sourceTable: string[];
  nameTable: string[];
}

class StringTable {
  readonly values: string[] = [];
  private readonly ids = new Map<string, number>();

  id(value: string): number {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = this.values.length;
      this.values.push(value);
      this.ids.set(value, id);
    }
    return id;
  }
}

export class IndexFormatError extends Error {}

function assertRepresentable(value: number, line: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= NONE) {
    throw new IndexFormatError(`source map position ${value} on generated line ${line + 1} does not fit the index (0 to ${NONE - 1})`);
  }
}

export function buildIndex(map: DecodedMap): SourceMapIndex {
  const lineCount = map.mappings.length;
  let capacity = 0;
  for (const line of map.mappings) capacity += line.length;

  const lineOffsets = new Uint32Array(lineCount + 1);
  const columns = new Uint32Array(capacity);
  const sources = new Uint32Array(capacity);
  const lines = new Uint32Array(capacity);
  const sourceColumns = new Uint32Array(capacity);
  const names = new Uint32Array(capacity);
  const sourceTable = new StringTable();
  const nameTable = new StringTable();

  let n = 0;
  for (let l = 0; l < lineCount; l++) {
    lineOffsets[l] = n;
    const start = n;
    let groupSize = 0;
    for (const segment of map.mappings[l]!) {
      for (let f = 0; f < Math.min(segment.length, 4); f++) {
        if (f === 1) continue;
        assertRepresentable(segment[f]!, l);
      }
      const column = segment[0]!;
      if (n > start && columns[n - 1] === column) {
        if (groupSize === 2) n--;
        groupSize = 2;
      } else {
        groupSize = 1;
      }
      columns[n] = column;
      if (segment.length >= 4) {
        sources[n] = sourceTable.id(map.sources[segment[1]!] ?? "");
        lines[n] = segment[2]!;
        sourceColumns[n] = segment[3]!;
        const name = segment.length === 5 ? map.names[segment[4]!] : undefined;
        names[n] = name === undefined ? NONE : nameTable.id(name);
      } else {
        sources[n] = NONE;
        lines[n] = 0;
        sourceColumns[n] = 0;
        names[n] = NONE;
      }
      n++;
    }
  }
  lineOffsets[lineCount] = n;

  return {
    lineOffsets,
    columns: columns.slice(0, n),
    sources: sources.slice(0, n),
    lines: lines.slice(0, n),
    sourceColumns: sourceColumns.slice(0, n),
    names: names.slice(0, n),
    sourceTable: sourceTable.values,
    nameTable: nameTable.values,
  };
}

const NO_POSITION = (): OriginalPosition => ({ source: null, line: null, column: null, name: null });

export function lookup(index: SourceMapIndex, line: number, column: number): OriginalPosition {
  if (line < 1 || column < 0) return NO_POSITION();
  const l = line - 1;
  if (l >= index.lineOffsets.length - 1) return NO_POSITION();
  const lineStart = index.lineOffsets[l]!;
  let lo = lineStart;
  let hi = index.lineOffsets[l + 1]!;
  let found = -1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (index.columns[mid]! <= column) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (found < 0) return NO_POSITION();
  if (found > lineStart && index.columns[found - 1] === column && index.columns[found] === column) found--;
  const source = index.sources[found]!;
  if (source === NONE) return NO_POSITION();
  const name = index.names[found]!;
  return {
    source: index.sourceTable[source]!,
    line: index.lines[found]! + 1,
    column: index.sourceColumns[found]!,
    name: name === NONE ? null : index.nameTable[name]!,
  };
}

export function serializeIndex(index: SourceMapIndex): Uint8Array {
  const encoder = new TextEncoder();
  const strings = [...index.sourceTable, ...index.nameTable].map((s) => encoder.encode(s));
  const blobLength = strings.reduce((sum, s) => sum + s.length, 0);
  const lineCount = index.lineOffsets.length - 1;
  const segmentCount = index.columns.length;
  const stringCount = strings.length;
  const total = HEADER_BYTES + 4 * (lineCount + 1) + 4 * 5 * segmentCount + 4 * (stringCount + 1) + blobLength;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(encoder.encode(INDEX_MAGIC), 0);
  view.setUint16(4, INDEX_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, lineCount, true);
  view.setUint32(12, segmentCount, true);
  view.setUint32(16, index.sourceTable.length, true);
  view.setUint32(20, index.nameTable.length, true);
  view.setUint32(24, blobLength, true);
  view.setUint32(28, 0, true);

  let offset = HEADER_BYTES;
  const writeArray = (values: ArrayLike<number>) => {
    for (let i = 0; i < values.length; i++) {
      view.setUint32(offset, values[i]!, true);
      offset += 4;
    }
  };
  writeArray(index.lineOffsets);
  writeArray(index.columns);
  writeArray(index.sources);
  writeArray(index.lines);
  writeArray(index.sourceColumns);
  writeArray(index.names);

  let stringOffset = 0;
  for (const s of strings) {
    view.setUint32(offset, stringOffset, true);
    offset += 4;
    stringOffset += s.length;
  }
  view.setUint32(offset, stringOffset, true);
  offset += 4;
  for (const s of strings) {
    out.set(s, offset);
    offset += s.length;
  }
  return out;
}

export function parseIndex(bytes: Uint8Array): SourceMapIndex {
  if (bytes.length < HEADER_BYTES) throw new IndexFormatError("index is shorter than its header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== INDEX_MAGIC) throw new IndexFormatError("not a Cohorly source map index (bad magic)");
  const version = view.getUint16(4, true);
  if (version !== INDEX_VERSION) throw new IndexFormatError(`unsupported index version ${version}`);
  const lineCount = view.getUint32(8, true);
  const segmentCount = view.getUint32(12, true);
  const sourceCount = view.getUint32(16, true);
  const nameCount = view.getUint32(20, true);
  const blobLength = view.getUint32(24, true);
  const stringCount = sourceCount + nameCount;
  const expected = HEADER_BYTES + 4 * (lineCount + 1) + 4 * 5 * segmentCount + 4 * (stringCount + 1) + blobLength;
  if (bytes.length !== expected) throw new IndexFormatError("index length does not match its header");

  let offset = HEADER_BYTES;
  const readArray = (count: number) => {
    const values = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = view.getUint32(offset, true);
      offset += 4;
    }
    return values;
  };
  const lineOffsets = readArray(lineCount + 1);
  const columns = readArray(segmentCount);
  const sources = readArray(segmentCount);
  const lines = readArray(segmentCount);
  const sourceColumns = readArray(segmentCount);
  const names = readArray(segmentCount);
  const stringOffsets = readArray(stringCount + 1);
  const decoder = new TextDecoder();
  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) {
    strings.push(decoder.decode(bytes.subarray(offset + stringOffsets[i]!, offset + stringOffsets[i + 1]!)));
  }
  return {
    lineOffsets,
    columns,
    sources,
    lines,
    sourceColumns,
    names,
    sourceTable: strings.slice(0, sourceCount),
    nameTable: strings.slice(sourceCount),
  };
}
