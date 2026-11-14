import { describe, expect, it } from "vitest";
import { isInAppFilename, MAX_STACK_FRAMES, parseStackTrace } from "./stack-parser.js";

type FrameSummary = {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
};

function summarize(stack: string): FrameSummary[] {
  return parseStackTrace(stack).map((frame) => ({
    function: frame.function,
    filename: frame.filename,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  }));
}

const APP = "https://cdn.example.com/assets/app.b71e04.js";
const VENDOR = "https://cdn.example.com/assets/vendor.3f9a1c.js";

describe("parseStackTrace - Chrome / V8", () => {
  it("parses a minified production stack, oldest call first", () => {
    const stack = `TypeError: Cannot read properties of undefined (reading 'id')
    at e.submit (${APP}:1:90412)
    at Nt (${APP}:1:90337)
    at dispatch (${VENDOR}:1:48211)`;
    expect(summarize(stack)).toEqual([
      { function: "dispatch", filename: VENDOR, lineno: 1, colno: 48211, in_app: true },
      { function: "Nt", filename: APP, lineno: 1, colno: 90337, in_app: true },
      { function: "e.submit", filename: APP, lineno: 1, colno: 90412, in_app: true },
    ]);
  });

  it("handles anonymous, native, async, eval, constructor and extension frames", () => {
    const main = "http://localhost:3000/static/js/main.chunk.js";
    const stack = `Error: boom
  a second message line that mentions 1.js
    at new Checkout (${main}:120:15)
    at ${main}:88:3
    at Array.map (<anonymous>)
    at async Promise.all (index 0)
    at async loadCart (http://localhost:3000/src/cart.ts:14:5)
    at eval (eval at <anonymous> (${main}:5:3), <anonymous>:1:1)
    at Object.fn [as handler] (http://localhost:3000/node_modules/lib/index.js:7:11)
    at chrome-extension://abcdef/content.js:2:9
    at ClipperError@safari-extension:(//3284871F-A480/2665fee0/commons.js:223036:10)`;
    expect(summarize(stack)).toEqual([
      {
        function: "ClipperError",
        filename: "safari-extension://3284871F-A480/2665fee0/commons.js",
        lineno: 223036,
        colno: 10,
        in_app: false,
      },
      { filename: "chrome-extension://abcdef/content.js", lineno: 2, colno: 9, in_app: false },
      {
        function: "Object.fn [as handler]",
        filename: "http://localhost:3000/node_modules/lib/index.js",
        lineno: 7,
        colno: 11,
        in_app: false,
      },
      { function: "eval", filename: main, lineno: 5, colno: 3, in_app: true },
      {
        function: "loadCart",
        filename: "http://localhost:3000/src/cart.ts",
        lineno: 14,
        colno: 5,
        in_app: true,
      },
      { function: "Promise.all", filename: "index 0", in_app: false },
      { function: "Array.map", filename: "<anonymous>", in_app: false },
      { filename: main, lineno: 88, colno: 3, in_app: true },
      { function: "new Checkout", filename: main, lineno: 120, colno: 15, in_app: true },
    ]);
  });

  it("puts the throwing function last for a real V8 error", () => {
    function throwsHere(): Error {
      return new Error("real");
    }
    const frames = parseStackTrace(throwsHere().stack);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[frames.length - 1].function).toBe("throwsHere");
  });
});

describe("parseStackTrace - Firefox / Gecko", () => {
  it("parses a minified production stack, oldest call first", () => {
    const stack = `e.submit@${APP}:1:90412
Nt@${APP}:1:90337
dispatch@${VENDOR}:1:48211
`;
    expect(summarize(stack)).toEqual([
      { function: "dispatch", filename: VENDOR, lineno: 1, colno: 48211, in_app: true },
      { function: "Nt", filename: APP, lineno: 1, colno: 90337, in_app: true },
      { function: "e.submit", filename: APP, lineno: 1, colno: 90412, in_app: true },
    ]);
  });

  it("handles async, anonymous, eval and extension frames", () => {
    const stack = `async*loadCart@http://localhost:3000/src/cart.js:14:5
@http://localhost:3000/main.js:3:1
foo@http://localhost:3000/x.js line 5 > eval:1:1
bar@moz-extension://9f2a/content.js:4:2
`;
    expect(summarize(stack)).toEqual([
      { function: "bar", filename: "moz-extension://9f2a/content.js", lineno: 4, colno: 2, in_app: false },
      { function: "foo", filename: "http://localhost:3000/x.js", lineno: 5, in_app: true },
      { filename: "http://localhost:3000/main.js", lineno: 3, colno: 1, in_app: true },
      { function: "loadCart", filename: "http://localhost:3000/src/cart.js", lineno: 14, colno: 5, in_app: true },
    ]);
  });
});

describe("parseStackTrace - Safari / JavaScriptCore", () => {
  it("parses named, native-code and global-code frames, oldest call first", () => {
    const stack = `submit@${APP}:1:90412
Nt@${APP}:1:90337
map@[native code]
global code@https://app.example.com/checkout:12:3
[native code]`;
    expect(summarize(stack)).toEqual([
      { filename: "[native code]", in_app: false },
      { function: "global code", filename: "https://app.example.com/checkout", lineno: 12, colno: 3, in_app: true },
      { function: "map", filename: "[native code]", in_app: false },
      { function: "Nt", filename: APP, lineno: 1, colno: 90337, in_app: true },
      { function: "submit", filename: APP, lineno: 1, colno: 90412, in_app: true },
    ]);
  });
});

describe("parseStackTrace - limits", () => {
  it("returns no frames for a missing or empty stack", () => {
    expect(parseStackTrace(undefined)).toEqual([]);
    expect(parseStackTrace("")).toEqual([]);
    expect(parseStackTrace("Error: no frames at all")).toEqual([]);
  });

  it("keeps the crashing end when the stack has more than the frame cap", () => {
    const lines = Array.from(
      { length: MAX_STACK_FRAMES + 20 },
      (_, i) => `    at fn${i} (${APP}:1:${i + 1})`,
    );
    const frames = parseStackTrace(`Error: deep\n${lines.join("\n")}`);
    expect(frames).toHaveLength(MAX_STACK_FRAMES);
    expect(frames[frames.length - 1].function).toBe("fn0");
    expect(frames[0].function).toBe(`fn${MAX_STACK_FRAMES - 1}`);
  });
});

describe("isInAppFilename", () => {
  it("is false for dependencies, extensions and frames without a real file", () => {
    for (const filename of [
      "https://example.com/node_modules/react-dom/index.js",
      "chrome-extension://abc/x.js",
      "moz-extension://abc/x.js",
      "safari-extension://abc/x.js",
      "safari-web-extension://abc/x.js",
      "<anonymous>",
      "[native code]",
      "native",
      undefined,
    ]) {
      expect(isInAppFilename(filename)).toBe(false);
    }
    expect(isInAppFilename(APP)).toBe(true);
  });
});
