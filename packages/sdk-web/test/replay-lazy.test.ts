import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CohorlyWebOptions } from "../src/index.js";
import { cohorly, init } from "../src/index.js";

// Its own file: the module registry is per file, so "never imported" means
// no test here ever made the SDK import these modules. Only
// src/replay/session.ts ships in the main bundle; replay.ts (which imports
// the sender) and rrweb load on demand.
const loaded = vi.hoisted(() => ({ rrweb: 0, replay: 0, sender: 0 }));
vi.mock("@rrweb/record", () => {
  loaded.rrweb += 1;
  return { record: vi.fn(() => () => {}) };
});
vi.mock("../src/replay/replay.js", () => {
  loaded.replay += 1;
  return {
    startRecording: vi.fn(() => ({
      onException() {},
      onRotate() {},
      beforeReset() {},
      optOut() {},
      stop() {},
    })),
  };
});
vi.mock("../src/replay/sender.js", () => {
  loaded.sender += 1;
  return {};
});

const API_HOST = "https://ingest.example.com";

function start(options: Partial<CohorlyWebOptions> = {}) {
  init({ apiHost: API_HOST, token: "tok", loadFeatureFlags: false, flushIntervalMs: 0, ...options });
}

describe("session replay stays out of pages that do not record", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    fetchMock = vi.fn(async () => new Response('{"status":1}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    start();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const sentProperties = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/track"))
      .flatMap(([, req]) => JSON.parse((req as { body: string }).body) as { properties: Record<string, unknown> }[])
      .map((e) => e.properties);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it.each([
    ["without sessionReplay", undefined],
    ["with both rates at 0", { sampleRate: 0, onErrorSampleRate: 0 }],
  ])("%s: nothing of replay is imported and no event carries $session_id", async (_, sessionReplay) => {
    start({ sessionReplay });
    cohorly.track("Viewed");
    cohorly.captureException(new Error("boom"));
    await cohorly.flush();
    await settle();

    const props = sentProperties();
    expect(props.length).toBeGreaterThanOrEqual(2);
    expect(props.every((p) => !("$session_id" in p))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/replay"))).toBe(false);
    expect(loaded).toEqual({ rrweb: 0, replay: 0, sender: 0 });
  });

  it("opted out at init: nothing is imported, even after optInTracking()", async () => {
    start();
    cohorly.optOutTracking();
    start({ sessionReplay: { sampleRate: 1, onErrorSampleRate: 1 } });
    cohorly.optInTracking();
    cohorly.track("Back");
    await cohorly.flush();
    await settle();

    expect(sentProperties().every((p) => !("$session_id" in p))).toBe(true);
    expect(loaded).toEqual({ rrweb: 0, replay: 0, sender: 0 });
  });

  it("a session sampled out stamps $session_id but never imports the recorder", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    start({ sessionReplay: { sampleRate: 0.5, onErrorSampleRate: 0.5 } });
    cohorly.track("Viewed");
    await cohorly.flush();
    await settle();

    const [props] = sentProperties();
    expect(props.$session_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(loaded).toEqual({ rrweb: 0, replay: 0, sender: 0 });
  });

  // Last: once imported, a module stays in this file's registry.
  it("a sampled session imports replay.ts (the counters above do see an import)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    start({ sessionReplay: { sampleRate: 1 } });
    await vi.waitFor(() => expect(loaded.replay).toBe(1));
  });
});
