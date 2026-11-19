import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { debugIdFor, injectDebugId, injectDebugIdComment, readDebugIdComment } from "../src/debug-id.js";
import { makeIo, tempDir, writeFiles } from "./helpers.js";

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUNDLE = 'console.log("hi");\n//# sourceMappingURL=app.js.map\n';
const MAP = JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" });

describe("debug ids", () => {
  it("are a deterministic UUID v5 of the bundle content", () => {
    const id = debugIdFor(BUNDLE);
    expect(id).toMatch(UUID_V5);
    expect(debugIdFor(BUNDLE)).toBe(id);
    expect(debugIdFor(Buffer.from(BUNDLE))).toBe(id);
    expect(debugIdFor(`${BUNDLE} `)).not.toBe(id);
  });

  it("changes when only the source map changes, and ignores its own debugId field", () => {
    const id = debugIdFor(BUNDLE, MAP);
    expect(id).toMatch(UUID_V5);
    expect(debugIdFor(BUNDLE, MAP)).toBe(id);
    expect(id).not.toBe(debugIdFor(BUNDLE));
    const shifted = JSON.stringify({ ...JSON.parse(MAP), mappings: "AACA" });
    expect(debugIdFor(BUNDLE, shifted)).not.toBe(id);
    expect(debugIdFor(BUNDLE, JSON.stringify({ ...JSON.parse(MAP), debugId: id }))).toBe(id);
  });

  it("goes right before the sourceMappingURL comment, or at the end without one", () => {
    expect(injectDebugIdComment(BUNDLE, "x")).toBe('console.log("hi");\n//# debugId=x\n//# sourceMappingURL=app.js.map\n');
    expect(injectDebugIdComment("a()", "x")).toBe("a()\n//# debugId=x\n");
    expect(injectDebugIdComment("a()\n", "x")).toBe("a()\n//# debugId=x\n");
  });

  it("never shifts code that follows a sourceMappingURL comment", () => {
    const withTail = "a();\n//# sourceMappingURL=a.js.map\nb();\n";
    expect(injectDebugIdComment(withTail, "x")).toBe(`${withTail}//# debugId=x\n`);
    const trailing = "a();\n//# sourceMappingURL=a.js.map\n\n";
    expect(injectDebugIdComment(trailing, "x")).toBe("a();\n//# debugId=x\n//# sourceMappingURL=a.js.map\n\n");
  });

  it("writes debugId into the map and changes nothing on a second run", () => {
    const first = injectDebugId(BUNDLE, MAP);
    expect(first.source).not.toBeNull();
    expect(readDebugIdComment(first.source!)).toBe(first.debugId);
    expect(JSON.parse(first.map!).debugId).toBe(first.debugId);

    const second = injectDebugId(first.source!, first.map!);
    expect(second).toEqual({ debugId: first.debugId, source: null, map: null });
  });

  it("injects every bundle with a sibling map through the CLI, idempotently", async () => {
    const dir = await tempDir();
    await writeFiles(dir, {
      "app.js": BUNDLE,
      "app.js.map": MAP,
      "chunks/lazy.mjs": "export const a = 1;",
      "chunks/lazy.mjs.map": MAP,
      "no-map.js": "x()",
      "styles.css": "a{}",
      "styles.css.map": MAP,
    });
    const { io, out } = makeIo({});
    expect(await main(["sourcemaps", "inject", dir], io)).toBe(0);
    expect(out.stdout).toContain("2 injected");

    const app = await readFile(path.join(dir, "app.js"), "utf8");
    const id = debugIdFor(BUNDLE, MAP);
    expect(app).toBe(`console.log("hi");\n//# debugId=${id}\n//# sourceMappingURL=app.js.map\n`);
    expect(JSON.parse(await readFile(path.join(dir, "app.js.map"), "utf8")).debugId).toBe(id);
    expect(await readFile(path.join(dir, "no-map.js"), "utf8")).toBe("x()");
    expect(await readFile(path.join(dir, "styles.css"), "utf8")).toBe("a{}");

    const snapshot = {
      app,
      map: await readFile(path.join(dir, "app.js.map"), "utf8"),
      lazy: await readFile(path.join(dir, "chunks/lazy.mjs"), "utf8"),
    };
    const again = makeIo({});
    expect(await main(["sourcemaps", "inject", dir], again.io)).toBe(0);
    expect(again.out.stdout).toContain("0 injected, 2 already had a debug id");
    expect({
      app: await readFile(path.join(dir, "app.js"), "utf8"),
      map: await readFile(path.join(dir, "app.js.map"), "utf8"),
      lazy: await readFile(path.join(dir, "chunks/lazy.mjs"), "utf8"),
    }).toEqual(snapshot);
  });
});
