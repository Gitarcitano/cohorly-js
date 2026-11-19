import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsolePayload } from "../src/replay/console-record.js";
import { consoleRecorder, formatConsoleMessage } from "../src/replay/console-record.js";

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);

describe("formatConsoleMessage", () => {
  it("joins the arguments with a space: strings as they are, the rest through String()", () => {
    expect(formatConsoleMessage(["saved", 3, "items", true, null, undefined, 10n])).toBe(
      "saved 3 items true null undefined 10",
    );
  });

  it("writes an Error as `Name: message`, then its stack, without repeating a stack that already starts with it", () => {
    const v8 = new TypeError("cart is empty");
    v8.stack = "TypeError: cart is empty\n    at checkout (app.js:10:5)";
    expect(formatConsoleMessage([v8])).toBe("TypeError: cart is empty\n    at checkout (app.js:10:5)");

    const firefox = new Error("boom");
    firefox.stack = "checkout@https://shop.example/app.js:10:5\n";
    expect(formatConsoleMessage(["failed:", firefox])).toBe(
      "failed: Error: boom\ncheckout@https://shop.example/app.js:10:5\n",
    );

    const bare = new RangeError("no stack");
    bare.stack = undefined;
    expect(formatConsoleMessage([bare])).toBe("RangeError: no stack");
  });

  it("writes objects and arrays as JSON, a cycle as [Circular], a shared object twice", () => {
    const shared = { v: 1 };
    const node: Record<string, unknown> = { name: "root", list: [1, "two"] };
    node.self = node;
    node.a = shared;
    node.b = shared;
    expect(formatConsoleMessage([node])).toBe(
      '{"name":"root","list":[1,"two"],"self":"[Circular]","a":{"v":1},"b":{"v":1}}',
    );
    const ring: unknown[] = [1];
    ring.push(ring);
    expect(formatConsoleMessage([ring])).toBe('[1,"[Circular]"]');
  });

  it("stops at depth 4 with a fixed marker", () => {
    expect(formatConsoleMessage([{ l1: { l2: { l3: { l4: { l5: 1 } } } } }])).toBe(
      '{"l1":{"l2":{"l3":{"l4":"[Object]"}}}}',
    );
    expect(formatConsoleMessage([[[[[[1]]]]]])).toBe('[[[["[Array]"]]]]');
  });

  it("keeps 50 keys per object and 50 items per array, the rest replaced by a marker", () => {
    const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
    const parsed = JSON.parse(formatConsoleMessage([wide])) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(51);
    expect(parsed.k49).toBe(49);
    expect(parsed).not.toHaveProperty("k50");
    expect(parsed["..."]).toBe("[+10]");

    const long = JSON.parse(formatConsoleMessage([Array.from({ length: 55 }, (_, i) => i)])) as unknown[];
    expect(long).toHaveLength(51);
    expect(long[49]).toBe(49);
    expect(long[50]).toBe("[+5]");
  });

  it("never fails the line on a value that throws while being read", () => {
    const getter = {
      ok: 1,
      get bad() {
        throw new Error("getter");
      },
    };
    const toJSON = {
      toJSON() {
        throw new Error("toJSON");
      },
    };
    expect(formatConsoleMessage(["before", getter, toJSON, "after"])).toBe(
      'before {"ok":1,"bad":"[Unserializable]"} {"toJSON":"[Function]"} after',
    );
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("message getter");
      },
    });
    expect(formatConsoleMessage([hostile, "still here"])).toBe("[Unserializable] still here");
  });

  it("never calls a page's toJSON, so a secret cannot leave the key that marks it", () => {
    const user = {
      password: "hunter2-very-secret",
      toJSON() {
        return `pw ${this.password}`;
      },
    };
    const message = formatConsoleMessage([user]);
    expect(message).not.toContain("hunter2");
    expect(message).toBe('{"password":"[token]","toJSON":"[Function]"}');
  });

  it("scrubs a string inside an object before cutting it, and never keeps the start of a card", () => {
    const value = `${"jane.doe@example.com ".repeat(96)}${"x".repeat(18)} 4111111111111111`;
    const message = formatConsoleMessage([{ note: value }]);
    expect(message).not.toMatch(/4111/);
    expect(message).not.toContain("jane.doe");
    expect(formatConsoleMessage([`${"a ".repeat(1020)}x 4111111111111111`])).not.toMatch(/411/);
  });

  it("formats a long run with no @ in linear time", () => {
    const started = performance.now();
    for (let i = 0; i < 30; i++) formatConsoleMessage(["x".repeat(16_000)]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps the separator of empty arguments", () => {
    expect(formatConsoleMessage(["", "x", "", "y"])).toBe(" x  y");
  });

  it("bounds the text read from one huge object", () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "x".repeat(100_000)]));
    const message = formatConsoleMessage([wide]);
    expect(message.length).toBeLessThanOrEqual(2048);
    expect(message.slice(0, 20)).toBe(`{"k0":"${"x".repeat(13)}`);

  });

  it("uses a Date's ISO string", () => {
    expect(formatConsoleMessage([new Date(T0), { at: new Date(T0) }])).toBe(
      `2026-11-18T09:00:00.000Z {"at":"2026-11-18T09:00:00.000Z"}`,
    );
  });

  it("scrubs e-mails, tokens and JWTs from the text, and values under secret keys in objects", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl";
    expect(formatConsoleMessage([`signed in jane.doe@example.com with ${jwt}`, "GET /cb?token=s3cr3t"])).toBe(
      "signed in [email] with [token] GET /cb?token=[token]",
    );
    expect(
      formatConsoleMessage([
        "login",
        {
          email: "a@b.co",
          password: "hunter2",
          headers: { Authorization: "Bearer abc123" },
          apiKey: { nested: "k1" },
          card: "4111 1111 1111 1111",
        },
      ]),
    ).toBe(
      'login {"email":"[email]","password":"[token]","headers":{"Authorization":"[token]"},"apiKey":"[token]","card":"[card]"}',
    );
  });

  it("cuts at 2048 characters, after the scrub", () => {
    expect(formatConsoleMessage(["x".repeat(5000)])).toHaveLength(2048);
    // Cut first, the address would leak half; scrubbed first, it is gone whole.
    expect(formatConsoleMessage([`${"x".repeat(2040)} jane.doe@example.com`])).toBe(
      `${"x".repeat(2040)} [email]`,
    );
  });
});

