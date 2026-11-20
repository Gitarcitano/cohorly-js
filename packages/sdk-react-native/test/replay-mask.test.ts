import { Fragment, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeModuleBag } from "../src/deviceInfo.js";

const native = vi.hoisted(() => ({ bag: {} as Record<string, unknown> }));
vi.mock("../src/deviceInfo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deviceInfo.js")>();
  return { ...actual, loadNativeModules: () => native.bag as NativeModuleBag };
});

function View() {
  return null;
}

afterEach(() => {
  native.bag = {};
});

describe("<CohorlyMask>", () => {
  it("is a View carrying the no-capture marker, with every other prop of the app, and nothing else added", async () => {
    native.bag = { rn: { View } };
    vi.resetModules();
    const { CohorlyMask } = await import("../src/replay/mask.js");
    const index = await import("../src/index.js");
    expect(index.CohorlyMask).toBe(CohorlyMask);

    const style = { flex: 1 };
    const bare = CohorlyMask({ style, children: "card number" }) as ReactElement<Record<string, unknown>>;
    expect(bare.type).toBe(View);
    expect(bare.props).toEqual({
      style,
      children: "card number",
      testID: "cohorly-no-capture",
      collapsable: false,
    });

    // The app's own testID (typed out, passed anyway) never replaces the marker.
    const forced = CohorlyMask({ testID: "app", accessibilityLabel: "Card", children: null } as any) as ReactElement<
      Record<string, unknown>
    >;
    expect(forced.props.testID).toBe("cohorly-no-capture");
    expect(forced.props.accessibilityLabel).toBe("Card");
    expect(forced.props.collapsable).toBe(false);
  });

  it("renders its children as they are without react-native", async () => {
    native.bag = {};
    vi.resetModules();
    const { CohorlyMask } = await import("../src/replay/mask.js");
    const element = CohorlyMask({ children: "text" }) as ReactElement<{ children: unknown }>;
    expect(element.type).toBe(Fragment);
    expect(element.props.children).toBe("text");
  });
});
