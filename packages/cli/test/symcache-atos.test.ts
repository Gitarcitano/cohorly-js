// macOS only: builds a fat (arm64 + x86_64) C/C++ fixture with the Xcode
// toolchain, then checks the symcache against `atos -i` for every instruction
// of (__TEXT,__text), frame by frame. The fixture is compiled here, never
// committed as a binary.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { formatUuid, HEADER_SIZE, KIND_MACHO, MAGIC, SYMCACHE_VERSION } from "../src/symcache/format.js";
import { MachoSymcache } from "../src/symcache/lookup.js";
import { readSlices, type Slice, xcodeSymcacheBuilder } from "../src/symcache/macho.js";
import { makeIo, startServer } from "./helpers.js";

const NATIVE = fileURLToPath(new URL("./fixtures/native/", import.meta.url));
const ARCHS = ["arm64", "x86_64"];

function xcrun(args: string[], cwd?: string): string {
  return execFileSync("xcrun", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
}

function dwarfdumpUuids(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xcrun(["dwarfdump", "--uuid", file]).matchAll(/^UUID: ([0-9A-F-]{36}) \(([^)]+)\)/gm)) {
    out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

function textSection(binary: string, arch: string): { start: number; end: number } {
  const loadCommands = xcrun(["otool", "-arch", arch, "-l", binary]);
  const m = /sectname __text\n\s+segname __TEXT\n\s+addr (0x[0-9a-f]+)\n\s+size (0x[0-9a-f]+)/.exec(loadCommands);
  if (!m) throw new Error(`no (__TEXT,__text) in ${binary} (${arch})`);
  const start = Number.parseInt(m[1]!, 16);
  return { start, end: start + Number.parseInt(m[2]!, 16) };
}

// Every instruction start: a fixed 4-byte step on arm64, the disassembly on x86_64.
function instructionAddresses(binary: string, arch: string): number[] {
  const { start, end } = textSection(binary, arch);
  if (arch === "arm64") {
    const out: number[] = [];
    for (let a = start; a < end; a += 4) out.push(a);
    return out;
  }
  const out = new Set<number>();
  for (const line of xcrun(["otool", "-arch", arch, "-tv", binary]).split("\n")) {
    const m = /^([0-9a-f]{16})\s/.exec(line);
    if (m) out.add(Number.parseInt(m[1]!, 16));
  }
  return [...out].filter((a) => a >= start && a < end).sort((a, b) => a - b);
}

interface Frame {
  function: string;
  file?: string;
  line?: number;
}

function parseAtosLine(line: string): Frame | null {
  const inAt = line.lastIndexOf(" (in ");
  if (inAt < 0) return null;
  const fn = line.slice(0, inAt);
  if (/^0x[0-9a-f]+$/.test(fn)) return null;
  const rest = line.slice(line.indexOf(")", inAt) + 1).trim();
  const m = /^\((.*):(\d+)\)$/.exec(rest);
  if (m) return { function: fn, file: m[1]!.slice(m[1]!.lastIndexOf("/") + 1), line: Number(m[2]) };
  return { function: fn };
}

// `atos -i` prints each address's frames (or one empty line when it cannot
// resolve it) followed by a blank line.
function atos(dwarf: string, slice: Slice, addrs: number[]): Frame[][] {
  const args = ["-arch", slice.arch, "-o", dwarf, "-l", `0x${slice.textVmaddr.toString(16)}`, "-i"];
  const r = spawnSync("atos", args, { input: `${addrs.map((a) => `0x${a.toString(16)}`).join("\n")}\n`, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`atos failed: ${r.stderr.toString()}`);
  const text = r.stdout.toString("utf8");
  const blocks = (text.endsWith("\n\n") ? text.slice(0, -2) : text).split("\n\n");
  if (blocks.length !== addrs.length) {
    return addrs.length === 1 ? [[]] : addrs.map((a) => atos(dwarf, slice, [a])[0]!);
  }
  return blocks.map((b) => b.split("\n").map(parseAtosLine).filter((f): f is Frame => f !== null));
}

const onMac = process.platform === "darwin" && spawnSync("xcrun", ["-f", "dwarfdump"], { stdio: "ignore" }).status === 0;

describe.skipIf(!onMac)("dSYM symcache against atos (macOS)", () => {
  let binary = "";
  let dsym = "";
  let dwarf = "";

  beforeAll(async () => {
    const work = await mkdtemp(path.join(tmpdir(), "cohorly-native-"));
    const flags = ["-g", "-O2", ...ARCHS.flatMap((a) => ["-arch", a]), `-I${NATIVE}`];
    const objects: string[] = [];
    for (const [src, compiler] of [
      ["main.c", "clang"],
      ["math.c", "clang"],
      ["shapes.cpp", "clang++"],
    ] as const) {
      const obj = path.join(work, `${src}.o`);
      xcrun([compiler, ...flags, "-c", path.join(NATIVE, src), "-o", obj]);
      objects.push(obj);
    }
    binary = path.join(work, "NativeFixture");
    // -no_deduplicate keeps every function at its own address: atos prints
    // <deduplicated_symbol> for folded code, where any alias is right.
    xcrun(["clang", ...ARCHS.flatMap((a) => ["-arch", a]), "-Wl,-no_deduplicate", ...objects, "-o", binary]);
    dsym = `${binary}.dSYM`;
    xcrun(["dsymutil", binary, "-o", dsym]);
    dwarf = path.join(dsym, "Contents/Resources/DWARF/NativeFixture");
  }, 120_000);

  let servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });

  it("writes a valid header whose identity is the slice's LC_UUID", async () => {
    const uuids = dwarfdumpUuids(dwarf);
    const built = await xcodeSymcacheBuilder.build(dwarf);
    expect(built.map((b) => b.arch).sort()).toEqual([...ARCHS].sort());
    for (const slice of built) {
      if ("error" in slice) throw new Error(slice.error);
      const bytes = Buffer.from(slice.bytes);
      expect(bytes.toString("ascii", 0, 8)).toBe(MAGIC);
      expect(bytes.readUInt16LE(8)).toBe(SYMCACHE_VERSION);
      expect(bytes.readUInt16LE(10)).toBe(KIND_MACHO);
      expect(bytes.readUInt32LE(12)).toBe(HEADER_SIZE);
      expect(bytes.readUInt32LE(16)).toBe(bytes.length);
      expect(formatUuid(bytes.subarray(32, 48))).toBe(uuids.get(slice.arch));
      expect(bytes.subarray(48, 64).every((b) => b === 0)).toBe(true);
      expect(slice.debugId).toBe(uuids.get(slice.arch));
      const sc = new MachoSymcache(slice.bytes);
      expect(sc.arch).toBe(slice.arch);
      expect(sc.imageName).toBe("NativeFixture");
    }
  }, 120_000);

  it("resolves every instruction exactly like atos -i: names, file basenames, lines, inline order", async () => {
    const slices = await readSlices(dwarf);
    const built = await xcodeSymcacheBuilder.build(dwarf);
    for (const slice of slices) {
      if ("error" in slice) throw new Error(slice.error);
      const entry = built.find((b) => b.arch === slice.arch);
      if (!entry || "error" in entry) throw new Error(`no symcache for ${slice.arch}`);
      const sc = new MachoSymcache(entry.bytes);
      const addrs = instructionAddresses(binary, slice.arch);
      expect(addrs.length).toBeGreaterThan(50);
      const theirs = atos(dwarf, slice, addrs);
      const vmaddr = Number(slice.textVmaddr);
      const mismatches: string[] = [];
      let inlineChains = 0;
      addrs.forEach((addr, i) => {
        const expected = theirs[i]!;
        if (expected.length > 1) inlineChains++;
        const ours: Frame[] = sc.resolve(addr - vmaddr).map((f) => {
          const frame: Frame = { function: f.function };
          if (f.filename !== undefined) {
            frame.file = f.filename;
            frame.line = f.lineno ?? 0;
          }
          return frame;
        });
        if (JSON.stringify(ours) !== JSON.stringify(expected)) {
          mismatches.push(`${slice.arch} 0x${addr.toString(16)}\n  atos: ${JSON.stringify(expected)}\n  ours: ${JSON.stringify(ours)}`);
        }
      });
      expect(mismatches.slice(0, 10)).toEqual([]);
      expect(inlineChains).toBeGreaterThan(0);
    }
  }, 300_000);

  it("builds byte-identical symcaches twice", async () => {
    const a = await xcodeSymcacheBuilder.build(dwarf);
    const b = await xcodeSymcacheBuilder.build(dwarf);
    expect(a).toHaveLength(ARCHS.length);
    a.forEach((slice, i) => {
      const other = b[i]!;
      if ("error" in slice || "error" in other) throw new Error("build failed");
      expect(Buffer.from(slice.bytes).equals(Buffer.from(other.bytes))).toBe(true);
    });
  }, 120_000);

  it("uploads one symcache per slice end to end with the real builder", async () => {
    const s = await startServer();
    servers.push(s);
    const uuids = dwarfdumpUuids(dwarf);
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: "chrly_upload_native", COHORLY_API_URL: s.url });
    expect(await main(["debug-files", "upload", "--release", "native@1.0+1", dsym], io)).toBe(0);

    expect(s.requests.every((r) => r.pathname === "/api/symbols/symcache")).toBe(true);
    const received = s.requests.map((r) => ({ arch: r.query.arch!, debugId: r.query.debug_id!, sc: new MachoSymcache(new Uint8Array(r.body)) }));
    expect(received.map((r) => r.arch).sort()).toEqual([...ARCHS].sort());
    for (const r of received) {
      expect(r.debugId).toBe(uuids.get(r.arch));
      expect(r.sc.debugId).toBe(r.debugId);
      expect(s.requests.find((q) => q.query.arch === r.arch)!.query.release).toBe("native@1.0+1");
    }
  }, 120_000);
});
