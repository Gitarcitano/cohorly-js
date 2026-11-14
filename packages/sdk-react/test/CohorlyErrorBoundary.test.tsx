import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Breadcrumb, ExceptionListEntry, TrackedEvent } from "../src/index.js";
import { CohorlyErrorBoundary, CohorlyProvider } from "../src/index.js";

// React's act() checks this flag in non-test-renderer environments.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let shouldThrow = true;

function Checkout() {
  if (shouldThrow) throw new Error("render failed");
  return <p data-testid="content">checkout</p>;
}

/** React reports caught render errors to window in development; keep them out of the runner. */
const swallowWindowError = (event: Event) => event.preventDefault();

describe("CohorlyErrorBoundary", () => {
  let container: HTMLElement;
  let root: Root;
  let seen: TrackedEvent[];

  beforeEach(() => {
    window.localStorage.clear();
    shouldThrow = true;
    seen = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.addEventListener("error", swallowWindowError);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    window.removeEventListener("error", swallowWindowError);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(boundary: ReactNode) {
    act(() => {
      root = createRoot(container);
      root.render(
        <CohorlyProvider
          apiHost="http://localhost:4000"
          loadFeatureFlags={false}
          flushIntervalMs={0}
          beforeSendException={(evt) => {
            seen.push(evt);
            return evt;
          }}
        >
          {boundary}
        </CohorlyProvider>,
      );
    });
  }

  it("renders the fallback and captures the error with the component stack as a breadcrumb", () => {
    const onError = vi.fn();
    render(
      <CohorlyErrorBoundary
        fallback={({ error }) => <p data-testid="fallback">{(error as Error).message}</p>}
        onError={onError}
      >
        <Checkout />
      </CohorlyErrorBoundary>,
    );

    expect(container.querySelector("[data-testid=fallback]")?.textContent).toBe("render failed");
    expect(seen).toHaveLength(1);
    const props = seen[0].properties;
    const [entry] = props.$exception_list as ExceptionListEntry[];
    expect(entry).toMatchObject({
      type: "Error",
      value: "render failed",
      mechanism: { handled: true, type: "react.errorboundary", synthetic: false },
    });
    expect(props.$exception_level).toBe("error");

    const trail = props.$exception_breadcrumbs as Breadcrumb[];
    const stackCrumb = trail[trail.length - 1];
    expect(stackCrumb.category).toBe("react.component_stack");
    expect(stackCrumb.message).toContain("Checkout");
    expect(Object.keys(props).filter((key) => /component_?stack/i.test(key))).toEqual([]);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][1]).toContain("Checkout");
  });

  it("renders the children again after reset", () => {
    let reset: (() => void) | undefined;
    render(
      <CohorlyErrorBoundary
        fallback={(fallbackProps) => {
          reset = fallbackProps.reset;
          return <p data-testid="fallback">Something went wrong</p>;
        }}
      >
        <Checkout />
      </CohorlyErrorBoundary>,
    );
    expect(container.querySelector("[data-testid=fallback]")).not.toBeNull();

    shouldThrow = false;
    act(() => reset?.());
    expect(container.querySelector("[data-testid=content]")?.textContent).toBe("checkout");
  });

  it("accepts a ReactNode fallback", () => {
    render(
      <CohorlyErrorBoundary fallback={<p data-testid="fallback">Oops</p>}>
        <Checkout />
      </CohorlyErrorBoundary>,
    );
    expect(container.querySelector("[data-testid=fallback]")?.textContent).toBe("Oops");
    expect(seen).toHaveLength(1);
  });
});
