import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cohorly, init } from "../src/index.js";

// No rrweb mock here: the real @rrweb/record 2.2.0 runs through the SDK
// (session.ts -> replay.ts -> rrweb) on jsdom, and what reaches /replay is
// checked for the page's secrets.
const API_HOST = "https://ingest.example.com";
const SECRETS = [
  "secret-text-input",
  "secret-password",
  "secret-hidden-token",
  "secret-masked-text",
  "secret-blocked-content",
  "typed-secret",
];

describe("session replay privacy with the real rrweb", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal("CompressionStream", undefined);
    fetchMock = vi.fn(async () => new Response('{"status":1}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    document.body.innerHTML = `
      <p>Visible public text</p>
      <input id="name" value="secret-text-input">
      <input type="password" value="secret-password">
      <input type="hidden" name="csrf" value="secret-hidden-token">
      <p data-cohorly-mask>secret-masked-text</p>
      <div data-cohorly-block><span>secret-blocked-content</span></div>
    `;
  });

  afterEach(() => {
    cohorly.optOutTracking();
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const replayBodies = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith(`${API_HOST}/replay`))
      .map(([, req]) => String((req as { body: string }).body));

  it("never sends input values, hidden inputs, masked text or blocked elements", async () => {
    init({
      apiHost: API_HOST,
      token: "tok",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      sessionReplay: { sampleRate: 1 },
    });
    // The first full snapshot, flushed with the keepalive path when the page hides.
    await vi.waitFor(
      () => {
        window.dispatchEvent(new Event("pagehide"));
        expect(replayBodies().length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 50 },
    );

    const input = document.getElementById("name") as HTMLInputElement;
    input.value = "typed-secret";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const sentBefore = replayBodies().length;
    await vi.waitFor(
      () => {
        window.dispatchEvent(new Event("pagehide"));
        expect(replayBodies().length).toBeGreaterThan(sentBefore);
      },
      { timeout: 5000, interval: 50 },
    );

    const sent = replayBodies().join("\n");
    expect(sent).toContain("Visible public text");
    expect(sent).toContain('"source":5'); // the input event itself was recorded, masked
    for (const secret of SECRETS) expect(sent).not.toContain(secret);
  });
});
