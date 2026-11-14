import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildSdk, removeSdk } from "./build-sdk.js";

/**
 * captureUncaught decides how a real process ends, so it is tested on real
 * processes: a child runs the SDK (transpiled from src, see build-sdk.ts)
 * against a local HTTP server that records every POST /track. Each case gets
 * its own server, so what one case received never leaks into another.
 */

type Received = { event: string; properties: Record<string, any> };

/** No child may run longer than this; past it, it is killed and the case fails. */
const CHILD_DEADLINE_MS = 10000;

let dir: string;

/** State of the current case's server. */
let server: Server;
let baseUrl: string;
let received: Received[];
/** When true, /track requests are recorded and never answered. */
let hang: boolean;
const children = new Set<ChildProcess>();

const SCRIPT = `
import { CohorlyNode } from "./sdk/index.js";

const scenario = process.env.SCENARIO;
if (process.env.CAPTURE === "1") {
  new CohorlyNode("tok", {
    host: process.env.HOST,
    flushIntervalMs: 0,
    captureUncaught: true,
    flushTimeoutMs: Number(process.env.FLUSH_TIMEOUT_MS ?? 2000),
    serverName: "child",
  });
}

if (scenario === "rejection") {
  Promise.reject(new Error("rejected-boom"));
} else if (scenario === "rejection-string") {
  Promise.reject("boom");
} else if (scenario === "rejection-object") {
  Promise.reject({ code: "E_OBJ" });
} else if (scenario === "rejection-with-app-listener-error" || scenario === "rejection-with-app-listener-string") {
  process.on("uncaughtException", (error, origin) => {
    console.log("app:" + origin + ":" + error.code + ":" + (error instanceof Error));
  });
  Promise.reject(
    scenario.endsWith("string") ? "boom" : Object.assign(new Error("e"), { code: "E_X" }),
  );
  setTimeout(() => console.log("still-alive"), 500);
} else if (scenario === "uncaught") {
  setTimeout(() => {
    throw new Error("uncaught-boom");
  }, 0);
} else if (scenario === "uncaught-with-listener") {
  process.on("uncaughtException", (error) => {
    console.log("app-handled:" + error.message);
  });
  setTimeout(() => {
    throw new Error("handled-boom");
  }, 0);
  setTimeout(() => console.log("still-alive"), 500);
}
`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function run(env: Record<string, string>, nodeArgs: string[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [...nodeArgs, path.join(dir, "child.mjs")], {
      cwd: dir,
      env: { ...process.env, NODE_OPTIONS: "", HOST: baseUrl, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHILD_DEADLINE_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      children.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      children.delete(child);
      if (timedOut) {
        reject(
          new Error(
            `child ${JSON.stringify({ env, nodeArgs })} still running after ${CHILD_DEADLINE_MS}ms, killed with SIGKILL\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - start });
    });
  });
}

function exceptions(): Received[] {
  return received.filter((e) => e.event === "$exception");
}

beforeAll(() => {
  dir = buildSdk("uncaught");
  writeFileSync(path.join(dir, "child.mjs"), SCRIPT);
});

afterAll(() => {
  removeSdk(dir);
});

beforeEach(async () => {
  const caseReceived: Received[] = [];
  received = caseReceived;
  hang = false;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/track") {
        const parsed = JSON.parse(body);
        caseReceived.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        if (hang) return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/**
 * Every `--unhandled-rejections` mode, with the exit code Node itself gives
 * an unhandled `Promise.reject(new Error(...))` in that mode.
 */
const MODES = [
  { mode: "throw (default)", flags: [], nodeExitCode: 1 },
  { mode: "warn", flags: ["--unhandled-rejections=warn"], nodeExitCode: 0 },
  { mode: "none", flags: ["--unhandled-rejections=none"], nodeExitCode: 0 },
  {
    mode: "warn-with-error-code",
    flags: ["--unhandled-rejections=warn-with-error-code"],
    nodeExitCode: 1,
  },
  { mode: "strict", flags: ["--unhandled-rejections=strict"], nodeExitCode: 1 },
];

describe("unhandledRejection", { timeout: 30000 }, () => {
  it.each(MODES)(
    "$mode: sends one error event and exits like the same script without captureUncaught",
    async ({ flags, nodeExitCode }) => {
      const baseline = await run({ SCENARIO: "rejection", CAPTURE: "0" }, flags);
      expect(baseline.code).toBe(nodeExitCode);
      expect(received).toHaveLength(0);

      const result = await run({ SCENARIO: "rejection", CAPTURE: "1" }, flags);
      expect(result.code).toBe(baseline.code);
      expect(exceptions()).toHaveLength(1);
      const p = exceptions()[0].properties;
      expect(p.$exception_level).toBe("error");
      expect(p.$exception_list[0]).toMatchObject({
        value: "rejected-boom",
        mechanism: { type: "onunhandledrejection", handled: false },
      });
      expect(p.distinct_id).toBe("child");
    },
  );

  it("default mode still prints the error, not swallowing it", async () => {
    const result = await run({ SCENARIO: "rejection", CAPTURE: "1" });
    expect(result.stderr).toContain("rejected-boom");
  });

  it.each([
    { name: "strict, string reason", scenario: "rejection-string", flags: ["--unhandled-rejections=strict"], value: "boom" },
    { name: "strict, plain object reason", scenario: "rejection-object", flags: ["--unhandled-rejections=strict"], value: '{"code":"E_OBJ"}' },
    { name: "default mode, string reason", scenario: "rejection-string", flags: [], value: "boom" },
  ])(
    "$name: exactly one event, built from the original value and not Node's ERR_UNHANDLED_REJECTION wrapper",
    async ({ scenario, flags, value }) => {
      const baseline = await run({ SCENARIO: scenario, CAPTURE: "0" }, flags);
      const result = await run({ SCENARIO: scenario, CAPTURE: "1" }, flags);
      expect(result.code).toBe(baseline.code);
      expect(result.code).toBe(1);
      expect(exceptions()).toHaveLength(1);
      expect(exceptions()[0].properties.$exception_list[0]).toMatchObject({
        value,
        mechanism: { type: "onunhandledrejection", handled: false, synthetic: true },
      });
    },
  );

  it.each(MODES.filter((m) => m.mode !== "throw (default)" && m.mode !== "strict"))(
    "$mode: a server that never answers does not keep the process alive past flushTimeoutMs",
    async ({ flags, nodeExitCode }) => {
      hang = true;
      const flushTimeoutMs = 300;
      const baseline = await run({ SCENARIO: "rejection", CAPTURE: "0" }, flags);
      const result = await run(
        { SCENARIO: "rejection", CAPTURE: "1", FLUSH_TIMEOUT_MS: String(flushTimeoutMs) },
        flags,
      );
      expect(result.code).toBe(baseline.code);
      expect(result.code).toBe(nodeExitCode);
      expect(exceptions()).toHaveLength(1); // sent, just never acknowledged
      expect(result.elapsedMs).toBeLessThan(baseline.elapsedMs + flushTimeoutMs + 1500);
    },
  );

  it("default mode with a server that never answers waits one flushTimeoutMs, not two", async () => {
    hang = true;
    // Long enough that one deadline (+ slack) is clearly below two deadlines.
    const flushTimeoutMs = 800;
    const baseline = await run({ SCENARIO: "rejection", CAPTURE: "0" });
    const result = await run({
      SCENARIO: "rejection",
      CAPTURE: "1",
      FLUSH_TIMEOUT_MS: String(flushTimeoutMs),
    });
    expect(result.code).toBe(baseline.code);
    expect(result.code).toBe(1);
    expect(exceptions()).toHaveLength(1);
    // The baseline pays for process start-up; what is left is the wait.
    expect(result.elapsedMs - baseline.elapsedMs).toBeLessThan(flushTimeoutMs + 600);
  });
});

describe("uncaughtException", { timeout: 30000 }, () => {
  it("sends a fatal event and exits 1 like the baseline, still printing the error", async () => {
    const baseline = await run({ SCENARIO: "uncaught", CAPTURE: "0" });
    const result = await run({ SCENARIO: "uncaught", CAPTURE: "1" });
    expect(baseline.code).toBe(1);
    expect(result.code).toBe(baseline.code);
    expect(exceptions()).toHaveLength(1);
    const p = exceptions()[0].properties;
    expect(p.$exception_level).toBe("fatal");
    expect(p.$exception_list[0]).toMatchObject({
      value: "uncaught-boom",
      mechanism: { type: "onuncaughtexception", handled: false },
    });
    expect(result.stderr).toContain("uncaught-boom");
  });

  it.each([
    ["an Error", "rejection-with-app-listener-error", "app:unhandledRejection:E_X:true"],
    [
      "a string (Node's wrapper error)",
      "rejection-with-app-listener-string",
      "app:unhandledRejection:ERR_UNHANDLED_REJECTION:true",
    ],
  ])(
    "default mode: the app's own uncaughtException listener gets a rejection of %s as Node delivers it, origin included",
    async (_label, scenario, expected) => {
      const baseline = await run({ SCENARIO: scenario, CAPTURE: "0" });
      const result = await run({ SCENARIO: scenario, CAPTURE: "1" });
      expect(baseline.stdout).toContain(expected);
      expect(result.stdout).toContain(expected);
      expect(result.stdout).toContain("still-alive");
      expect(result.code).toBe(baseline.code);
      expect(exceptions()).toHaveLength(1);
    },
  );

  it("does not force an exit when the app has its own listener", async () => {
    const result = await run({ SCENARIO: "uncaught-with-listener", CAPTURE: "1" });
    expect(result.stdout).toContain("app-handled:handled-boom");
    expect(result.stdout).toContain("still-alive");
    expect(result.code).toBe(0);
    expect(exceptions()).toHaveLength(1);
  });

  it("exits within flushTimeoutMs when the server never answers", async () => {
    hang = true;
    const flushTimeoutMs = 300;
    const baseline = await run({ SCENARIO: "uncaught", CAPTURE: "0" });
    const result = await run({
      SCENARIO: "uncaught",
      CAPTURE: "1",
      FLUSH_TIMEOUT_MS: String(flushTimeoutMs),
    });
    expect(result.code).toBe(baseline.code);
    expect(exceptions()).toHaveLength(1); // it was sent, just never acknowledged
    expect(result.elapsedMs).toBeLessThan(baseline.elapsedMs + flushTimeoutMs + 1500);
  });
});
