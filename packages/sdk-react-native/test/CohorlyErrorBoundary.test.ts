import type { ErrorInfo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CohorlyErrorBoundary,
  type CohorlyErrorBoundaryProps,
  init,
} from "../src/index.js";
import { createFakeFetch, FakeStorage, requestsTo } from "./helpers.js";

// No renderer in a node environment: drive the lifecycle the way React does
// after a render error (getDerivedStateFromError, componentDidCatch, render).
function crash(props: CohorlyErrorBoundaryProps, error: unknown, componentStack?: string) {
  const boundary = new CohorlyErrorBoundary(props);
  boundary.setState = (update) => {
    boundary.state = { ...boundary.state, ...(update as object) };
  };
  boundary.state = CohorlyErrorBoundary.getDerivedStateFromError(error);
  boundary.componentDidCatch(error, { componentStack } as ErrorInfo);
  return boundary;
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("CohorlyErrorBoundary", () => {
  // Runs first, while the module has no shared client yet.
  it("renders the fallback node without init() and still calls onError", () => {
    const onError = vi.fn();
    const error = new Error("no client");
    const boundary = crash({ fallback: "Something went wrong", onError }, error, "\n    in Cart");

    expect(boundary.render()).toBe("Something went wrong");
    expect(onError).toHaveBeenCalledWith(error, "\n    in Cart");
  });

  it("captures through the React Native client with the component stack as a breadcrumb", async () => {
    const { fetchImpl, requests } = createFakeFetch();
    const client = init({
      apiHost: "http://localhost:4000",
      storage: new FakeStorage(),
      fetch: fetchImpl,
      loadFeatureFlags: false,
      platformInfo: { os: "iOS" },
    });
    stops.push(() => client.stop());
    await client.exceptionsReady;
    const onError = vi.fn();
    const error = new TypeError("undefined is not an object");
    const componentStack = "\n    in PriceTag\n    in CartScreen\n    in App";

    crash({ onError }, error, componentStack);

    await vi.waitFor(() => expect(requestsTo(requests, "/track")).toHaveLength(1));
    const [event] = requestsTo(requests, "/track")[0].body as Array<{
      event: string;
      properties: Record<string, unknown>;
    }>;
    expect(event.event).toBe("$exception");
    expect(event.properties.$exception_level).toBe("error");
    expect(event.properties.$exception_list).toEqual([
      expect.objectContaining({
        type: "TypeError",
        value: "undefined is not an object",
        mechanism: { type: "react.errorboundary", handled: true, synthetic: false },
      }),
    ]);
    expect(event.properties.$exception_breadcrumbs).toEqual([
      expect.objectContaining({
        category: "react.component_stack",
        message: componentStack,
        level: "error",
      }),
    ]);
    expect(onError).toHaveBeenCalledWith(error, componentStack);
  });

  it("renders a fallback function with the error and a reset that shows the children again", () => {
    const error = new Error("render failed");
    const boundary = crash(
      {
        children: "children",
        fallback: ({ error: caught, reset }) => ({ caught, reset }),
      },
      error,
    );

    const rendered = boundary.render() as unknown as { caught: unknown; reset: () => void };
    expect(rendered.caught).toBe(error);
    rendered.reset();
    expect(boundary.render()).toBe("children");
  });

  it("renders nothing without a fallback", () => {
    expect(crash({ children: "children" }, new Error("x")).render()).toBeNull();
  });
});
