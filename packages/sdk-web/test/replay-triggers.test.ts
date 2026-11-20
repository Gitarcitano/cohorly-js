import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { CohorlyStorage, FlagResult } from "@cohorly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cohorly, init } from "../src/index.js";
import type { ReplayController, ReplayDeps, ReplayModule, SessionReplayOptions } from "../src/replay/session.js";
import { startSessionReplay } from "../src/replay/session.js";
import type { ClientFilter, FlagTrigger } from "../src/replay/triggers.js";
import { flagMatches, matchesClientFilter, matchesUrlPattern, parseTriggers } from "../src/replay/triggers.js";

interface FilterCase {
  name: string;
  filter: ClientFilter;
  properties: Record<string, unknown>;
  expected: boolean;
}
/** The shared table, read as is (never edited here). */
const table = JSON.parse(
  readFileSync(fileURLToPath(new NodeURL("./fixtures/client-filter-cases.json", import.meta.url)), "utf8"),
) as { version: number; cases: FilterCase[] };

// Replay triggers in the browser (VEL-2187): the evaluator against the shared
// case table, and the controller (session.ts) with replay.ts stubbed: when a
// trigger is drawn, what it promotes, and that it never fires twice. The
// recording side (snapshot, error buffer, minimum duration) is in replay.test.ts.

describe("matchesClientFilter: the shared case table (VEL-2186)", () => {
  it("has every case", () => {
    expect(table.version).toBe(1);
    expect(table.cases).toHaveLength(82);
  });

  it.each(table.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(matchesClientFilter(c.filter, c.properties)).toBe(c.expected);
  });
});

describe("matchesUrlPattern", () => {
  it("is anchored, * is any run including /, everything else is literal", () => {
    expect(matchesUrlPattern("/checkout/*", "/checkout/pay/card")).toBe(true);
    expect(matchesUrlPattern("/checkout/*", "/checkout/")).toBe(true);
    expect(matchesUrlPattern("/checkout/*", "/checkout")).toBe(false);
    expect(matchesUrlPattern("/checkout/*", "/shop/checkout/pay")).toBe(false);
    expect(matchesUrlPattern("/a.b", "/a.b")).toBe(true);
    expect(matchesUrlPattern("/a.b", "/axb")).toBe(false);
    expect(matchesUrlPattern("/p(1)+[x]", "/p(1)+[x]")).toBe(true);
    expect(matchesUrlPattern("/*/settings", "/team/42/settings")).toBe(true);
    expect(matchesUrlPattern("/Docs", "/docs")).toBe(false);
  });
});

describe("flagMatches", () => {
  const flags: Record<string, FlagResult> = {
    checkout: { enabled: true, variant: null, payload: null, reason: "rule:0" },
    banner: { enabled: true, variant: "blue", payload: null, reason: "rule:0" },
    off: { enabled: false, variant: null, payload: null, reason: "no_match" },
  };
  const trigger = (flag: string, variant: string | null): FlagTrigger => ({ id: "f", kind: "flag", flag, variant, rate: 1 });

  it("any variant when the trigger names none; only the named variant otherwise; never an inactive or absent flag", () => {
    expect(flagMatches(trigger("checkout", null), flags)).toBe(true);
    expect(flagMatches(trigger("banner", null), flags)).toBe(true);
    expect(flagMatches(trigger("banner", "blue"), flags)).toBe(true);
    expect(flagMatches(trigger("banner", "red"), flags)).toBe(false);
    expect(flagMatches(trigger("checkout", "blue"), flags)).toBe(false);
    expect(flagMatches(trigger("off", null), flags)).toBe(false);
    expect(flagMatches(trigger("missing", null), flags)).toBe(false);
    expect(flagMatches(trigger("toString", null), flags)).toBe(false);
  });
});

