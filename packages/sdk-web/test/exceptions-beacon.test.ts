import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExceptionListEntry, TrackedEvent } from "../src/index.js";
import { cohorly, init } from "../src/index.js";


/** Blob stand-in that keeps what was passed in, so the beacon body can be read back. */
class RecordingBlob {
  constructor(
    readonly parts: string[],
    readonly options?: { type?: string },
  ) {}
}

function values(body: TrackedEvent[]): string[] {
  return body.map((e) => (e.properties.$exception_list as ExceptionListEntry[])[0].value);
}

describe("pagehide", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends fatal exceptions through sendBeacon first", async () => {
    window.localStorage.clear();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Blob", RecordingBlob);
    const sendBeacon = vi.fn((_url: string, _body: RecordingBlob) => true);
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });

    init({
      apiHost: "http://localhost:4000",
      token: "tok-web",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      captureExceptions: true,
    });
    cohorly.captureException(new Error("handled one"));
    const crash = new Error("crash on unload");
    window.dispatchEvent(new ErrorEvent("error", { error: crash, message: crash.message }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    window.dispatchEvent(new Event("pagehide"));

    expect(sendBeacon).toHaveBeenCalled();
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe("http://localhost:4000/track");
    // A CORS-safelisted type: no preflight, so a cross-origin ingestion host
    // needs no Access-Control-Allow-Credentials for the beacon to be delivered.
    expect(blob.options?.type).toMatch(/^text\/plain/);
    const first = JSON.parse(blob.parts[0]) as TrackedEvent[];
    expect(values(first)).toEqual(["crash on unload"]);
    expect(first[0].properties.$exception_level).toBe("fatal");

    const sentAfter = sendBeacon.mock.calls
      .slice(1)
      .flatMap(([, rest]) => values(JSON.parse(rest.parts[0])));
    expect(sentAfter).toEqual(["handled one"]);
  });

  it("re-init leaves only the new client listening for pagehide", async () => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    vi.stubGlobal("Blob", RecordingBlob);
    const sendBeacon = vi.fn((_url: string, _body: RecordingBlob) => true);
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
    const options = {
      apiHost: "http://localhost:4000",
      token: "tok-web",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
    };

    init(options);
    cohorly.captureException(new Error("before re-init"), { level: "fatal" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    init(options);
    cohorly.captureException(new Error("after re-init"), { level: "fatal" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    sendBeacon.mockClear();

    window.dispatchEvent(new Event("pagehide"));

    const fatalBeacons = sendBeacon.mock.calls
      .map(([, blob]) => values(JSON.parse(blob.parts[0])))
      .filter((sent) => sent.length > 0);
    expect(fatalBeacons[0]).toEqual(["before re-init", "after re-init"]);
    expect(fatalBeacons.flat().filter((v) => v === "before re-init")).toHaveLength(1);
  });
});
