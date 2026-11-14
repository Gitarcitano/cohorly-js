import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExceptionListEntry, TrackedEvent } from "../src/index.js";
import { CohorlyErrorBoundary, CohorlyProvider } from "../src/index.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// A new Error object on every render: React 18 dev re-runs a failing render
// and retries it, so one bug reaches the SDK as several distinct objects.
// The message changes per test: the cross-source memory outlives init(), so two
// tests throwing the same error within a second would merge.
let message = "boom";
function Broken(): never {
  throw new Error(message);
}

describe("React 18 dev re-dispatch of a caught render error", () => {
  let container: HTMLElement;
  let root: Root;
  let seen: TrackedEvent[];
  let windowErrors: Error[];

  const onWindowError = (event: ErrorEvent) => {
    windowErrors.push(event.error);
    // Keeps jsdom from logging the (expected) uncaught error.
    event.preventDefault();
  };

  beforeEach(() => {
    window.localStorage.clear();
    seen = [];
    windowErrors = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.addEventListener("error", onWindowError);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    window.removeEventListener("error", onWindowError);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mount(captureExceptions: boolean | undefined) {
    act(() => {
      root = createRoot(container);
      root.render(
        <CohorlyProvider
          apiHost="http://localhost:4000"
          loadFeatureFlags={false}
          flushIntervalMs={0}
          captureExceptions={captureExceptions}
          beforeSendException={(evt) => {
            seen.push(evt);
            return evt;
          }}
        >
          <CohorlyErrorBoundary fallback={<p data-testid="fallback">Oops</p>}>
            <Broken />
          </CohorlyErrorBoundary>
        </CohorlyProvider>,
      );
    });
  }

  it("sends exactly one $exception for a render error the boundary caught", () => {
    message = "boom-with-capture";
    mount(true);

    expect(container.querySelector("[data-testid=fallback]")?.textContent).toBe("Oops");
    // The premise of the fix: React did hand the error to window.
    expect(windowErrors.length).toBeGreaterThan(0);

    expect(seen).toHaveLength(1);
    const [entry] = seen[0].properties.$exception_list as ExceptionListEntry[];
    expect(entry.value).toBe("boom-with-capture");
    // The global handler fires first, during render, so it is the one kept.
    expect(seen[0].properties.$exception_level).toBe("fatal");
    expect(entry.mechanism).toMatchObject({ handled: false, type: "onerror" });
  });

  it("sends exactly one $exception, from the boundary, without captureExceptions", () => {
    message = "boom-manual-only";
    mount(undefined);

    expect(container.querySelector("[data-testid=fallback]")?.textContent).toBe("Oops");
    expect(seen).toHaveLength(1);
    const [entry] = seen[0].properties.$exception_list as ExceptionListEntry[];
    expect(entry.mechanism).toMatchObject({ handled: true });
  });
});
