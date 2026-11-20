import { afterEach, describe, expect, it, vi } from "vitest";
import { cohorly, init } from "../src/index.js";
import { onNavigation } from "../src/navigation.js";

const rrweb = vi.hoisted(() => ({ record: vi.fn((_options: unknown) => () => {}) }));
vi.mock("@rrweb/record", () => ({ record: rrweb.record }));

const URL_TRIGGER_ID = "22222222-2222-4222-8222-222222222222";

const session = () =>
  JSON.parse(window.sessionStorage.getItem("chl_replay_session") ?? "null") as {
    mode: string;
    triggered: string[];
  } | null;

/** Queued pageviews of a path (the queue is read, never cleared: the client keeps its own copy in memory). */
const pageviewsOf = (path: string) =>
  (
    JSON.parse(window.localStorage.getItem("cohorly_queue") ?? "[]") as {
      event: string;
      properties: { current_url_path?: string };
    }[]
  ).filter((e) => e.event === "$mp_web_page_view" && e.properties.current_url_path === path);

// The shared history observer (VEL-2187): SPA pageviews, navigation
// breadcrumbs and replay URL triggers share one wrapper.

describe("onNavigation", () => {
  afterEach(() => {
    init({ apiHost: "https://ingest.example.com", loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("wraps history once for every subscriber, notifies them in order, and restores it with the last", () => {
    const before = window.history.pushState;
    const calls: string[] = [];
    const offA = onNavigation(() => calls.push("a"));
    const wrapped = window.history.pushState;
    expect(wrapped).not.toBe(before);
    const offB = onNavigation(() => calls.push("b"));
    expect(window.history.pushState).toBe(wrapped);

    window.history.pushState(null, "", "/one");
    window.history.replaceState(null, "", "/two");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(calls).toEqual(["a", "b", "a", "b", "a", "b"]);
    expect(location.pathname).toBe("/two");

    offA();
    expect(window.history.pushState).toBe(wrapped);
    offB();
    expect(window.history.pushState).toBe(before);
    window.history.pushState(null, "", "/three");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(calls).toHaveLength(6);
  });

  it("a throwing subscriber never breaks the page's navigation or the others", () => {
    const seen = vi.fn();
    const offA = onNavigation(() => {
      throw new Error("boom");
    });
    const offB = onNavigation(seen);
    expect(() => window.history.pushState(null, "", "/x")).not.toThrow();
    expect(seen).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it("pageviews, breadcrumbs and replay URL triggers share one wrapper, and a later init() does not stack pageviews", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    window.localStorage.clear();
    window.sessionStorage.clear();
    // A fresh copy of the project's settings: adopted at once, with a URL trigger on the page navigated to.
    window.localStorage.setItem(
      "chl_replay_config:tok-web",
      JSON.stringify({
        fetchedAt: Date.now(),
        config: { triggers: [{ id: URL_TRIGGER_ID, kind: "url", pattern: "/after", rate: 1 }] },
      }),
    );
    const before = window.history.pushState;
    const options = {
      apiHost: "https://ingest.example.com",
      token: "tok-web",
      loadFeatureFlags: false,
      flushIntervalMs: 0,
      trackPageviews: true,
      captureExceptions: true,
      sessionReplay: { sampleRate: 0, remoteConfig: true },
    };
    init(options);
    const wrapped = window.history.pushState;
    expect(wrapped).not.toBe(before);
    init(options);
    expect(window.history.pushState).toBe(wrapped);
    expect(session()?.mode).toBe("off");

    window.history.pushState(null, "", "/after");

    // Pageviews: one for /after, whatever the queue already held.
    expect(pageviewsOf("/after")).toHaveLength(1);
    // Replay: the URL trigger fired and the session records (rrweb stubbed above).
    expect(session()).toMatchObject({ mode: "session", triggered: [URL_TRIGGER_ID] });
    await vi.waitFor(() => expect(rrweb.record).toHaveBeenCalled());
    // Breadcrumbs: the navigation travels with the next exception.
    const exception = cohorly.captureException(new Error("after the navigation"));
    const crumbs = (exception?.properties.$exception_breadcrumbs ?? []) as { category?: string; message?: string }[];
    expect(crumbs.filter((c) => c.category === "navigation" && c.message?.endsWith("/after"))).toHaveLength(1);
  });
});
