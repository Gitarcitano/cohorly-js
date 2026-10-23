import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohorlyProvider, useFeatureFlag, useFeatureFlagPayload } from "../src/index.js";

// React's act() checks this flag in non-test-renderer environments.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const flagsResponse = {
  flags: {
    checkout: { enabled: true, variant: null, payload: null, reason: "rule:0" },
    banner: {
      enabled: true,
      variant: "blue",
      payload: { color: "#00f" },
      reason: "rule:0",
    },
  },
};

/** Deferred fetch stub so the test controls exactly when flags load. */
function stubDeferredFetch() {
  let resolveFlags!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveFlags = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => flagsResponse,
      };
    }),
  );
  return { resolveFlags };
}

function Probe({ flagKey }: { flagKey: string }) {
  const value = useFeatureFlag(flagKey);
  const payload = useFeatureFlagPayload(flagKey);
  return (
    <div
      data-testid="probe"
      data-value={JSON.stringify(value ?? "undefined")}
      data-payload={JSON.stringify(payload ?? "undefined")}
    />
  );
}

function readProbe(container: HTMLElement) {
  const el = container.querySelector("[data-testid=probe]")!;
  return {
    value: JSON.parse(el.getAttribute("data-value")!),
    payload: JSON.parse(el.getAttribute("data-payload")!),
  };
}

describe("useFeatureFlag / useFeatureFlagPayload", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(flagKey: string) {
    act(() => {
      root = createRoot(container);
      root.render(
        <CohorlyProvider apiHost="http://localhost:4000" token="tok-r">
          <Probe flagKey={flagKey} />
        </CohorlyProvider>,
      );
    });
  }

  it("is undefined until flags load, then updates with the flag value", async () => {
    const { resolveFlags } = stubDeferredFetch();
    render("banner");

    expect(readProbe(container)).toEqual({
      value: "undefined",
      payload: "undefined",
    });

    await act(async () => {
      resolveFlags();
      // let the reload promise + listener fire
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readProbe(container)).toEqual({
      value: "blue",
      payload: { color: "#00f" },
    });
  });

  it("boolean flags resolve to true, unknown flags to false with null payload", async () => {
    const { resolveFlags } = stubDeferredFetch();
    render("checkout");

    await act(async () => {
      resolveFlags();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readProbe(container)).toEqual({ value: true, payload: "undefined" });

    // Unknown flag: flags ARE loaded, so the hook reports false, not undefined.
    act(() => {
      root.render(
        <CohorlyProvider apiHost="http://localhost:4000" token="tok-r">
          <Probe flagKey="nope" />
        </CohorlyProvider>,
      );
    });
    expect(readProbe(container)).toEqual({ value: false, payload: "undefined" });
  });

  it("tracks exactly one exposure per flag value across re-renders", async () => {
    const { resolveFlags } = stubDeferredFetch();
    render("banner");

    await act(async () => {
      resolveFlags();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Force extra renders of the same hook: the client-side dedup set keeps
    // the exposure at one.
    act(() => {
      root.render(
        <CohorlyProvider apiHost="http://localhost:4000" token="tok-r">
          <Probe flagKey="banner" />
        </CohorlyProvider>,
      );
    });

    const queue = JSON.parse(
      window.localStorage.getItem("cohorly_queue") ?? "[]",
    ) as { event: string; properties: Record<string, unknown> }[];
    const fired = queue.filter((e) => e.event === "$feature_flag_called");
    expect(fired).toHaveLength(1);
    expect(fired[0].properties.$feature_flag).toBe("banner");
    expect(fired[0].properties.$feature_flag_response).toBe("blue");
  });

  it("returns to undefined during an identity switch instead of publishing fallbacks", async () => {
    // The first evaluation resolves; the post-identify reload stays pending
    // forever, so the cleared set must read as `undefined` (loading), not
    // the getter's fallback false.
    let resolveFlags!: () => void;
    const gate = new Promise<void>((r) => (resolveFlags = r));
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) await gate;
        else await new Promise(() => {});
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => flagsResponse,
        };
      }),
    );
    render("banner");
    await act(async () => {
      resolveFlags();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readProbe(container).value).toBe("blue");

    const { cohorly } = await import("@cohorly/web");
    await act(async () => {
      // identify() awaits its best-effort /alias, which the stub leaves
      // pending - fire it and assert the synchronous clear instead.
      void cohorly.identify("user-2");
      await Promise.resolve();
    });
    expect(readProbe(container)).toEqual({
      value: "undefined",
      payload: "undefined",
    });
  });
});
