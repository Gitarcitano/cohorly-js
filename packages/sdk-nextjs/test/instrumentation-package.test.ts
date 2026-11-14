import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

type Target = { types: string; default: string };

function sourceOf(distPath: string): string {
  return resolve(ROOT, distPath.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"));
}

describe("@cohorly/nextjs/instrumentation exports", () => {
  const entry = pkg.exports["./instrumentation"] as Record<string, Target | string>;

  it("sends edge-light, workerd and worker to the Edge build", () => {
    for (const condition of ["edge-light", "workerd", "worker"]) {
      expect(entry[condition]).toEqual({
        types: "./dist/instrumentation.edge.d.ts",
        default: "./dist/instrumentation.edge.js",
      });
    }
  });

  it("falls back to the Node build, after every Edge condition", () => {
    expect(entry.types).toBe("./dist/instrumentation.node.d.ts");
    expect(entry.default).toBe("./dist/instrumentation.node.js");
    const keys = Object.keys(entry);
    for (const condition of ["edge-light", "workerd", "worker"]) {
      expect(keys.indexOf(condition)).toBeLessThan(keys.indexOf("types"));
      expect(keys.indexOf(condition)).toBeLessThan(keys.indexOf("default"));
    }
  });

  it("points at entry files that exist in src", () => {
    expect(existsSync(sourceOf("./dist/instrumentation.edge.js"))).toBe(true);
    expect(existsSync(sourceOf("./dist/instrumentation.node.js"))).toBe(true);
    expect(existsSync(sourceOf(entry.default as string))).toBe(true);
  });

  it("does not publish the examples", () => {
    expect(pkg.files).not.toContain("examples");
  });
});