describe("parseTriggers", () => {
  it("keeps the valid triggers and skips anything it cannot read, never throwing", () => {
    const valid = [
      { id: "a", kind: "event", event: "Paid", filters: [{ kind: "property", scope: "event", key: "plan", op: "eq", value: "pro" }], rate: 1 },
      { id: "b", kind: "url", pattern: "/checkout/*", rate: 0.5 },
      { id: "c", kind: "flag", flag: "beta", variant: null, rate: 0 },
    ];
    expect(
      parseTriggers([
        ...valid,
        null,
        "x",
        { id: "a", kind: "url", pattern: "/dup", rate: 1 },
        { id: "d", kind: "url", pattern: "no-slash", rate: 1 },
        { id: "e", kind: "event", event: "X", filters: [{ kind: "cohort", id: 1 }], rate: 1 },
        { id: "f", kind: "event", event: "X", filters: [{ kind: "property", scope: "event", key: "n", op: "gt", value: "5" }], rate: 1 },
        { id: "g", kind: "flag", flag: "beta", variant: 3, rate: 1 },
        { id: "h", kind: "url", pattern: "/x", rate: 2 },
        { kind: "url", pattern: "/no-id", rate: 1 },
      ]),
    ).toEqual(valid);
    expect(parseTriggers(undefined)).toEqual([]);
    expect(parseTriggers({})).toEqual([]);
  });
});

const API_HOST = "https://ingest.example.com";
const TOKEN = "tok-web";
const CONFIG_KEY = `chl_replay_config:${TOKEN}`;
const SESSION_KEY = "chl_replay_session";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const URL_ID = "22222222-2222-4222-8222-222222222222";
const FLAG_ID = "33333333-3333-4333-8333-333333333333";

const replay = vi.hoisted(() => {
  const recording = {
    onException: vi.fn(),
    onRotate: vi.fn(),
    onModeChange: vi.fn(),
    promote: vi.fn(),
    beforeReset: vi.fn(),
    optOut: vi.fn(),
    stop: vi.fn(),
  };
  return { recording, startRecording: vi.fn((_options: unknown, _ctx: unknown) => recording) };
});
vi.mock("../src/replay/replay.js", () => ({ startRecording: replay.startRecording }));

