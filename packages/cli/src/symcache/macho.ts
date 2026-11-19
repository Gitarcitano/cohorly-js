// dSYM DWARF file -> one symcache v1 (kind 1, Mach-O) per 64-bit arch slice.
// Ported from spikes/vel-1784-native-crash/symcache/build-macho.ts.
//
// macOS only. Shells out to the Xcode toolchain and never parses DWARF bytes:
//   xcrun dwarfdump --debug-line  -> address -> (file, line) rows
//   xcrun dwarfdump --debug-info  -> subprograms + inlined_subroutine trees (streamed)
//   xcrun nm -n --defined-only    -> symbol table: outermost names, code without DWARF
//   xcrun swift-demangle / c++filt -> display names, the forms atos prints
// The Mach-O header (fat slices, LC_UUID, __TEXT vmaddr) is parsed here.

import { spawn, spawnSync } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  formatUuid,
  KIND_MACHO,
  MACHO_LOCATION_SIZE,
  MACHO_META_SIZE,
  MACHO_RANGE_SIZE,
  NONE,
  RecordWriter,
  remapId,
  SEC_MACHO_LOCATIONS,
  SEC_MACHO_RANGES,
  SEC_META,
  StringTable,
  writeSymcache,
} from "./format.js";

export interface Slice {
  arch: string;
  cpuType: number;
  cpuSubtype: number;
  uuid: Buffer;
  textVmaddr: bigint;
  textVmsize: bigint;
  textSectionEnd: bigint;
}

export type SliceHeader = Slice | SliceError;

/** `unsupported`: a 32-bit slice (e.g. watchOS arm64_32), skipped with a warning rather than failed. */
export type SliceError = { arch: string; error: string; unsupported?: true };

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

export function archName(cpuType: number, cpuSubtype: number): string {
  const sub = cpuSubtype & 0x00ffffff;
  if (cpuType === CPU_ARM64) return sub === 2 ? "arm64e" : "arm64";
  if (cpuType === CPU_X86_64) return sub === 8 ? "x86_64h" : "x86_64";
  if (cpuType === 12) return "arm";
  if (cpuType === 7) return "i386";
  if (cpuType === 0x0200000c) return "arm64_32";
  return `cpu${cpuType.toString(16)}`;
}

function parseSlice(cmdsHeader: Buffer, cmds: Buffer): Slice {
  const cpuType = cmdsHeader.readUInt32LE(4);
  const cpuSubtype = cmdsHeader.readUInt32LE(8);
  const ncmds = cmdsHeader.readUInt32LE(16);
  let uuid: Buffer | null = null;
  let textVmaddr = 0n;
  let textVmsize = 0n;
  let textSectionEnd = 0n;
  let p = 0;
  for (let i = 0; i < ncmds && p + 8 <= cmds.length; i++) {
    const cmd = cmds.readUInt32LE(p);
    const size = cmds.readUInt32LE(p + 4);
    if (size < 8) throw new Error("malformed Mach-O load command");
    if (cmd === 0x1b) uuid = Buffer.from(cmds.subarray(p + 8, p + 24));
    if (cmd === 0x19 && cmds.toString("latin1", p + 8, p + 24).replace(/\0+$/, "") === "__TEXT") {
      textVmaddr = cmds.readBigUInt64LE(p + 24);
      textVmsize = cmds.readBigUInt64LE(p + 32);
      const nsects = cmds.readUInt32LE(p + 64);
      for (let k = 0; k < nsects; k++) {
        const sp = p + 72 + k * 80;
        if (cmds.toString("latin1", sp, sp + 16).replace(/\0+$/, "") === "__text") {
          textSectionEnd = cmds.readBigUInt64LE(sp + 32) + cmds.readBigUInt64LE(sp + 40);
        }
      }
    }
    p += size;
  }
  const arch = archName(cpuType, cpuSubtype);
  if (!uuid) throw new Error(`${arch} slice has no LC_UUID`);
  if (textSectionEnd === 0n) textSectionEnd = textVmaddr + textVmsize;
  return { arch, cpuType, cpuSubtype, uuid, textVmaddr, textVmsize, textSectionEnd };
}

