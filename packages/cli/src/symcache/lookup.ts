// Mach-O symcache reader: binary search over fixed-width records, nothing
// decoded up front beyond the header and the section directory. Ported from
// spikes/vel-1784-native-crash/symcache/lookup.ts (Mach-O part). The CLI only
// uses it to check its own output; the server has its own reader.

import {
  formatUuid,
  type Header,
  KIND_MACHO,
  NONE,
  parseHeader,
  SEC_MACHO_LOCATIONS,
  SEC_MACHO_RANGES,
  SEC_META,
  SEC_STRING_DATA,
  SEC_STRING_OFFSETS,
  type SectionRef,
} from "./format.js";

export interface NativeFrame {
  function: string;
  filename?: string;
  abs_path?: string;
  lineno?: number;
  inlined: boolean;
}

function section(h: Header, id: number): SectionRef {
  const s = h.sections.get(id);
  if (!s) throw new Error(`symcache: missing section ${id}`);
  return s;
}

export class MachoSymcache {
  readonly header: Header;
  readonly debugId: string;
  readonly arch: string;
  readonly imageName: string;
  readonly cpuType: number;
  readonly textVmaddr: bigint;
  private readonly buf: Buffer;
  private readonly offsets: SectionRef;
  private readonly data: SectionRef;
  private readonly ranges: SectionRef;
  private readonly locs: SectionRef;

  constructor(bytes: Uint8Array) {
    this.buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.header = parseHeader(this.buf);
    if (this.header.kind !== KIND_MACHO) throw new Error(`symcache: kind ${this.header.kind} is not Mach-O`);
    this.offsets = section(this.header, SEC_STRING_OFFSETS);
    this.data = section(this.header, SEC_STRING_DATA);
    this.ranges = section(this.header, SEC_MACHO_RANGES);
    this.locs = section(this.header, SEC_MACHO_LOCATIONS);
    const meta = section(this.header, SEC_META);
    this.cpuType = this.buf.readUInt32LE(meta.offset);
    this.textVmaddr = (BigInt(this.buf.readUInt32LE(meta.offset + 12)) << 32n) | BigInt(this.buf.readUInt32LE(meta.offset + 8));
    this.imageName = this.string(this.buf.readUInt32LE(meta.offset + 20)) ?? "";
    this.arch = this.string(this.buf.readUInt32LE(meta.offset + 24)) ?? "";
    this.debugId = formatUuid(this.header.identity);
  }

  private string(id: number): string | undefined {
    if (id === NONE) return undefined;
    const at = this.offsets.offset + id * this.offsets.recordSize;
    const start = this.buf.readUInt32LE(at);
    const end = this.buf.readUInt32LE(at + this.offsets.recordSize);
    return this.buf.toString("utf8", this.data.offset + start, this.data.offset + end);
  }

  // rel is relative to the slice's __TEXT vmaddr. Returns the inline chain
  // innermost first, like `atos -i`; [] when nothing covers rel.
  resolve(rel: number): NativeFrame[] {
    const { offset, count, recordSize } = this.ranges;
    if (count === 0 || rel < 0 || rel > 0xffffffff) return [];
    let lo = 0;
    let hi = count - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.buf.readUInt32LE(offset + mid * recordSize) <= rel) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return [];
    let loc = this.buf.readUInt32LE(offset + found * recordSize + 4);
    const out: NativeFrame[] = [];
    while (loc !== NONE) {
      const at = this.locs.offset + loc * this.locs.recordSize;
      const parent = this.buf.readUInt32LE(at + 12);
      const absPath = this.string(this.buf.readUInt32LE(at + 4));
      const line = this.buf.readUInt32LE(at + 8);
      const frame: NativeFrame = { function: this.string(this.buf.readUInt32LE(at)) ?? "", inlined: parent !== NONE };
      if (absPath !== undefined) {
        frame.abs_path = absPath;
        frame.filename = absPath.slice(absPath.lastIndexOf("/") + 1);
      }
      if (line !== 0) frame.lineno = line;
      out.push(frame);
      loc = parent;
    }
    return out;
  }
}

export function openMachoSymcache(bytes: Uint8Array): MachoSymcache {
  return new MachoSymcache(bytes);
}
