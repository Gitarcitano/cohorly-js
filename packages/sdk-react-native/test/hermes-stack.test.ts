import { describe, expect, it } from "vitest";
import {
  buildReactNativeExceptionList,
  parseHermesStack,
} from "../src/exceptions/hermes-stack.js";

// Stacks as Hermes / JavaScriptCore / Metro print them on a device, newest
// call first. Function names and offsets are from real release builds;
// paths and ids are anonymized.
const ANDROID_RELEASE = `TypeError: Cannot read property 'id' of undefined
    at renderItem (address at index.android.bundle:1:1045621)
    at anonymous (address at index.android.bundle:1:893412)
    at map (native)
    at CartScreen (address at index.android.bundle:1:1044987)
    at renderWithHooks (address at index.android.bundle:1:302851)
    ... skipping 3 frames
    at performUnitOfWork (address at index.android.bundle:1:356210)
    at workLoopSync (address at InternalBytecode.js:1:1205)`;

const ANDROID_OTA = `Error: Checkout failed
    at onPress (address at /data/user/0/com.example.shop/files/.expo-internal/7f3a2b9c-1d4e-4c55-9a0b-3e6f8d2c1b7a.hbc:1:384122)
    at _performTransitionSideEffects (address at /data/user/0/com.example.shop/files/.expo-internal/7f3a2b9c-1d4e-4c55-9a0b-3e6f8d2c1b7a.hbc:1:219870)`;

const IOS_RELEASE = `Error: Payment declined
    at submitPayment (address at /private/var/containers/Bundle/Application/4C1D2F0E-8A7B-4E3C-9F1A-2B3C4D5E6F70/Shop.app/main.jsbundle:1:742310)
    at next (native)
    at asyncGeneratorStep (address at /private/var/containers/Bundle/Application/4C1D2F0E-8A7B-4E3C-9F1A-2B3C4D5E6F70/Shop.app/main.jsbundle:1:120455)
    at Foo.bar (file.js:1:2)
    at callFunctionReturnFlushedQueue`;

const IOS_DEV_METRO = `Error: boom
    at onPress (http://localhost:8081/index.bundle?platform=ios&dev=true&minify=false&modulesOnly=false&runModule=true&app=com.example.shop:128344:22)
    at _performTransitionSideEffects (http://localhost:8081/index.bundle?platform=ios&dev=true&minify=false:41231:22)`;

const IOS_JSC = `submitPayment@main.jsbundle:1:742310
forEach@[native code]
global code@main.jsbundle:1:12
[native code]`;

const IOS_PATH = "/private/var/containers/Bundle/Application/4C1D2F0E-8A7B-4E3C-9F1A-2B3C4D5E6F70/Shop.app/main.jsbundle";

