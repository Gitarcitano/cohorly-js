// symcache v1 container, Mach-O part: constants, the deterministic writer and
// the header parser. Byte-exact spec: docs/NATIVE-SYMBOLICATION.md, section 3.
// Ported from spikes/vel-1784-native-crash/symcache/format.ts.

export const MAGIC = "CHLYSYMC";
export const SYMCACHE_VERSION = 1;
export const KIND_MACHO = 1;
export const HEADER_SIZE = 64;
export const DIR_ENTRY_SIZE = 16;
export const SECTION_ALIGN = 8;
export const NONE = 0xffffffff;

export const SEC_STRING_OFFSETS = 1;
export const SEC_STRING_DATA = 2;
export const SEC_META = 3;
export const SEC_MACHO_RANGES = 16;
export const SEC_MACHO_LOCATIONS = 17;

// A reader always uses the directory's recordSize as the stride, so a later
// minor revision can append fields to a record.
export const MACHO_META_SIZE = 32;
export const MACHO_RANGE_SIZE = 8;
export const MACHO_LOCATION_SIZE = 16;

// UTF-8 byte order. JS `<` compares UTF-16 code units, which agrees with UTF-8
// byte order except when a surrogate meets a code unit at or above U+E000;
// those rare pairs fall back to a byte comparison.
export function compareUtf8(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if (x < 0xd800 && y < 0xd800) return x - y;
    return Buffer.compare(Buffer.from(a), Buffer.from(b));
  }
  return a.length - b.length;
}

export interface Section {
  id: number;
  recordSize: number;
  count: number;
  data: Buffer;
}

// Deduplicated string table. Strings are interned to provisional ids while
// parsing, then finalize() assigns final ids in UTF-8 byte order and returns
// provisional -> final.
export class StringTable {
  private map = new Map<string, number>();
  private list: string[] = [];

  add(s: string): number {
    let id = this.map.get(s);
    if (id === undefined) {
      id = this.list.length;
      this.map.set(s, id);
      this.list.push(s);
    }
    return id;
  }

  get(provisional: number): string {
    const s = this.list[provisional];
    if (s === undefined) throw new Error(`symcache: unknown string id ${provisional}`);
    return s;
  }

  get size(): number {
    return this.list.length;
  }

  finalize(): { sections: Section[]; remap: Uint32Array } {
    const order = this.list.map((_, i) => i).sort((a, b) => compareUtf8(this.get(a), this.get(b)));
    const remap = new Uint32Array(this.list.length);
    const encoded = order.map((p) => Buffer.from(this.get(p), "utf8"));
    const offsets = Buffer.alloc((order.length + 1) * 4);
    let pos = 0;
    for (let i = 0; i < order.length; i++) {
      remap[order[i]!] = i;
      offsets.writeUInt32LE(pos, i * 4);
      pos += encoded[i]!.length;
    }
    if (pos > 0xffffffff) throw new Error("symcache: string data larger than 4 GiB");
    offsets.writeUInt32LE(pos, order.length * 4);
    return {
      remap,
      sections: [
        { id: SEC_STRING_OFFSETS, recordSize: 4, count: order.length + 1, data: offsets },
        { id: SEC_STRING_DATA, recordSize: 1, count: pos, data: Buffer.concat(encoded, pos) },
      ],
    };
  }
}

export function remapId(remap: Uint32Array, provisional: number): number {
  return provisional === NONE ? NONE : remap[provisional]!;
}

