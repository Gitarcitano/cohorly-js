import { gunzipSync, strFromU8 } from "fflate";
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
      .map(([, req]) => {
        // The keepalive path gzips with fflate.
        const { body } = req as { body: string | Uint8Array };
        return typeof body === "string" ? body : strFromU8(gunzipSync(body));
      });

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

  it("with allowedIframeOrigins, rrweb gets a child's snapshot only from a listed origin and an <iframe> of the page (VEL-2152)", async () => {
    document.body.innerHTML = '<p>Parent page</p><iframe id="pay"></iframe>';
    const frame = document.getElementById("pay") as HTMLIFrameElement;
    init({
      apiHost: API_HOST,
      token: "tok",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      sessionReplay: { sampleRate: 1, allowedIframeOrigins: ["https://pay.example.com"] },
    });
    await vi.waitFor(
      () => {
        window.dispatchEvent(new Event("pagehide"));
        expect(replayBodies().length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 50 },
    );

    // A child's full snapshot, as rrweb in a cross-origin iframe posts it.
    const childSnapshot = (origin: string, source: Window | null, text: string) =>
      new MessageEvent("message", {
        origin,
        source,
        data: {
          type: "rrweb",
          origin,
          isCheckout: true,
          event: {
            type: 2,
            timestamp: Date.now(),
            data: {
              node: {
                type: 0,
                id: 1,
                childNodes: [{ type: 2, tagName: "p", attributes: {}, id: 2, childNodes: [{ type: 3, textContent: text, id: 3 }] }],
              },
              initialOffset: { top: 0, left: 0 },
            },
          },
        },
      });
    window.dispatchEvent(childSnapshot("https://evil.example.com", frame.contentWindow, "unlisted-origin-text"));
    window.dispatchEvent(childSnapshot("https://pay.example.com", window, "not-an-iframe-text"));
    window.dispatchEvent(childSnapshot("https://pay.example.com", frame.contentWindow, "iframe-public-text"));

    const sentBefore = replayBodies().length;
    await vi.waitFor(
      () => {
        window.dispatchEvent(new Event("pagehide"));
        expect(replayBodies().length).toBeGreaterThan(sentBefore);
      },
      { timeout: 5000, interval: 50 },
    );
    const sent = replayBodies().join("\n");
    expect(sent).toContain("iframe-public-text");
    expect(sent).toContain('"isAttachIframe":true');
    expect(sent).not.toContain("unlisted-origin-text");
    expect(sent).not.toContain("not-an-iframe-text");
  });

  it("never attaches the snapshot of an <iframe> the parent blocks, though rrweb keeps it as a placeholder (VEL-2152)", async () => {
    document.body.innerHTML = '<p>Parent page</p><iframe id="blocked" data-cohorly-block></iframe><iframe id="open"></iframe>';
    const blocked = document.getElementById("blocked") as HTMLIFrameElement;
    const open = document.getElementById("open") as HTMLIFrameElement;
    init({
      apiHost: API_HOST,
      token: "tok",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      sessionReplay: { sampleRate: 1, allowedIframeOrigins: ["https://pay.example.com"] },
    });
    await vi.waitFor(
      () => {
        window.dispatchEvent(new Event("pagehide"));
        expect(replayBodies().length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 50 },
    );
    const childSnapshot = (source: Window | null, text: string) =>
      new MessageEvent("message", {
        origin: "https://pay.example.com",
        source,
        data: {
          type: "rrweb",
          origin: "https://pay.example.com",
          isCheckout: true,
          event: {
            type: 2,
            timestamp: Date.now(),
            data: {
              node: {
                type: 0,
                id: 1,
                childNodes: [{ type: 2, tagName: "p", attributes: {}, id: 2, childNodes: [{ type: 3, textContent: text, id: 3 }] }],
              },
              initialOffset: { top: 0, left: 0 },
            },
          },
        },
      });
    window.dispatchEvent(childSnapshot(blocked.contentWindow, "blocked-frame-text"));
    window.dispatchEvent(childSnapshot(open.contentWindow, "open-frame-text"));

    const sentBefore = replayBodies().length;
    await vi.waitFor(
      () => {
        window.dispatchEvent(new Event("pagehide"));
        expect(replayBodies().length).toBeGreaterThan(sentBefore);
      },
      { timeout: 5000, interval: 50 },
    );
    const sent = replayBodies().join("\n");
    expect(sent).toContain("open-frame-text");
    expect(sent).not.toContain("blocked-frame-text");
  });
});