describe("parseHermesStack", () => {
  it("reads a Hermes release stack on Android, oldest call first, crashing frame last", () => {
    const frames = parseHermesStack(ANDROID_RELEASE, "Android");

    expect(frames.map((f) => f.function)).toEqual([
      "workLoopSync",
      "performUnitOfWork",
      "renderWithHooks",
      "CartScreen",
      "map",
      "anonymous",
      "renderItem",
    ]);
    expect(frames[frames.length - 1]).toEqual({
      platform: "javascript",
      filename: "index.android.bundle",
      abs_path: "index.android.bundle",
      function: "renderItem",
      lineno: 1,
      colno: 1045621,
      in_app: true,
    });
  });

  it("marks native frames as platform native, not in app, without a line", () => {
    const map = parseHermesStack(ANDROID_RELEASE, "Android").find((f) => f.function === "map");
    expect(map).toEqual({ platform: "native", function: "map", in_app: false });
  });

  it("never treats Hermes' InternalBytecode.js as the app bundle", () => {
    const [oldest] = parseHermesStack(ANDROID_RELEASE, "Android");
    expect(oldest.filename).toBe("InternalBytecode.js");
    expect(oldest.in_app).toBe(false);
  });

  it("names an OTA bundle (hashed file under .expo-internal) as the canonical bundle", () => {
    const frames = parseHermesStack(ANDROID_OTA, "Android");
    const crash = frames[frames.length - 1];
    expect(crash.filename).toBe("index.android.bundle");
    expect(crash.abs_path).toBe(
      "/data/user/0/com.example.shop/files/.expo-internal/7f3a2b9c-1d4e-4c55-9a0b-3e6f8d2c1b7a.hbc",
    );
    expect(crash.colno).toBe(384122);
    expect(crash.in_app).toBe(true);
  });

  it("uses main.jsbundle on iOS and keeps the device path in abs_path", () => {
    const frames = parseHermesStack(IOS_RELEASE, "iOS");
    const crash = frames[frames.length - 1];
    expect(crash).toMatchObject({
      filename: "main.jsbundle",
      abs_path: IOS_PATH,
      function: "submitPayment",
      lineno: 1,
      colno: 742310,
      in_app: true,
    });
    // `at Foo.bar (file.js:1:2)` is still app code, under the canonical name.
    expect(frames.find((f) => f.function === "Foo.bar")).toMatchObject({
      filename: "main.jsbundle",
      abs_path: "file.js",
      lineno: 1,
      colno: 2,
    });
    // A line without a location keeps the function and nothing it does not know.
    expect(frames[0]).toEqual({
      platform: "javascript",
      function: "callFunctionReturnFlushedQueue",
      in_app: false,
    });
  });

  it("keeps Metro dev-server URLs as they are", () => {
    const frames = parseHermesStack(IOS_DEV_METRO, "iOS");
    const crash = frames[frames.length - 1];
    const url =
      "http://localhost:8081/index.bundle?platform=ios&dev=true&minify=false&modulesOnly=false&runModule=true&app=com.example.shop";
    expect(crash).toMatchObject({
      filename: url,
      abs_path: url,
      function: "onPress",
      lineno: 128344,
      colno: 22,
      in_app: true,
    });
  });

  it("reads JavaScriptCore stacks", () => {
    const frames = parseHermesStack(IOS_JSC, "iOS");
    expect(frames.map((f) => [f.function, f.platform, f.filename])).toEqual([
      [undefined, "native", undefined],
      ["global code", "javascript", "main.jsbundle"],
      ["forEach", "native", undefined],
      ["submitPayment", "javascript", "main.jsbundle"],
    ]);
    expect(frames[3]).toMatchObject({ lineno: 1, colno: 742310, in_app: true });
  });

  it("leaves dependency frames out of the app", () => {
    const [frame] = parseHermesStack(
      "Error: x\n    at fn (address at /app/node_modules/lib/index.js:3:9)",
      "Android",
    );
    expect(frame).toMatchObject({
      filename: "/app/node_modules/lib/index.js",
      in_app: false,
    });
  });

  it("returns no frames for an empty, missing or non-string stack", () => {
    expect(parseHermesStack("", "Android")).toEqual([]);
    expect(parseHermesStack(undefined, "Android")).toEqual([]);
    expect(parseHermesStack(42, "iOS")).toEqual([]);
    expect(parseHermesStack("Error: no frames here", "iOS")).toEqual([]);
  });
});

describe("buildReactNativeExceptionList", () => {
  it("parses each link of the cause chain from its own stack", () => {
    const cause = new Error("socket closed");
    cause.stack = `Error: socket closed\n    at read (address at index.android.bundle:1:500)`;
    const error = new TypeError("Checkout failed", { cause });
    error.stack = ANDROID_OTA;

    const list = buildReactNativeExceptionList(error, { handled: false, type: "onerror" }, "Android");

    expect(list.map((e) => [e.type, e.value])).toEqual([
      ["TypeError", "Checkout failed"],
      ["Error", "socket closed"],
    ]);
    expect(list[0].mechanism).toEqual({ handled: false, type: "onerror", synthetic: false });
    expect(list[0].stacktrace?.frames.at(-1)?.function).toBe("onPress");
    expect(list[1].stacktrace?.frames).toEqual([
      expect.objectContaining({ function: "read", filename: "index.android.bundle", colno: 500 }),
    ]);
  });

  it("turns a thrown non-Error into a synthetic exception without frames", () => {
    const [entry] = buildReactNativeExceptionList("plain string", { handled: true, type: "generic" }, "iOS");
    expect(entry).toEqual({
      type: "Error",
      value: "plain string",
      mechanism: { handled: true, type: "generic", synthetic: true },
    });
  });
});