export function writeSymcache(opts: { kind: number; flags: number; identity: Buffer; sections: Section[] }): Buffer {
  if (opts.identity.length !== 32) throw new Error("symcache: identity must be 32 bytes");
  const sections = [...opts.sections].sort((a, b) => a.id - b.id);
  const dirEnd = HEADER_SIZE + sections.length * DIR_ENTRY_SIZE;
  const align = (n: number) => Math.ceil(n / SECTION_ALIGN) * SECTION_ALIGN;
  let pos = align(dirEnd);
  const offsets: number[] = [];
  for (const s of sections) {
    if (s.data.length !== s.recordSize * s.count) {
      throw new Error(`symcache: section ${s.id} size ${s.data.length} != ${s.recordSize} * ${s.count}`);
    }
    offsets.push(pos);
    pos = align(pos + s.data.length);
  }
  if (pos > 0xffffffff) throw new Error("symcache: larger than 4 GiB is not representable in v1");
  const out = Buffer.alloc(pos);
  out.write(MAGIC, 0, "ascii");
  out.writeUInt16LE(SYMCACHE_VERSION, 8);
  out.writeUInt16LE(opts.kind, 10);
  out.writeUInt32LE(HEADER_SIZE, 12);
  out.writeUInt32LE(pos, 16);
  out.writeUInt32LE(sections.length, 20);
  out.writeUInt32LE(opts.flags, 24);
  out.writeUInt32LE(0, 28);
  opts.identity.copy(out, 32);
  sections.forEach((s, i) => {
    const d = HEADER_SIZE + i * DIR_ENTRY_SIZE;
    const offset = offsets[i]!;
    out.writeUInt32LE(s.id, d);
    out.writeUInt32LE(offset, d + 4);
    out.writeUInt32LE(s.count, d + 8);
    out.writeUInt32LE(s.recordSize, d + 12);
    s.data.copy(out, offset);
  });
  return out;
}

// Grows a little-endian record buffer without per-record allocations.
export class RecordWriter {
  private buf: Buffer;
  private pos = 0;
  count = 0;
  readonly recordSize: number;

  constructor(recordSize: number, initialRecords = 1024) {
    this.recordSize = recordSize;
    this.buf = Buffer.alloc(recordSize * Math.max(initialRecords, 1));
  }

  begin(): number {
    if (this.pos + this.recordSize > this.buf.length) {
      const next = Buffer.alloc(this.buf.length * 2);
      this.buf.copy(next, 0, 0, this.pos);
      this.buf = next;
    }
    const at = this.pos;
    this.pos += this.recordSize;
    this.count++;
    return at;
  }

  u32(at: number, v: number): void {
    this.buf.writeUInt32LE(v >>> 0, at);
  }

  section(id: number): Section {
    return { id, recordSize: this.recordSize, count: this.count, data: this.buf.subarray(0, this.pos) };
  }
}

export interface SectionRef {
  offset: number;
  count: number;
  recordSize: number;
}

export interface Header {
  version: number;
  kind: number;
  headerSize: number;
  fileSize: number;
  flags: number;
  identity: Buffer;
  sections: Map<number, SectionRef>;
}

export function parseHeader(buf: Buffer): Header {
  if (buf.length < HEADER_SIZE) throw new Error("symcache: file too small");
  if (buf.toString("ascii", 0, 8) !== MAGIC) throw new Error("symcache: bad magic");
  const version = buf.readUInt16LE(8);
  if (version !== SYMCACHE_VERSION) throw new Error(`symcache: unsupported version ${version}`);
  const kind = buf.readUInt16LE(10);
  const headerSize = buf.readUInt32LE(12);
  const fileSize = buf.readUInt32LE(16);
  const count = buf.readUInt32LE(20);
  if (fileSize !== buf.length) throw new Error(`symcache: size ${buf.length} != header ${fileSize}`);
  if (headerSize + count * DIR_ENTRY_SIZE > fileSize) throw new Error("symcache: directory out of bounds");
  const sections = new Map<number, SectionRef>();
  for (let i = 0; i < count; i++) {
    const d = headerSize + i * DIR_ENTRY_SIZE;
    const ref = { offset: buf.readUInt32LE(d + 4), count: buf.readUInt32LE(d + 8), recordSize: buf.readUInt32LE(d + 12) };
    if (ref.offset + ref.count * ref.recordSize > fileSize) throw new Error("symcache: section out of bounds");
    sections.set(buf.readUInt32LE(d), ref);
  }
  return {
    version,
    kind,
    headerSize,
    fileSize,
    flags: buf.readUInt32LE(24),
    identity: Buffer.from(buf.subarray(32, 64)),
    sections,
  };
}

// 16-byte Mach-O UUID -> wire debug_id (lowercase, 8-4-4-4-12).
export function formatUuid(b: Buffer): string {
  const h = b.toString("hex", 0, 16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
