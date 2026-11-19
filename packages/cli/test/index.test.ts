import { decodedMappings, originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { describe, expect, it } from "vitest";
import { buildIndex, IndexFormatError, lookup, parseIndex, serializeIndex } from "../src/index-format.js";
import { decodeSourceMap } from "../src/sourcemap.js";
import { fixtureMap, randomMap, SOURCES_CONTENT_MARKER } from "./helpers.js";

function probes(map: Record<string, unknown>): Array<[number, number]> {
  const decoded = decodedMappings(new TraceMap(map as never));
  const out: Array<[number, number]> = [];
  for (let l = 0; l < decoded.length + 3; l++) {
    const line = decoded[l] ?? [];
    out.push([l + 1, 0], [l + 1, 1], [l + 1, 100_000]);
    for (const seg of line) {
      out.push([l + 1, seg[0]]);
      if (seg[0] > 0) out.push([l + 1, seg[0] - 1]);
      out.push([l + 1, seg[0] + 1]);
    }
  }
  return out;
}

function expectEquivalent(map: Record<string, unknown>) {
  const tm = new TraceMap(map as never);
  const index = parseIndex(serializeIndex(buildIndex(decodeSourceMap(map))));
  const positions = probes(map);
  expect(positions.length).toBeGreaterThan(10);
  for (const [line, column] of positions) {
    expect({ at: [line, column], ...lookup(index, line, column) }).toEqual({
      at: [line, column],
      ...originalPositionFor(tm, { line, column }),
    });
  }
}

describe("source map index", () => {
  it("matches trace-mapping originalPositionFor on the fixture map", () => {
    const map = fixtureMap();
    expectEquivalent(map);

    const index = buildIndex(decodeSourceMap(map));
    expect(lookup(index, 1, 10)).toEqual({ source: "src/b.ts", line: 4, column: 4, name: null });
    expect(lookup(index, 1, 12)).toEqual({ source: "src/a.ts", line: 10, column: 9, name: "shadowed" });
    expect(lookup(index, 1, 6)).toEqual({ source: null, line: null, column: null, name: null });
    expect(lookup(index, 2, 3)).toEqual({ source: null, line: null, column: null, name: null });
    expect(lookup(index, 3, 2)).toEqual({ source: null, line: null, column: null, name: null });
    expect(lookup(index, 3, 9)).toEqual({ source: "src/a.ts", line: 3, column: 0, name: "main" });
    expect(lookup(index, 99, 0)).toEqual({ source: null, line: null, column: null, name: null });
  });

  it("matches trace-mapping on generated maps with repeated columns and empty lines", () => {
    for (const seed of [1, 7, 42, 1337]) expectEquivalent(randomMap(seed, 60));
  });

  it("round trips through the binary format", () => {
    const index = buildIndex(decodeSourceMap(randomMap(3, 40)));
    const bytes = serializeIndex(index);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("CSMI");
    expect(bytes[4]).toBe(1);
    const parsed = parseIndex(bytes);
    expect(parsed).toEqual(index);
    expect(serializeIndex(parsed)).toEqual(bytes);

    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    expect(parseIndex(shifted.subarray(1))).toEqual(index);
  });

  it("dedupes the file and function name tables", () => {
    const index = buildIndex(decodeSourceMap(fixtureMap()));
    expect(index.sourceTable).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(new Set(index.nameTable).size).toBe(index.nameTable.length);
  });

  it("rejects bytes that are not an index", () => {
    expect(() => parseIndex(new Uint8Array(8))).toThrow(IndexFormatError);
    const bytes = serializeIndex(buildIndex(decodeSourceMap(fixtureMap())));
    expect(() => parseIndex(bytes.subarray(0, bytes.length - 1))).toThrow(IndexFormatError);
    const wrongVersion = bytes.slice();
    wrongVersion[4] = 9;
    expect(() => parseIndex(wrongVersion)).toThrow(/version/);
  });

  it("matches trace-mapping on independent pseudo-random probes", () => {
    const map = randomMap(99, 80);
    const tm = new TraceMap(map as never);
    const index = buildIndex(decodeSourceMap(map));
    let state = 12345;
    const next = (max: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % max;
    };
    for (let i = 0; i < 2000; i++) {
      const line = 1 + next(90);
      const column = next(400);
      expect({ line, column, ...lookup(index, line, column) }).toEqual({
        line,
        column,
        ...originalPositionFor(tm, { line, column }),
      });
    }
  });

  it("refuses positions that do not fit in 32 bits instead of truncating them", () => {
    const tooBig = { sources: ["a.ts"], names: [], mappings: [[[2 ** 32, 0, 0, 0]]] };
    expect(() => buildIndex(tooBig)).toThrow(IndexFormatError);
    expect(() => buildIndex({ sources: ["a.ts"], names: [], mappings: [[[0, 0, -1, 0]]] })).toThrow(IndexFormatError);
    expect(() => buildIndex({ sources: ["a.ts"], names: [], mappings: [[[0, 0, 0, 0xffffffff]]] })).toThrow(IndexFormatError);
  });

  it("serializes to the exact bytes the contract documents", () => {
    const bytes = serializeIndex(
      buildIndex({
        sources: ["a.ts"],
        names: ["f"],
        mappings: [[[0, 0, 1, 2, 0], [5]], []],
      }),
    );
    const words = [
      "43534d49", "0100", "0000", "02000000", "02000000", "01000000", "01000000", "05000000", "00000000",
      "00000000", "02000000", "02000000",
      "00000000", "05000000",
      "00000000", "ffffffff",
      "01000000", "00000000",
      "02000000", "00000000",
      "00000000", "ffffffff",
      "00000000", "04000000", "05000000",
      "612e7473", "66",
    ];
    expect(Buffer.from(bytes).toString("hex")).toBe(words.join(""));
  });

  it("never carries sourcesContent", () => {
    const map = fixtureMap();
    expect(JSON.stringify(map)).toContain(SOURCES_CONTENT_MARKER);
    const bytes = serializeIndex(buildIndex(decodeSourceMap(map)));
    expect(Buffer.from(bytes).toString("latin1")).not.toContain(SOURCES_CONTENT_MARKER);
    expect(Buffer.from(bytes).toString("utf8")).not.toContain("export const x");
  });
});
