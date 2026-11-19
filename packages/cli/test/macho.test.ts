import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSlices } from "../src/symcache/macho.js";

// A fat file with one watchOS arm64_32 slice (32-bit Mach-O, cputype ARM64_32).
function fatArm64_32(): Buffer {
  const fat = Buffer.alloc(8 + 20);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(0x0200000c, 8);
  fat.writeUInt32BE(1, 12);
  fat.writeUInt32BE(64, 16);
  fat.writeUInt32BE(32, 20);
  const slice = Buffer.alloc(32);
  slice.writeUInt32LE(0xfeedface, 0);
  slice.writeUInt32LE(0x0200000c, 4);
  slice.writeUInt32LE(1, 8);
  return Buffer.concat([fat, Buffer.alloc(64 - fat.length), slice]);
}

describe("readSlices", () => {
  it("marks a watchOS arm64_32 slice unsupported, so uploads skip it instead of failing", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "cohorly-macho-")), "Watch");
    await writeFile(file, fatArm64_32());
    expect(await readSlices(file)).toEqual([
      { arch: "arm64_32", unsupported: true, error: "arm64_32: 32-bit Mach-O slices are not supported (symcache v1 targets arm64 and x86_64)" },
    ]);
  });
});