// One entry per slice of a thin or fat Mach-O. A slice that cannot be built
// (32-bit, no LC_UUID) is reported on its own; the others are still usable.
export async function readSlices(file: string): Promise<SliceHeader[]> {
  const fh = await open(file, "r");
  const readAt = async (pos: number, len: number) => {
    const b = Buffer.alloc(len);
    const { bytesRead } = await fh.read(b, 0, len, pos);
    if (bytesRead < len) throw new Error(`${file}: truncated Mach-O`);
    return b;
  };
  try {
    const magic = (await readAt(0, 4)).readUInt32BE(0);
    const offsets: number[] = [];
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const n = (await readAt(4, 4)).readUInt32BE(0);
      const entry = magic === 0xcafebabe ? 20 : 32;
      const table = await readAt(8, n * entry);
      for (let i = 0; i < n; i++) {
        offsets.push(magic === 0xcafebabe ? table.readUInt32BE(i * entry + 8) : Number(table.readBigUInt64BE(i * entry + 8)));
      }
    } else {
      offsets.push(0);
    }
    const out: SliceHeader[] = [];
    for (const off of offsets) {
      const h = await readAt(off, 32);
      const m = h.readUInt32LE(0);
      const cpuType = h.readUInt32LE(4);
      const arch = archName(cpuType, h.readUInt32LE(8));
      if (m === 0xfeedface || (m === 0xfeedfacf && (cpuType & CPU_ARCH_ABI64) === 0)) {
        out.push({ arch, unsupported: true, error: `${arch}: 32-bit Mach-O slices are not supported (symcache v1 targets arm64 and x86_64)` });
        continue;
      }
      if (m !== 0xfeedfacf) {
        out.push({ arch: "unknown", error: `not a 64-bit Mach-O slice (magic 0x${m.toString(16)})` });
        continue;
      }
      try {
        out.push(parseSlice(h, await readAt(off + 32, h.readUInt32LE(20))));
      } catch (err) {
        out.push({ arch, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  } finally {
    await fh.close();
  }
}

type LineTable = { version: number; dirs: string[]; files: Array<{ name: string; dir: number } | undefined> };
// ref = table index * 2^20 + file index, -1 = end_sequence
type Rows = { addr: number[]; ref: number[]; line: number[] };

// Streams a command's stdout line by line, parsed synchronously in the 'data'
// handler so the pipe applies backpressure instead of buffering the dump.
function lines(cmd: string[], onLine: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let carry: Buffer | null = null;
    let failed: unknown = null;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      try {
        const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
        let s = 0;
        for (let nl = buf.indexOf(10, s); nl >= 0; nl = buf.indexOf(10, s)) {
          onLine(buf.toString("utf8", s, nl));
          s = nl + 1;
        }
        carry = s < buf.length ? Buffer.from(buf.subarray(s)) : null;
      } catch (e) {
        failed = e;
        child.kill();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (failed) return reject(failed);
      if (carry) onLine(carry.toString("utf8"));
      if (code !== 0) return reject(new Error(`${cmd.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
      resolve();
    });
  });
}

function run(cmd: string, args: string[], input?: string): Buffer {
  const r = spawnSync(cmd, args, { input, maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`${cmd} ${args[0] ?? ""} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} exited ${r.status}: ${r.stderr.toString("utf8").trim().slice(-2000)}`);
  return r.stdout;
}

const ROW_RE = /^0x([0-9a-f]{16})\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s*(.*)$/;
const FILE_SHIFT = 2 ** 20;

async function readLineTables(file: string, arch: string): Promise<{ rows: Rows; tables: LineTable[]; offsets: number[] }> {
  const rows: Rows = { addr: [], ref: [], line: [] };
  const tables: LineTable[] = [];
  const offsets: number[] = [];
  let t: LineTable | null = null;
  let curFile: { name: string; dir: number } | null = null;
  await lines(["xcrun", "dwarfdump", "--debug-line", "--arch", arch, file], (l) => {
    if (l.startsWith("debug_line[")) {
      const table: LineTable = { version: 4, dirs: [], files: [] };
      t = table;
      tables.push(table);
      offsets.push(Number.parseInt(l.slice(11, l.indexOf("]")), 16));
      curFile = null;
      return;
    }
    const table = t as LineTable | null;
    if (!table) return;
    if (l.startsWith("0x")) {
      const m = ROW_RE.exec(l);
      if (!m) return;
      rows.addr.push(Number.parseInt(m[1]!, 16));
      if (m[5]!.includes("end_sequence")) {
        rows.ref.push(-1);
        rows.line.push(0);
      } else {
        rows.ref.push((tables.length - 1) * FILE_SHIFT + Number(m[4]));
        rows.line.push(Number(m[2]));
      }
      return;
    }
    const s = l.trimStart();
    const cf = curFile as { name: string; dir: number } | null;
    if (s.startsWith("version:")) table.version = Number(s.slice(8).trim());
    else if (s.startsWith("include_directories[")) {
      table.dirs[Number(s.slice(20, s.indexOf("]")).trim())] = s.slice(s.indexOf('"') + 1, s.lastIndexOf('"'));
    } else if (s.startsWith("file_names[")) {
      const entry = { name: "", dir: 0 };
      curFile = entry;
      table.files[Number(s.slice(11, s.indexOf("]")).trim())] = entry;
    } else if (cf && s.startsWith("name:")) cf.name = s.slice(s.indexOf('"') + 1, s.lastIndexOf('"'));
    else if (cf && s.startsWith("dir_index:")) cf.dir = Number(s.slice(10).trim());
  });
  return { rows, tables, offsets };
}

interface Node {
  name: string;
  ranges: number[];
  callFile: string | null;
  callLine: number;
  parent: Node | null;
  children: Node[];
  dieDepth: number;
}

const DIE_RE = /^0x[0-9a-f]+:( +)(DW_TAG_\w+|NULL)/;
const ATTR_RE = /^\s+(DW_AT_\w+)\t\((.*)$/;
const RANGE_RE = /\[0x([0-9a-f]+), 0x([0-9a-f]+)\)/g;
const QUOTED_RE = /"((?:[^"\\]|\\.)*)"/;
const KEPT_ATTRS = new Set([
  "DW_AT_low_pc",
  "DW_AT_high_pc",
  "DW_AT_ranges",
  "DW_AT_name",
  "DW_AT_linkage_name",
  "DW_AT_MIPS_linkage_name",
  "DW_AT_abstract_origin",
  "DW_AT_specification",
  "DW_AT_call_file",
  "DW_AT_call_line",
  "DW_AT_stmt_list",
  "DW_AT_comp_dir",
]);

interface OpenDie {
  tag: string;
  depth: number;
  attrs: Map<string, string>;
}

// Streams `dwarfdump --debug-info` and calls onRoot once per concrete
// subprogram, with its inlined_subroutine tree attached, as soon as its
// subtree is closed. Memory stays bounded by one function tree.
async function readSubprograms(file: string, arch: string, onRoot: (root: Node) => void, compDirs: Map<number, string>): Promise<void> {
  const stack: Array<Node | null> = [];
  const roots: Node[] = [];
  let cur: OpenDie | null = null;
  let curAttr = "";

  const quoted = (v: string | undefined) => (v ? (QUOTED_RE.exec(v)?.[1] ?? null) : null);
  const finishCur = () => {
    const die = cur as OpenDie | null;
    if (!die) return;
    const { tag, depth, attrs: a } = die;
    cur = null;
    stack.length = depth + 1;
    stack[depth] = null;
    if (tag === "DW_TAG_compile_unit" || tag === "DW_TAG_partial_unit") {
      const sl = a.get("DW_AT_stmt_list");
      const cd = quoted(a.get("DW_AT_comp_dir"));
      if (sl && cd) compDirs.set(Number.parseInt(sl, 16), cd);
      return;
    }
    if (tag !== "DW_TAG_subprogram" && tag !== "DW_TAG_inlined_subroutine") return;
    const ranges: number[] = [];
    const r = a.get("DW_AT_ranges");
    if (r) {
      for (const m of r.matchAll(RANGE_RE)) {
        const lo = Number.parseInt(m[1]!, 16);
        const hi = Number.parseInt(m[2]!, 16);
        if (hi > lo) ranges.push(lo, hi);
      }
    } else {
      const lo = a.get("DW_AT_low_pc");
      const hi = a.get("DW_AT_high_pc");
      if (lo && hi && Number.parseInt(hi, 16) > Number.parseInt(lo, 16)) ranges.push(Number.parseInt(lo, 16), Number.parseInt(hi, 16));
    }
    if (ranges.length === 0) return;
    const node: Node = {
      name:
        quoted(a.get("DW_AT_linkage_name")) ??
        quoted(a.get("DW_AT_MIPS_linkage_name")) ??
        quoted(a.get("DW_AT_abstract_origin")) ??
        quoted(a.get("DW_AT_specification")) ??
        quoted(a.get("DW_AT_name")) ??
        "",
      ranges,
      callFile: quoted(a.get("DW_AT_call_file")),
      callLine: Number.parseInt(a.get("DW_AT_call_line") ?? "0", 10) || 0,
      parent: null,
      children: [],
      dieDepth: depth,
    };
    stack[depth] = node;
    if (tag === "DW_TAG_subprogram") {
      roots.push(node);
      return;
    }
    for (let d = depth - 1; d >= 0; d--) {
      const p = stack[d];
      if (p) {
        node.parent = p;
        p.children.push(node);
        return;
      }
    }
  };
  const closeRoots = (depth: number) => {
    while (roots.length > 0 && roots[roots.length - 1]!.dieDepth >= depth) onRoot(roots.pop()!);
  };

  await lines(["xcrun", "dwarfdump", "--debug-info", "--arch", arch, file], (l) => {
    if (l.startsWith("0x")) {
      const m = DIE_RE.exec(l);
      if (!m) {
        if (l.includes("Compile Unit:") || l.includes("Type Unit:")) {
          finishCur();
          closeRoots(0);
        }
        return;
      }
      finishCur();
      const depth = (m[1]!.length - 1) / 2;
      closeRoots(depth);
      if (m[2] !== "NULL") cur = { tag: m[2]!, depth, attrs: new Map() };
      curAttr = "";
      return;
    }
    const die = cur as OpenDie | null;
    if (!die) return;
    const am = ATTR_RE.exec(l);
    if (am) {
      curAttr = KEPT_ATTRS.has(am[1]!) ? am[1]! : "";
      if (curAttr) die.attrs.set(curAttr, am[2]!);
      return;
    }
    if (curAttr === "DW_AT_ranges") die.attrs.set(curAttr, `${die.attrs.get(curAttr)} ${l.trim()}`);
  });
  finishCur();
  closeRoots(0);
}

function demangleAll(names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const keep = (list: string[], res: string[]) =>
    list.forEach((n, i) => {
      const d = res[i];
      if (d !== undefined && d !== "" && d !== n) out.set(n, d);
    });
  const swift = names.filter((n) => /^\$[sSe]|^_T0/.test(n));
  if (swift.length > 0) {
    keep(swift, run("xcrun", ["swift-demangle", "--simplified"], `${swift.join("\n")}\n`).toString("utf8").split("\n"));
  }
  // c++filt tokenizes stdin on whitespace and ObjC++ block names embed
  // `+[Class sel:with:]`, so names go as argv, in chunks.
  const cpp = names.filter((n) => /^_+Z/.test(n));
  for (let i = 0; i < cpp.length; ) {
    const chunk: string[] = [];
    let bytes = 0;
    while (i < cpp.length && bytes < 128 * 1024) {
      const name = cpp[i]!;
      chunk.push(name);
      bytes += name.length + 1;
      i++;
    }
    keep(chunk, run("xcrun", ["c++filt", ...chunk]).toString("utf8").split("\n"));
  }
  return out;
}

// Function symbols of (__TEXT,__text), one per address. Aliases at one
// address keep the first EXTERNAL name in nm order, else the first name.
function textSymbols(file: string, arch: string): Array<{ addr: number; name: string }> {
  const out: Array<{ addr: number; name: string; external: boolean }> = [];
  for (const l of run("xcrun", ["nm", "-n", "--defined-only", "--arch", arch, file]).toString("utf8").split("\n")) {
    const sp = l.indexOf(" ");
    if (sp < 0 || (l[sp + 1] !== "t" && l[sp + 1] !== "T") || l[sp + 2] !== " ") continue;
    const addr = Number.parseInt(l.slice(0, sp), 16);
    const external = l[sp + 1] === "T";
    let name = l.slice(sp + 3);
    if (name.startsWith("_")) name = name.slice(1);
    const last = out[out.length - 1];
    if (last && last.addr === addr) {
      if (external && !last.external) out[out.length - 1] = { addr, name, external };
      continue;
    }
    out.push({ addr, name, external });
  }
  return out.sort((a, b) => a.addr - b.addr);
}

interface Interval {
  start: number;
  end: number;
  loc: number;
}

// First index with arr[i] >= v.
function findSorted(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export async function buildSlice(file: string, slice: Slice): Promise<Buffer> {
  const strings = new StringTable();
  const compDirs = new Map<number, string>();
  const vmaddr = Number(slice.textVmaddr);

  const { rows, tables, offsets } = await readLineTables(file, slice.arch);

  const locKey = new Map<string, number>();
  const locs: number[] = []; // flat: name, file, line, parent
  const intern = (name: number, fileId: number, line: number, parent: number): number => {
    const k = `${name},${fileId},${line},${parent}`;
    let id = locKey.get(k);
    if (id === undefined) {
      id = locs.length / 4;
      locs.push(name, fileId, line, parent);
      locKey.set(k, id);
    }
    return id;
  };

  const nRows = rows.addr.length;
  const order = new Uint32Array(nRows);
  for (let i = 0; i < nRows; i++) order[i] = i;
  order.sort(
    (a, b) =>
      rows.addr[a]! - rows.addr[b]! || (rows.ref[a] === -1 ? 0 : 1) - (rows.ref[b] === -1 ? 0 : 1) || a - b,
  );
  const rowAddr = new Float64Array(nRows);
  for (let i = 0; i < nRows; i++) rowAddr[i] = rows.addr[order[i]!]!;
  // Last row with addr <= a (duplicates: the last one wins, like LLVM).
  const rowAt = (a: number): number => {
    let lo = 0;
    let hi = nRows - 1;
    let f = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (rowAddr[mid]! <= a) {
        f = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return f < 0 ? -1 : order[f]!;
  };

  // DWARF 4 directory 0 is the CU's comp_dir, which debug-info provides, so
  // row file refs are resolved lazily.
  const resolvedFile = new Map<number, number>();
  const fileOfRow = (r: number): number => {
    const ref = rows.ref[r]!;
    let id = resolvedFile.get(ref);
    if (id !== undefined) return id;
    const ti = Math.floor(ref / FILE_SHIFT);
    const t = tables[ti];
    const f = t?.files[ref % FILE_SHIFT];
    if (!t || !f) id = NONE;
    else {
      const compDir = compDirs.get(offsets[ti]!) ?? "";
      let dir = t.dirs[f.dir] ?? (f.dir === 0 ? compDir : "");
      if (dir && !dir.startsWith("/") && compDir) dir = `${compDir}/${dir}`;
      id = strings.add(f.name.startsWith("/") || !dir ? f.name : `${dir}/${f.name}`);
    }
    resolvedFile.set(ref, id);
    return id;
  };

  const intervals: Interval[] = [];
  const rawNames = new Set<string>();
  const nameId = (raw: string) => {
    rawNames.add(raw);
    return strings.add(raw);
  };

  const onRoot = (root: Node) => {
    const nodes: Node[] = [];
    const walkTree = (n: Node) => {
      nodes.push(n);
      for (const ch of n.children) walkTree(ch);
    };
    walkTree(root);
    const b = new Set<number>();
    for (const n of nodes) for (const v of n.ranges) b.add(v);
    for (let k = 0; k < root.ranges.length; k += 2) {
      const hi = root.ranges[k + 1]!;
      for (let s = findSorted(rowAddr, root.ranges[k]!); s < nRows && rowAddr[s]! < hi; s++) b.add(rowAddr[s]!);
    }
    const bounds = Float64Array.from(b).sort();
    const owner = new Int32Array(Math.max(bounds.length - 1, 0)).fill(-1);
    nodes.forEach((n, ni) => {
      for (let k = 0; k < n.ranges.length; k += 2) {
        const i = findSorted(bounds, n.ranges[k]!);
        const j = findSorted(bounds, n.ranges[k + 1]!);
        for (let s = i; s < j; s++) owner[s] = ni;
      }
    });
    const callerLoc = new Map<Node, number>();
    const callerOf = (n: Node): number => {
      if (!n.parent) return NONE;
      let v = callerLoc.get(n);
      if (v === undefined) {
        v = intern(nameId(n.parent.name), n.callFile ? strings.add(n.callFile) : NONE, n.callLine, callerOf(n.parent));
        callerLoc.set(n, v);
      }
      return v;
    };
    for (let s = 0; s < owner.length; s++) {
      const ni = owner[s]!;
      if (ni < 0) continue;
      const n = nodes[ni]!;
      const r = rowAt(bounds[s]!);
      let fileId = NONE;
      let line = 0;
      if (r >= 0 && rows.ref[r] !== -1) {
        fileId = fileOfRow(r);
        line = rows.line[r]!;
      }
      const loc = intern(nameId(n.name), fileId, line, callerOf(n));
      const last = intervals[intervals.length - 1];
      if (last && last.end === bounds[s] && last.loc === loc) last.end = bounds[s + 1]!;
      else intervals.push({ start: bounds[s]!, end: bounds[s + 1]!, loc });
    }
  };
  await readSubprograms(file, slice.arch, onRoot, compDirs);

  const syms = textSymbols(file, slice.arch);
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  // Overlapping DWARF intervals (identical code folding): first one wins.
  const dwarf: Interval[] = [];
  for (const iv of intervals) {
    const last = dwarf[dwarf.length - 1];
    if (last && iv.start < last.end) {
      if (iv.end > last.end) dwarf.push({ start: last.end, end: iv.end, loc: iv.loc });
      continue;
    }
    dwarf.push(iv);
  }
  // Within each symbol [start, next symbol): DWARF pieces keep their inline
  // chain but take the symbol's name for the outermost frame. A symbol with
  // any DWARF is bounded by it; only a symbol with no DWARF at all is filled
  // from the symbol table (docs/NATIVE-SYMBOLICATION.md section 3).
  const textEnd = Number(slice.textSectionEnd);
  const renamed = new Map<string, number>();
  const withOuterName = (loc: number, name: number): number => {
    const parent = locs[loc * 4 + 3]!;
    if (parent === NONE && locs[loc * 4] === name) return loc;
    const k = `${loc}:${name}`;
    let v = renamed.get(k);
    if (v === undefined) {
      v =
        parent === NONE
          ? intern(name, locs[loc * 4 + 1]!, locs[loc * 4 + 2]!, NONE)
          : intern(locs[loc * 4]!, locs[loc * 4 + 1]!, locs[loc * 4 + 2]!, withOuterName(parent, name));
      renamed.set(k, v);
    }
    return v;
  };
  const all: Interval[] = [];
  let di = 0;
  const firstSym = syms.length > 0 ? syms[0]!.addr : textEnd;
  while (di < dwarf.length && dwarf[di]!.start < firstSym) {
    const d = dwarf[di]!;
    all.push({ ...d, end: Math.min(d.end, firstSym) });
    if (d.end > firstSym) break;
    di++;
  }
  for (let i = 0; i < syms.length; i++) {
    const sym = syms[i]!;
    const start = sym.addr;
    const next = syms[i + 1];
    const end = Math.min(next ? next.addr : textEnd, textEnd);
    if (end <= start) continue;
    const name = nameId(sym.name);
    while (di < dwarf.length && dwarf[di]!.end <= start) di++;
    const hasDwarf = di < dwarf.length && dwarf[di]!.start < end;
    let a = start;
    let k = di;
    while (a < end) {
      const dk = dwarf[k];
      if (dk && dk.start <= a) {
        const e = Math.min(dk.end, end);
        all.push({ start: a, end: e, loc: withOuterName(dk.loc, name) });
        a = e;
        if (dk.end <= end) k++;
        continue;
      }
      const gapEnd = Math.min(end, dk ? dk.start : end);
      if (hasDwarf) {
        a = gapEnd;
        continue;
      }
      let p = a;
      while (p < gapEnd) {
        const r = rowAt(p);
        const s = findSorted(rowAddr, p + 1);
        const nextRow = Math.min(gapEnd, s < nRows ? rowAddr[s]! : gapEnd);
        const hasRow = r >= 0 && rows.ref[r] !== -1;
        all.push({ start: p, end: nextRow, loc: intern(name, hasRow ? fileOfRow(r) : NONE, hasRow ? rows.line[r]! : 0, NONE) });
        p = nextRow;
      }
      a = gapEnd;
    }
  }
  for (const d of dwarf) if (d.end > textEnd) all.push({ start: Math.max(d.start, textEnd), end: d.end, loc: d.loc });
  all.sort((x, y) => x.start - y.start || x.end - y.end);

  const demangled = demangleAll([...rawNames].sort());
  const nameRemap = new Map<number, number>();
  for (const raw of rawNames) {
    const d = demangled.get(raw);
    if (d !== undefined) nameRemap.set(strings.add(raw), strings.add(d));
  }
  for (let i = 0; i < locs.length; i += 4) {
    const r = nameRemap.get(locs[i]!);
    if (r !== undefined) locs[i] = r;
  }
  // Rebuild the string table from what locations and meta use, so mangled
  // names never reach the output.
  const out = new StringTable();
  const used = (p: number) => (p === NONE ? NONE : out.add(strings.get(p)));
  const metaImage = out.add(path.basename(file));
  const metaArch = out.add(slice.arch);
  // Locations renumbered in first-use order of the address-sorted ranges.
  const newLoc = new Map<number, number>();
  const locOut: number[] = [];
  const mapLoc = (l: number): number => {
    if (l === NONE) return NONE;
    let v = newLoc.get(l);
    if (v !== undefined) return v;
    const parent = mapLoc(locs[l * 4 + 3]!);
    v = locOut.length / 4;
    locOut.push(used(locs[l * 4]!), used(locs[l * 4 + 1]!), locs[l * 4 + 2]!, parent);
    newLoc.set(l, v);
    return v;
  };
  const rangeW = new RecordWriter(MACHO_RANGE_SIZE, all.length * 2 + 2);
  let prevEnd = -1;
  let prevLoc = -2;
  const emit = (addr: number, loc: number) => {
    const ra = rangeW.begin();
    rangeW.u32(ra, addr - vmaddr);
    rangeW.u32(ra + 4, loc);
  };
  for (const iv of all) {
    const loc = mapLoc(iv.loc);
    if (prevEnd >= 0 && iv.start > prevEnd) {
      emit(prevEnd, NONE);
      prevLoc = NONE;
    }
    if (!(iv.start === prevEnd && loc === prevLoc)) emit(iv.start, loc);
    prevEnd = iv.end;
    prevLoc = loc;
  }
  if (prevEnd >= 0) emit(prevEnd, NONE);
  const fin = out.finalize();
  const locW = new RecordWriter(MACHO_LOCATION_SIZE, locOut.length / 4 + 1);
  for (let i = 0; i < locOut.length; i += 4) {
    const la = locW.begin();
    locW.u32(la, remapId(fin.remap, locOut[i]!));
    locW.u32(la + 4, remapId(fin.remap, locOut[i + 1]!));
    locW.u32(la + 8, locOut[i + 2]!);
    locW.u32(la + 12, locOut[i + 3]!);
  }
  const meta = Buffer.alloc(MACHO_META_SIZE);
  meta.writeUInt32LE(slice.cpuType, 0);
  meta.writeUInt32LE(slice.cpuSubtype, 4);
  meta.writeUInt32LE(Number(slice.textVmaddr & 0xffffffffn), 8);
  meta.writeUInt32LE(Number(slice.textVmaddr >> 32n), 12);
  meta.writeUInt32LE(Number(slice.textVmsize & 0xffffffffn), 16);
  meta.writeUInt32LE(fin.remap[metaImage]!, 20);
  meta.writeUInt32LE(fin.remap[metaArch]!, 24);
  const identity = Buffer.alloc(32);
  slice.uuid.copy(identity, 0);
  return writeSymcache({
    kind: KIND_MACHO,
    flags: 0,
    identity,
    sections: [
      ...fin.sections,
      { id: SEC_META, recordSize: MACHO_META_SIZE, count: 1, data: meta },
      rangeW.section(SEC_MACHO_RANGES),
      locW.section(SEC_MACHO_LOCATIONS),
    ],
  });
}

export type SymcacheSliceResult = { debugId: string; arch: string; bytes: Uint8Array } | SliceError;

export interface SymcacheBuilder {
  /** One entry per arch slice of a DWARF file, a failed slice as `{ arch, error }`. */
  build(dwarfFile: string): Promise<SymcacheSliceResult[]>;
  /** Whether the Xcode tools the builder shells out to are installed. */
  available(): Promise<boolean>;
}

export const xcodeSymcacheBuilder: SymcacheBuilder = {
  async build(dwarfFile) {
    const out: SymcacheSliceResult[] = [];
    for (const slice of await readSlices(dwarfFile)) {
      if ("error" in slice) {
        out.push(slice);
        continue;
      }
      try {
        out.push({ debugId: formatUuid(slice.uuid), arch: slice.arch, bytes: await buildSlice(dwarfFile, slice) });
      } catch (err) {
        out.push({ arch: slice.arch, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  },
  async available() {
    const r = spawnSync("xcrun", ["-f", "dwarfdump"], { stdio: "ignore" });
    return r.status === 0;
  },
};