const webStorage = (area: Storage): CohorlyStorage => ({
  get: (key) => area.getItem(key),
  set: (key, value) => area.setItem(key, value),
  remove: (key) => area.removeItem(key),
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("replay triggers in the controller", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const controllers: ReplayController[] = [];

  /** A fresh copy of the project's settings: adopted at once, no request. */
  const saveRemote = (config: Record<string, unknown>) =>
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ fetchedAt: Date.now(), config }));
  const stored = () =>
    JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? "null") as {
      id: string;
      mode: string;
      triggered?: string[];
      recStart?: number;
    } | null;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  /** The last queued event of that name (cohorly.track() returns nothing). */
  const lastQueued = (name: string) =>
    (JSON.parse(window.localStorage.getItem("cohorly_queue") ?? "[]") as { event: string; properties: Record<string, unknown> }[])
      .filter((e) => e.event === name)
      .at(-1);

  function controller(
    sessionReplay: SessionReplayOptions = { sampleRate: 0, remoteConfig: true },
    deps: Partial<ReplayDeps> = {},
  ) {
    const ctl = startSessionReplay(sessionReplay, {
      apiHost: API_HOST,
      token: TOKEN,
      localStorage: webStorage(window.localStorage),
      sessionStorage: webStorage(window.sessionStorage),
      maxRetryDelayMs: 600_000,
      getDistinctId: () => "user-1",
      log: () => {},
      random: () => 0,
      loadReplay: async () => replay as unknown as ReplayModule,
      fetch: fetchMock as unknown as typeof fetch,
      ...deps,
    });
    if (!ctl) throw new Error("no controller");
    controllers.push(ctl);
    return ctl;
  }

  const eventTrigger = (filters: ClientFilter[] = [], rate = 1) => ({ id: EVENT_ID, kind: "event", event: "Checkout Started", filters, rate });
  const planIsPro: ClientFilter = { kind: "property", scope: "event", key: "plan", op: "eq", value: "pro" };

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    replay.startRecording.mockClear();
    for (const fn of Object.values(replay.recording)) fn.mockClear();
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes("/replay/config")) return json({ config: {} });
      if (target.endsWith("/flags/evaluate")) {
        return json({
          flags: {
            beta: { enabled: true, variant: "blue", payload: null, reason: "rule:0" },
            dark: { enabled: false, variant: null, payload: null, reason: "no_match" },
          },
        });
      }
      return json({ status: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const ctl of controllers.splice(0)) ctl.stop();
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  describe("event triggers", () => {
    it("fire on the exact name with every filter passing on the final properties, super props included", async () => {
      saveRemote({ triggers: [eventTrigger([planIsPro])] });
      init({ apiHost: API_HOST, token: TOKEN, loadFeatureFlags: false, flushIntervalMs: 0, sessionReplay: { sampleRate: 0, remoteConfig: true } });
      const before = stored();
      expect(before?.mode).toBe("off");

      cohorly.register({ plan: "pro" });
      cohorly.track("Checkout Started");
      // The event keeps the session it was built in: a hit promotes it, never rotates it.
      expect(lastQueued("Checkout Started")?.properties.$session_id).toBe(before?.id);
      expect(stored()).toMatchObject({ id: before?.id, mode: "session", triggered: [EVENT_ID] });
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
    });

    it("never fire when a filter fails or the name differs", async () => {
      saveRemote({ triggers: [eventTrigger([planIsPro])] });
      const ctl = controller();
      ctl.eventProperties("Checkout Started", { plan: "free" });
      ctl.eventProperties("checkout started", { plan: "pro" });
      ctl.eventProperties("Checkout Started Twice", { plan: "pro" });
      ctl.eventProperties("Checkout Started");
      await settle();
      expect(stored()).toMatchObject({ mode: "off", triggered: [] });
      expect(replay.startRecording).not.toHaveBeenCalled();
    });

    it("with two filters, each failing alone keeps it from firing; both passing fires", () => {
      const countryIsBr: ClientFilter = { kind: "property", scope: "event", key: "country", op: "eq", value: "BR" };
      saveRemote({ triggers: [eventTrigger([planIsPro, countryIsBr])] });
      const ctl = controller();
      ctl.eventProperties("Checkout Started", { plan: "free", country: "BR" });
      ctl.eventProperties("Checkout Started", { plan: "pro", country: "US" });
      expect(stored()).toMatchObject({ mode: "off", triggered: [] });
      ctl.eventProperties("Checkout Started", { plan: "pro", country: "BR" });
      expect(stored()).toMatchObject({ mode: "session", triggered: [EVENT_ID] });
    });

    it("match the $session_id the event is queued with: `set` fires on the id the SDK stamps", () => {
      saveRemote({ triggers: [eventTrigger([{ kind: "property", scope: "event", key: "$session_id", op: "set" }])] });
      init({ apiHost: API_HOST, token: TOKEN, loadFeatureFlags: false, flushIntervalMs: 0, sessionReplay: { sampleRate: 0, remoteConfig: true } });
      cohorly.track("Checkout Started");
      expect(lastQueued("Checkout Started")?.properties.$session_id).toBe(stored()?.id);
      expect(stored()).toMatchObject({ mode: "session", triggered: [EVENT_ID] });
    });

    it("match the $session_id the event is queued with: `not_set` fires only when the caller's own value leaves it unset", () => {
      saveRemote({ triggers: [eventTrigger([{ kind: "property", scope: "event", key: "$session_id", op: "not_set" }])] });
      init({ apiHost: API_HOST, token: TOKEN, loadFeatureFlags: false, flushIntervalMs: 0, sessionReplay: { sampleRate: 0, remoteConfig: true } });
      cohorly.track("Checkout Started");
      expect(stored()).toMatchObject({ mode: "off", triggered: [] });
      cohorly.track("Checkout Started", { $session_id: null });
      expect(lastQueued("Checkout Started")?.properties.$session_id).toBeNull();
      expect(stored()).toMatchObject({ mode: "session", triggered: [EVENT_ID] });
    });

    it("never fire for $exception (only track() events do), which still carries the session id", () => {
      saveRemote({ triggers: [{ ...eventTrigger(), event: "$exception" }] });
      init({ apiHost: API_HOST, token: TOKEN, loadFeatureFlags: false, flushIntervalMs: 0, sessionReplay: { sampleRate: 0, remoteConfig: true } });
      const evt = cohorly.captureException(new Error("boom"));
      expect(evt?.properties.$session_id).toBe(stored()?.id);
      expect(stored()).toMatchObject({ mode: "off", triggered: [] });
    });

    it("with no filters, the name alone fires", () => {
      saveRemote({ triggers: [eventTrigger()] });
      const ctl = controller();
      ctl.eventProperties("Checkout Started", {});
      expect(stored()?.mode).toBe("session");
    });

    it("an event tracked before the settings are adopted fires nothing (decision: the triggers of the settings in use)", async () => {
      let release: (res: Response) => void = () => {};
      fetchMock.mockImplementation(
        (url: string) =>
          String(url).includes("/replay/config")
            ? new Promise<Response>((resolve) => {
                release = resolve;
              })
            : Promise.resolve(json({ status: 1 })),
      );
      const ctl = controller();
      expect(stored()?.mode).toBe("pending");
      ctl.eventProperties("Checkout Started", {});

      release(json({ config: { triggers: [eventTrigger()] } }));
      await settle();
      expect(stored()).toMatchObject({ mode: "off", triggered: [] });

      ctl.eventProperties("Checkout Started", {});
      expect(stored()).toMatchObject({ mode: "session", triggered: [EVENT_ID] });
    });
  });

  describe("URL triggers", () => {
    const urlTrigger = (pattern: string) => ({ id: URL_ID, kind: "url", pattern, rate: 1 });

    it("fire on load when the path matches", () => {
      window.history.replaceState(null, "", "/checkout/pay");
      saveRemote({ triggers: [urlTrigger("/checkout/*")] });
      controller();
      expect(stored()).toMatchObject({ mode: "session", triggered: [URL_ID] });
    });

    it("fire on an SPA navigation (pushState, then replaceState in a new session)", () => {
      saveRemote({ triggers: [urlTrigger("/checkout/*")] });
      controller();
      expect(stored()?.mode).toBe("off");
      window.history.pushState(null, "", "/shop");
      expect(stored()?.mode).toBe("off");
      window.history.pushState(null, "", "/checkout/review");
      expect(stored()).toMatchObject({ mode: "session", triggered: [URL_ID] });

      window.sessionStorage.clear();
      window.history.replaceState(null, "", "/");
      controllers.splice(0).forEach((c) => c.stop());
      controller();
      expect(stored()?.mode).toBe("off");
      window.history.replaceState(null, "", "/checkout/a");
      expect(stored()?.mode).toBe("session");
    });

    it("in an expired session on load, a match opens the next session and fires there", () => {
      window.history.replaceState(null, "", "/checkout/pay");
      const now = Date.now();
      window.sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ id: "old-1", startedAt: now - 2 * 3_600_000, lastActivity: now - 3_600_000, mode: "off", seq: 0, triggered: [] }),
      );
      saveRemote({ triggers: [urlTrigger("/checkout/*")] });
      controller();
      expect(stored()).toMatchObject({ mode: "session", triggered: [URL_ID] });
      expect(stored()?.id).not.toBe("old-1");
    });

    it("on a navigation after the session expired idle (no pageview tracked), a match opens the next session and fires there", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      saveRemote({ triggers: [urlTrigger("/checkout/*")] });
      controller();
      const first = stored();
      expect(first?.mode).toBe("off");
      vi.setSystemTime(Date.now() + 31 * 60_000);
      window.history.pushState(null, "", "/checkout/review");
      expect(stored()).toMatchObject({ mode: "session", triggered: [URL_ID] });
      expect(stored()?.id).not.toBe(first?.id);
    });

    it("fire on popstate", () => {
      saveRemote({ triggers: [urlTrigger("/checkout/*")] });
      controller();
      // The unwrapped method moves the URL with no notification, as the browser does before popstate.
      History.prototype.replaceState.call(window.history, null, "", "/checkout/back");
      expect(stored()?.mode).toBe("off");
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(stored()?.mode).toBe("session");
    });

    it("never count the query or the fragment", () => {
      saveRemote({ triggers: [urlTrigger("/checkout")] });
      controller();
      window.history.pushState(null, "", "/shop?next=/checkout#/checkout");
      expect(stored()?.mode).toBe("off");
      window.history.pushState(null, "", "/checkout?step=2#total");
      expect(stored()?.mode).toBe("session");
    });
  });

  describe("flag triggers", () => {
    const flagTrigger = (variant: string | null, flag = "beta") => ({ id: FLAG_ID, kind: "flag", flag, variant, rate: 1 });
    const queued = () =>
      (JSON.parse(window.localStorage.getItem("cohorly_queue") ?? "[]") as { event: string }[]).map((e) => e.event);
    const flagExposures = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/track"))
        .flatMap(([, req]) => JSON.parse((req as { body: string }).body) as { event: string }[])
        .filter((e) => e.event === "$feature_flag_called");

    function start(options: { loadFeatureFlags?: boolean } = {}) {
      init({
        apiHost: API_HOST,
        token: TOKEN,
        flushIntervalMs: 0,
        sessionReplay: { sampleRate: 0, remoteConfig: true },
        ...options,
      });
    }

    it("fire when the flags load with the flag on (any variant), and send no $feature_flag_called", async () => {
      saveRemote({ triggers: [flagTrigger(null)] });
      start();
      await vi.waitFor(() => expect(stored()).toMatchObject({ mode: "session", triggered: [FLAG_ID] }));
      await cohorly.flush();
      expect(queued()).not.toContain("$feature_flag_called");
      expect(flagExposures()).toHaveLength(0);
    });

    it("fire with the variant asked for", async () => {
      saveRemote({ triggers: [flagTrigger("blue")] });
      start();
      await vi.waitFor(() => expect(stored()?.mode).toBe("session"));
      expect(queued()).not.toContain("$feature_flag_called");
    });

    it("never fire with another variant or an inactive flag", async () => {
      saveRemote({ triggers: [flagTrigger("red"), { ...flagTrigger(null, "dark"), id: EVENT_ID }] });
      start();
      await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/flags/evaluate"))).toBe(true));
      await settle();
      expect(cohorly.areFeatureFlagsLoaded()).toBe(true);
      expect(stored()).toMatchObject({ mode: "off", triggered: [] });
      expect(queued()).not.toContain("$feature_flag_called");
    });

    it("never fire with loadFeatureFlags: false, even after a manual reload", async () => {
      saveRemote({ triggers: [flagTrigger(null)] });
      start({ loadFeatureFlags: false });
      await cohorly.reloadFeatureFlags();
      await settle();
      expect(stored()).toMatchObject({ mode: "off", triggered: [] });
    });

    it("re-evaluate on each reload of the flags", () => {
      saveRemote({ triggers: [flagTrigger("blue")] });
      let emit: (flags: Record<string, FlagResult>) => void = () => {};
      controller(undefined, {
        onFeatureFlags: (cb) => {
          emit = cb;
          return () => {};
        },
      });
      emit({ beta: { enabled: true, variant: "red", payload: null, reason: "rule:0" } });
      expect(stored()?.mode).toBe("off");
      emit({ beta: { enabled: true, variant: "blue", payload: null, reason: "rule:1" } });
      expect(stored()?.mode).toBe("session");
    });
  });

  describe("draw and once per session", () => {
    it("draws the rate once with the injected random and marks the trigger used, hit or miss", () => {
      saveRemote({ triggers: [eventTrigger([], 0.25)] });
      const random = vi.fn().mockReturnValueOnce(0.3).mockReturnValue(0);
      const ctl = controller(undefined, { random });
      const draws = random.mock.calls.length; // the session's own sampling draws
      ctl.eventProperties("Checkout Started", {});
      expect(random).toHaveBeenCalledTimes(draws + 1);
      expect(stored()).toMatchObject({ mode: "off", triggered: [EVENT_ID] });

      ctl.eventProperties("Checkout Started", {});
      expect(random).toHaveBeenCalledTimes(draws + 1);
      expect(stored()?.mode).toBe("off");
    });

    it("a hit under the rate promotes", () => {
      saveRemote({ triggers: [eventTrigger([], 0.25)] });
      const random = vi.fn(() => 0.2);
      const ctl = controller(undefined, { random });
      ctl.eventProperties("Checkout Started", {});
      expect(stored()).toMatchObject({ mode: "session", triggered: [EVENT_ID] });
    });

    it("a reload of the session never fires a trigger already drawn", () => {
      saveRemote({ triggers: [eventTrigger([], 0.5)] });
      const ctl = controller(undefined, { random: () => 0.9 });
      ctl.eventProperties("Checkout Started", {});
      expect(stored()).toMatchObject({ mode: "off", triggered: [EVENT_ID] });
      window.dispatchEvent(new Event("pagehide"));
      ctl.stop();

      const random = vi.fn(() => 0);
      const reloaded = controller(undefined, { random });
      const id = stored()?.id;
      reloaded.eventProperties("Checkout Started", {});
      expect(stored()).toMatchObject({ id, mode: "off", triggered: [EVENT_ID] });
      expect(random).not.toHaveBeenCalled();
    });

    it("a new session draws again", () => {
      saveRemote({ triggers: [eventTrigger([], 0.5)] });
      let next = 0.9;
      const ctl = controller(undefined, { random: () => next });
      ctl.eventProperties("Checkout Started", {});
      expect(stored()?.triggered).toEqual([EVENT_ID]);
      ctl.reset();
      expect(stored()?.triggered).toEqual([]);
      next = 0.1;
      ctl.eventProperties("Checkout Started", {});
      expect(stored()).toMatchObject({ mode: "session", triggered: [EVENT_ID] });
    });

    it("a session already recording neither draws nor marks", async () => {
      saveRemote({ sampleRate: 1, triggers: [eventTrigger()] });
      const random = vi.fn(() => 0);
      const ctl = controller(undefined, { random });
      const draws = random.mock.calls.length;
      ctl.eventProperties("Checkout Started", {});
      expect(random).toHaveBeenCalledTimes(draws);
      expect(stored()).toMatchObject({ mode: "session", triggered: [] });
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      expect(replay.recording.promote).not.toHaveBeenCalled();
    });

    it("a stored record without triggered (written before triggers existed) is valid and reads as none", () => {
      window.sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ id: "old-1", startedAt: Date.now(), lastActivity: Date.now(), mode: "off", seq: 0 }),
      );
      saveRemote({ triggers: [eventTrigger()] });
      const ctl = controller();
      expect(stored()?.id).toBe("old-1");
      ctl.eventProperties("Checkout Started", {});
      expect(stored()).toMatchObject({ id: "old-1", mode: "session", triggered: [EVENT_ID] });
    });
  });

  describe("without remoteConfig", () => {
    const configCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/replay/config"));

    it("no trigger exists: no navigation wrapper, no flag listener, saved triggers ignored", async () => {
      window.history.replaceState(null, "", "/checkout/x");
      saveRemote({ triggers: [eventTrigger(), { id: URL_ID, kind: "url", pattern: "/*", rate: 1 }] });
      const pushStateBefore = window.history.pushState;
      const onFeatureFlags = vi.fn(() => () => {});
      const ctl = controller({ onErrorSampleRate: 1 }, { onFeatureFlags });
      expect(window.history.pushState).toBe(pushStateBefore);
      expect(onFeatureFlags).not.toHaveBeenCalled();
      ctl.eventProperties("Checkout Started", {});
      window.history.pushState(null, "", "/checkout/y");
      await settle();
      expect(stored()).toMatchObject({ mode: "error", triggered: [] });
      expect(configCalls()).toHaveLength(0);
    });
  });
});
