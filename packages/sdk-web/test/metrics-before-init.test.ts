import { afterEach, describe, expect, it, vi } from "vitest";
import { cohorly } from "../src/index.js";

// Kept alone in its file: any init() in the same module graph would leave an
// active client behind, and this file needs the module as freshly imported.
describe("cohorly.metrics before init()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("never throws and nothing is queued or sent on a later pagehide", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
    window.localStorage.clear();

    expect(() => {
      cohorly.metrics.count("a", 1);
      cohorly.metrics.count("a");
      cohorly.metrics.gauge("b", 2, { k: "v" });
      cohorly.metrics.distribution("c", 3, { tags: { k: "v" }, unit: "ms" });
      cohorly.metrics.flush();
    }).not.toThrow();
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });
});
