import { describe, expect, it } from "vitest";
// The web SDK's own constructor, from source: the two SDKs must group a
// rejected promise as the same issue type.
import { rejectionList as webRejectionList } from "../../sdk-web/src/exceptions.js";
import { buildReactNativeRejectionList } from "../src/exceptions/hermes-stack.js";

describe("unhandled rejections are built the same on web and React Native", () => {
  it.each([
    ["a string", "network down"],
    ["an object", { code: "E_TIMEOUT" }],
    ["undefined", undefined],
  ])("a non-Error reason (%s) is an UnhandledRejection with the same value", (_label, reason) => {
    const [web] = webRejectionList(reason);
    const [native] = buildReactNativeRejectionList(reason, "iOS");

    expect(web.type).toBe("UnhandledRejection");
    expect(native.type).toBe("UnhandledRejection");
    expect(native.value).toBe(web.value);
    expect(native.mechanism).toEqual(web.mechanism);
    expect(native.mechanism).toEqual({
      type: "onunhandledrejection",
      handled: false,
      synthetic: true,
    });
  });

  it("an Error reason keeps its own type on both, with Hermes frames on React Native", () => {
    const reason = new TypeError("undefined is not a function");
    reason.stack =
      "TypeError: undefined is not a function\n    at loadCart (address at index.android.bundle:1:2345)";

    const [web] = webRejectionList(reason);
    const [native] = buildReactNativeRejectionList(reason, "Android");

    expect(web.type).toBe("TypeError");
    expect(native.type).toBe("TypeError");
    expect(native.value).toBe(web.value);
    expect(native.mechanism).toEqual({
      type: "onunhandledrejection",
      handled: false,
      synthetic: false,
    });
    expect(native.stacktrace?.frames.at(-1)).toMatchObject({
      function: "loadCart",
      filename: "index.android.bundle",
      lineno: 1,
      colno: 2345,
    });
  });
});
