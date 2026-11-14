import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSdk, removeSdk, transpileWithSourceMap } from "./build-sdk.js";

/**
 * The SDK never symbolicates: with `node --enable-source-maps` the process's
 * own Error.stack already points at the .ts source, and the SDK only passes
 * it on. The type-only lines at the top of the fixture vanish from the .js,
 * so the .ts and .js line of the throw differ and the assertion proves the
 * mapping happened.
 */
const FIXTURE_TS = `import { CohorlyNode } from "./sdk/index.js";

interface Order {
  id: string;
  total: number;
}

type Validator = (order: Order) => void;

const validate: Validator = (order: Order): void => {
  throw new Error(\`invalid order \${order.id}\`);
};

const cohorly = new CohorlyNode("tok", {
  flushIntervalMs: 0,
  transport: async () => undefined,
  projectRoot: process.cwd(),
});

try {
  validate({ id: "o-1", total: 10 });
} catch (error) {
  process.stdout.write(JSON.stringify(cohorly.captureException(error)));
}
`;

let dir: string;
let tsLine: number;
let jsLine: number;

function lineOf(source: string, needle: string): number {
  return source.split("\n").findIndex((line) => line.includes(needle)) + 1;
}

/** Runs the fixture and returns the crashing frame of the captured exception. */
function crashingFrame(nodeArgs: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [...nodeArgs, "fixture.js"], {
    cwd: dir,
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const event = JSON.parse(result.stdout);
  const frames = event.properties.$exception_list[0].stacktrace.frames;
  return frames[frames.length - 1];
}

beforeAll(() => {
  dir = buildSdk("source-maps");
  const js = transpileWithSourceMap(FIXTURE_TS, "fixture.ts");
  writeFileSync(path.join(dir, "fixture.ts"), FIXTURE_TS);
  writeFileSync(path.join(dir, "fixture.js"), js);
  tsLine = lineOf(FIXTURE_TS, "throw new Error");
  jsLine = lineOf(js, "throw new Error");
});

afterAll(() => {
  removeSdk(dir);
});

describe("source maps", { timeout: 20000 }, () => {
  it("the fixture's .ts and .js lines differ, so the test can tell them apart", () => {
    expect(tsLine).toBeGreaterThan(0);
    expect(jsLine).toBeGreaterThan(0);
    expect(tsLine).not.toBe(jsLine);
  });

  it("with --enable-source-maps the frame has the .ts file and line", () => {
    const frame = crashingFrame(["--enable-source-maps"]);
    expect(frame.filename).toBe("fixture.ts");
    expect(frame.abs_path).toBe("fixture.ts");
    expect(frame.lineno).toBe(tsLine);
    expect(frame.in_app).toBe(true);
  });

  it("without the flag the frame has the generated .js file and line", () => {
    const frame = crashingFrame([]);
    expect(frame.filename).toBe("fixture.js");
    expect(frame.lineno).toBe(jsLine);
  });
});