describe("consoleRecorder", () => {
  let added: ConsolePayload[];
  let live: boolean;
  let session: string | null;
  const sink = {
    recording: () => live,
    session: () => session,
    add: (payload: ConsolePayload) => {
      added.push(payload);
    },
  };

  beforeEach(() => {
    added = [];
    live = true;
    session = "s1";
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the four levels as { level, message }", () => {
    const recorder = consoleRecorder(sink);
    recorder.line("log", ["a", 1]);
    recorder.line("info", ["b"]);
    recorder.line("warn", ["c"]);
    recorder.line("error", [new Error("d")]);
    expect(added.slice(0, 3)).toEqual([
      { level: "log", message: "a 1" },
      { level: "info", message: "b" },
      { level: "warn", message: "c" },
    ]);
    expect(added[3].level).toBe("error");
    expect(added[3].message.startsWith("Error: d")).toBe(true);
    expect(Object.keys(added[3]).sort()).toEqual(["level", "message"]);
  });

  it("never writes the SDK's own [cohorly] messages; only a first argument starting with it counts", () => {
    const recorder = consoleRecorder(sink);
    recorder.line("warn", ["[cohorly] dropping a repeated exception"]);
    recorder.line("warn", ["[cohorly]", "session replay could not load"]);
    recorder.line("log", ["see [cohorly]"]);
    expect(added).toEqual([{ level: "log", message: "see [cohorly]" }]);
  });

  it("does not write a console call made while it writes a line", () => {
    const recorder = consoleRecorder({
      recording: () => true,
      add: (payload) => {
        added.push(payload);
        recorder.line("warn", ["from inside rrweb"]);
      },
    });
    recorder.line("log", ["outer"]);
    expect(added).toEqual([{ level: "log", message: "outer" }]);
  });

  it("never throws when writing fails", () => {
    const recorder = consoleRecorder({
      recording: () => true,
      add: () => {
        throw new Error("rrweb is not recording");
      },
    });
    expect(() => recorder.line("log", ["x"])).not.toThrow();
  });

  it("drops a line when nothing records, without keeping or counting it", () => {
    const recorder = consoleRecorder(sink);
    live = false;
    for (let i = 0; i < 600; i++) recorder.line("log", [`idle ${i}`]);
    live = true;
    for (let i = 0; i < 500; i++) recorder.line("log", [`live ${i}`]);
    expect(added).toHaveLength(500);
    expect(added[0]).toEqual({ level: "log", message: "live 0" });
    vi.advanceTimersByTime(60_000);
    expect(added).toHaveLength(500);
  });

  it("drops the 501st line of a 60 s window and writes one dropped line when the window closes", () => {
    const recorder = consoleRecorder(sink);
    for (let i = 0; i < 500; i++) recorder.line("log", [`line ${i}`]);
    vi.advanceTimersByTime(10_000);
    recorder.line("error", ["dropped 1"]);
    vi.advanceTimersByTime(5_000);
    recorder.line("log", ["dropped 2"]);
    recorder.line("log", ["dropped 3"]);
    expect(added).toHaveLength(500);
    expect(added.at(-1)).toEqual({ level: "log", message: "line 499" });

    vi.advanceTimersByTime(44_999);
    expect(added).toHaveLength(500);
    vi.advanceTimersByTime(1);
    expect(added).toHaveLength(501);
    expect(added[500]).toEqual({ level: "warn", message: "", dropped: 3, at: T0 + 10_000 });

    // The dropped line does not count: the next window takes 500 lines again.
    for (let i = 0; i < 501; i++) recorder.line("log", [`next ${i}`]);
    expect(added).toHaveLength(1001);
    expect(added.at(-1)).toEqual({ level: "log", message: "next 499" });
    vi.advanceTimersByTime(60_000);
    expect(added.at(-1)).toEqual({ level: "warn", message: "", dropped: 1, at: T0 + 60_000 });
  });

  it("counts every level in one window; a window without drops writes nothing when it ends", () => {
    const recorder = consoleRecorder(sink);
    for (let i = 0; i < 300; i++) recorder.line("log", [`a ${i}`]);
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 200; i++) recorder.line("warn", [`b ${i}`]);
    recorder.line("warn", ["over"]);
    expect(added).toHaveLength(500);
    vi.advanceTimersByTime(30_000);
    expect(added.at(-1)).toMatchObject({ dropped: 1, at: T0 + 30_000 });

    vi.advanceTimersByTime(120_000);
    recorder.line("log", ["later"]);
    vi.advanceTimersByTime(60_000);
    expect(added.at(-1)).toEqual({ level: "log", message: "later" });
  });

  it("does not keep the dropped line when nothing records as the window closes", () => {
    const recorder = consoleRecorder(sink);
    for (let i = 0; i < 502; i++) recorder.line("log", [`${i}`]);
    live = false;
    vi.advanceTimersByTime(60_000);
    live = true;
    vi.advanceTimersByTime(60_000);
    expect(added).toHaveLength(500);
    expect(added.some((p) => "dropped" in p)).toBe(false);
  });

  it("stop() ends the window timer and ignores later lines", () => {
    const recorder = consoleRecorder(sink);
    for (let i = 0; i < 501; i++) recorder.line("log", [`${i}`]);
    recorder.stop();
    recorder.line("log", ["after stop"]);
    vi.advanceTimersByTime(60_000);
    expect(added).toHaveLength(500);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("writes the dropped line only into the session that dropped the lines", () => {
    const recorder = consoleRecorder(sink);
    for (let i = 0; i < 502; i++) recorder.line("log", [`line ${i}`]);
    session = "s2";
    vi.advanceTimersByTime(60_000);
    expect(added).toHaveLength(500);
  });

  it("flush writes the pending dropped line at once (recorder stop, page hide), then the window goes on", () => {
    const recorder = consoleRecorder(sink);
    for (let i = 0; i < 503; i++) recorder.line("log", [`line ${i}`]);
    vi.advanceTimersByTime(1_000);
    recorder.flush();
    expect(added.at(-1)).toEqual({ level: "warn", message: "", dropped: 3, at: T0 });
    recorder.flush();
    expect(added).toHaveLength(501);
    recorder.line("log", ["still over"]);
    vi.advanceTimersByTime(59_000);
    expect(added.at(-1)).toEqual({ level: "warn", message: "", dropped: 1, at: T0 + 1_000 });
    expect(added).toHaveLength(502);
  });
});
