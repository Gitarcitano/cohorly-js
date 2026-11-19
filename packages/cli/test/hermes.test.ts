import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { describe, expect, it } from "vitest";
import { buildIndex, lookup } from "../src/index-format.js";
import { composeHermes } from "../src/sourcemap.js";
import { hermesPair } from "./helpers.js";

describe("Hermes composition", () => {
  it("resolves a .hbc position to the original source through the packager map", () => {
    const { packager, hermes } = hermesPair();
    const composed = composeHermes(packager, hermes);
    const index = buildIndex(composed);

    expect(lookup(index, 1, 100)).toEqual({ source: "src/App.tsx", line: 10, column: 2, name: "onPress" });
    expect(lookup(index, 1, 150)).toEqual({ source: "src/App.tsx", line: 10, column: 2, name: "onPress" });
    expect(lookup(index, 1, 200)).toEqual({ source: "src/App.tsx", line: 20, column: 4, name: "render" });
    expect(lookup(index, 1, 99)).toEqual({ source: null, line: null, column: null, name: null });
  });

  it("keeps unresolved hermes segments as no-source boundaries instead of inheriting the previous one", () => {
    const { packager, hermes } = hermesPair();
    const composed = composeHermes(packager, hermes);
    expect(composed.mappings[0]!.map((s) => [s[0], s.length])).toEqual([
      [100, 5],
      [200, 5],
      [300, 1],
      [400, 1],
    ]);
    expect(composed.sources).toEqual(["src/App.tsx"]);
    expect(composed.names).toEqual(["onPress", "render"]);

    const index = buildIndex(composed);
    const none = { source: null, line: null, column: null, name: null };
    expect(lookup(index, 1, 300)).toEqual(none);
    expect(lookup(index, 1, 350)).toEqual(none);
    expect(lookup(index, 1, 400)).toEqual(none);
  });

  it("answers like chained queries on the two maps at every probe", () => {
    const { packager, hermes } = hermesPair();
    const index = buildIndex(composeHermes(packager, hermes));
    const outer = new TraceMap(hermes as never);
    const inner = new TraceMap(packager as never);
    for (let column = 0; column < 450; column += 7) {
      const mid = originalPositionFor(outer, { line: 1, column });
      const expected =
        mid.line === null || mid.column === null
          ? { source: null, line: null, column: null, name: null }
          : originalPositionFor(inner, { line: mid.line, column: mid.column });
      expect({ column, ...lookup(index, 1, column) }).toEqual({ column, ...expected });
    }
  });
});
