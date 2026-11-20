import type { CohorlyStorage } from "@cohorly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionReplayOptions, TrackedEvent } from "../src/index.js";
import { cohorly, init } from "../src/index.js";
import type { ReplayController, ReplayModule } from "../src/replay/session.js";
import { startSessionReplay } from "../src/replay/session.js";

// The remote settings path of session.ts (VEL-2185), with replay.ts stubbed:
// what is decided, when, and whether the recorder would load.
const replay = vi.hoisted(() => ({
  startRecording: vi.fn((_options: unknown, _ctx: unknown) => ({
    onException: vi.fn(),
    onRotate: vi.fn(),
    onModeChange: vi.fn(),
    beforeReset: vi.fn(),
    optOut: vi.fn(),
    stop: vi.fn(),
  })),
}));
vi.mock("../src/replay/replay.js", () => replay);

const API_HOST = "https://ingest.example.com";
const TOKEN = "tok-web";
const CONFIG_KEY = `chl_replay_config:${TOKEN}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const webStorage = (area: Storage): CohorlyStorage => ({
  get: (key) => area.getItem(key),
  set: (key, value) => area.setItem(key, value),
  remove: (key) => area.removeItem(key),
});

describe("session replay with remoteConfig", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  /** What GET /replay/config answers next. */
  let configAnswer: () => Promise<Response>;

  const controllers: ReplayController[] = [];

  function start(sessionReplay: SessionReplayOptions) {
    init({ apiHost: API_HOST, token: TOKEN, loadFeatureFlags: false, flushIntervalMs: 0, sessionReplay });
  }

  /** The controller alone, with a spy on the loader of replay.ts. */
  function controller(sessionReplay: SessionReplayOptions) {
    const loadReplay = vi.fn(async () => replay as unknown as ReplayModule);
    const ctl = startSessionReplay(sessionReplay, {
      apiHost: API_HOST,
      token: TOKEN,
      localStorage: webStorage(window.localStorage),
      sessionStorage: webStorage(window.sessionStorage),
      maxRetryDelayMs: 600_000,
      getDistinctId: () => "user-1",
      log: () => {},
      random: () => 0,
      loadReplay,
      fetch: fetchMock as unknown as typeof fetch,
    });
    if (!ctl) throw new Error("no controller");
    controllers.push(ctl);
    return { ctl, loadReplay };
  }

  const configCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/replay/config"));
  const storedSession = () =>
    JSON.parse(window.sessionStorage.getItem("chl_replay_session") ?? "null") as {
      id: string;
      mode: string;
      minDurationMs?: number;
    } | null;
  const sessionIdOf = (event: TrackedEvent | null) => event?.properties.$session_id;
  const saveCopy = (config: unknown, fetchedAt = Date.now()) =>
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ fetchedAt, config }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  /** A /replay/config answer the test releases. */
  function deferredConfig(): (body: unknown) => void {
    let release: (res: Response) => void = () => {};
    configAnswer = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    return (body) => release(json(body));
  }

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    replay.startRecording.mockClear();
    vi.spyOn(Math, "random").mockReturnValue(0);
    configAnswer = async () => json({ config: {} });
    fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/replay/config") ? configAnswer() : json({ status: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const ctl of controllers.splice(0)) ctl.stop();
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("without remoteConfig", () => {
    it("never asks for the settings: the code's rates decide, as before", async () => {
      saveCopy({ sampleRate: 1 });
      start({ sampleRate: 0, onErrorSampleRate: 0 });
      expect(sessionIdOf(cohorly.captureException(new Error("a")))).toBeUndefined();

      window.sessionStorage.clear();
      window.localStorage.removeItem(CONFIG_KEY);
      start({ sampleRate: 1 });
      expect(storedSession()?.mode).toBe("session");
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      await settle();
      expect(configCalls()).toHaveLength(0);
    });

    it("remoteConfig without a token reads nothing and keeps the code's rates", async () => {
      const withoutToken = (sessionReplay: SessionReplayOptions) =>
        init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0, sessionReplay });
      withoutToken({ sampleRate: 0, remoteConfig: true });
      await settle();
      expect(storedSession()).toBeNull();
      expect(replay.startRecording).not.toHaveBeenCalled();

      withoutToken({ sampleRate: 1, remoteConfig: true });
      expect(storedSession()?.mode).toBe("session");
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      await settle();
      expect(configCalls()).toHaveLength(0);
    });
  });

  describe("precedence", () => {
    it("code at 0/0 and a saved sampleRate of 1: the session records", async () => {
      configAnswer = async () => json({ config: { sampleRate: 1 } });
      start({ sampleRate: 0, onErrorSampleRate: 0, remoteConfig: true });
      expect(sessionIdOf(cohorly.captureException(new Error("early")))).toBe(storedSession()?.id);

      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      expect(storedSession()?.mode).toBe("session");
      expect(configCalls()).toHaveLength(1);
      expect(String(configCalls()[0][0])).toBe(`${API_HOST}/replay/config?token=${TOKEN}`);
    });

    it("saved rates of 0: replay.ts is never loaded", async () => {
      configAnswer = async () => json({ config: { sampleRate: 0, onErrorSampleRate: 0 } });
      const { loadReplay } = controller({ sampleRate: 1, onErrorSampleRate: 1, remoteConfig: true });
      await vi.waitFor(() => expect(storedSession()?.mode).toBe("off"));
      await settle();
      expect(loadReplay).not.toHaveBeenCalled();
    });

    it("saved rates of 0: the session is off, $session_id still stamped, the recorder never loads", async () => {
      configAnswer = async () => json({ config: { sampleRate: 0, onErrorSampleRate: 0 } });
      start({ sampleRate: 1, onErrorSampleRate: 1, remoteConfig: true });
      await vi.waitFor(() => expect(storedSession()?.mode).toBe("off"));
      await settle();
      expect(sessionIdOf(cohorly.captureException(new Error("x")))).toBe(storedSession()?.id);
      expect(replay.startRecording).not.toHaveBeenCalled();
    });

    it("a saved field wins over the code's, a field never saved keeps the code's", async () => {
      configAnswer = async () => json({ config: { sampleRate: 0 } });
      start({ sampleRate: 1, onErrorSampleRate: 1, remoteConfig: true });
      await vi.waitFor(() => expect(storedSession()?.mode).toBe("error"));
    });

    it("no network and no copy: the code's values", async () => {
      configAnswer = async () => {
        throw new TypeError("Failed to fetch");
      };
      start({ sampleRate: 1, remoteConfig: true });
      await vi.waitFor(() => expect(storedSession()?.mode).toBe("session"));
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      expect(window.localStorage.getItem(CONFIG_KEY)).toBeNull();
    });

    it("a forged answer never reaches the recorder: masking, blocking and iframes stay the code's", async () => {
      configAnswer = async () =>
        json({
          config: {
            sampleRate: 1,
            minDurationMs: 5000,
            maskTextSelector: "",
            blockSelector: "",
            allowedIframeOrigins: ["https://evil.example.com"],
            console: false,
          },
        });
      const code: SessionReplayOptions = {
        sampleRate: 0,
        remoteConfig: true,
        maskTextSelector: ".pii",
        blockSelector: ".ads",
        allowedIframeOrigins: ["https://pay.example.com"],
      };
      start(code);
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));

      const [options] = replay.startRecording.mock.calls[0] as [SessionReplayOptions, unknown];
      expect(options).toMatchObject({
        sampleRate: 0,
        maskTextSelector: ".pii",
        blockSelector: ".ads",
        allowedIframeOrigins: ["https://pay.example.com"],
      });
      expect(options.console).toBeUndefined();
      expect(storedSession()?.minDurationMs).toBe(5000);
    });

    it("the minimum duration is remote only: 0 from the code", async () => {
      start({ sampleRate: 1, remoteConfig: true });
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      expect(storedSession()).not.toHaveProperty("minDurationMs");
    });
  });

  describe("cache", () => {
    it("a copy younger than an hour decides at once, with no request", async () => {
      saveCopy({ sampleRate: 1 });
      start({ sampleRate: 0, remoteConfig: true });
      expect(storedSession()?.mode).toBe("session");
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      await settle();
      expect(configCalls()).toHaveLength(0);
    });

    it("an expired copy is renewed, and the new answer decides", async () => {
      saveCopy({ sampleRate: 0 }, Date.now() - 61 * 60_000);
      configAnswer = async () => json({ config: { sampleRate: 1 } });
      start({ sampleRate: 0, remoteConfig: true });
      await vi.waitFor(() => expect(storedSession()?.mode).toBe("session"));
      expect(configCalls()).toHaveLength(1);
      expect(JSON.parse(window.localStorage.getItem(CONFIG_KEY) as string).config).toEqual({ sampleRate: 1 });
    });

    it("an existing session keeps its mode after the settings change", async () => {
      saveCopy({ sampleRate: 1 });
      start({ sampleRate: 0, remoteConfig: true });
      const { id } = storedSession() ?? { id: "" };
      expect(storedSession()?.mode).toBe("session");
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));

      // A reload after the project turned recording off: same session, same mode.
      saveCopy({ sampleRate: 0, onErrorSampleRate: 0 });
      start({ sampleRate: 0, remoteConfig: true });
      expect(storedSession()).toMatchObject({ id, mode: "session" });
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(2));

      // The next session follows the new settings.
      cohorly.reset();
      expect(storedSession()?.id).not.toBe(id);
      expect(storedSession()?.mode).toBe("off");
    });
  });

  describe("pending decision", () => {
    it("a new session waits for the answer: $session_id from the start, no recorder until it is decided", async () => {
      const release = deferredConfig();
      start({ sampleRate: 0, remoteConfig: true });
      const id = storedSession()?.id;
      expect(storedSession()?.mode).toBe("pending");
      expect(sessionIdOf(cohorly.captureException(new Error("while pending")))).toBe(id);
      await settle();
      expect(replay.startRecording).not.toHaveBeenCalled();

      release({ config: { onErrorSampleRate: 1 } });
      await vi.waitFor(() => expect(storedSession()).toMatchObject({ id, mode: "error" }));
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      // The exception came before any buffer existed: nothing is handed to the recorder.
      const recording = replay.startRecording.mock.results[0].value;
      expect(recording.onException).not.toHaveBeenCalled();
    });

    it("decides with the code's values after 3 s without an answer", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      configAnswer = () => new Promise<Response>(() => {});
      start({ sampleRate: 1, remoteConfig: true });
      expect(storedSession()?.mode).toBe("pending");
      await vi.advanceTimersByTimeAsync(2999);
      expect(storedSession()?.mode).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(storedSession()?.mode).toBe("session");
      vi.useRealTimers();
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
    });

    it("a session rotated while waiting waits too, and is decided with the answer", async () => {
      const release = deferredConfig();
      start({ sampleRate: 0, remoteConfig: true });
      const first = storedSession()?.id;
      cohorly.reset();
      const second = storedSession()?.id;
      expect(second).not.toBe(first);
      expect(storedSession()?.mode).toBe("pending");

      release({ config: { sampleRate: 1 } });
      await vi.waitFor(() => expect(storedSession()).toMatchObject({ id: second, mode: "session" }));
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));

      // Once known, a rotation decides at once.
      cohorly.reset();
      expect(storedSession()?.mode).toBe("session");
    });

    it("a pending session never loads replay.ts before it is decided", async () => {
      const release = deferredConfig();
      const { loadReplay } = controller({ sampleRate: 0, remoteConfig: true });
      expect(storedSession()?.mode).toBe("pending");
      await settle();
      expect(loadReplay).not.toHaveBeenCalled();

      release({ config: { sampleRate: 1 } });
      await vi.waitFor(() => expect(loadReplay).toHaveBeenCalledTimes(1));
      expect(storedSession()?.mode).toBe("session");
    });

    it.each(["optOut", "stop"] as const)(
      "%s with the request in flight: the answer decides nothing and loads nothing",
      async (method) => {
        const release = deferredConfig();
        const { ctl, loadReplay } = controller({ sampleRate: 0, remoteConfig: true });
        ctl[method]();
        release({ config: { sampleRate: 1 } });
        await settle();
        expect(storedSession()?.mode).toBe("pending");
        expect(loadReplay).not.toHaveBeenCalled();
      },
    );

    it("a pending session left by the previous page is decided on this one", async () => {
      window.sessionStorage.setItem(
        "chl_replay_session",
        JSON.stringify({ id: "prev-1", startedAt: Date.now(), lastActivity: Date.now(), mode: "pending", seq: 0 }),
      );
      saveCopy({ sampleRate: 1 });
      start({ sampleRate: 0, remoteConfig: true });
      expect(storedSession()).toMatchObject({ id: "prev-1", mode: "session" });
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
    });

    it("a duplicated tab of a pending session mints its own session and decides it apart", async () => {
      // The original tab's record and its page marker, copied by the browser.
      window.sessionStorage.setItem(
        "chl_replay_session",
        JSON.stringify({ id: "orig-1", startedAt: Date.now(), lastActivity: Date.now(), mode: "pending", seq: 0 }),
      );
      window.sessionStorage.setItem("chl_replay_tab", "the-original-page");
      const release = deferredConfig();
      start({ sampleRate: 0, remoteConfig: true });
      const own = storedSession()?.id;
      expect(own).not.toBe("orig-1");
      expect(storedSession()?.mode).toBe("pending");

      release({ config: { sampleRate: 1 } });
      await vi.waitFor(() => expect(storedSession()).toMatchObject({ id: own, mode: "session" }));
    });

    it("a re-init while waiting: the old controller never decides", async () => {
      const release = deferredConfig();
      start({ sampleRate: 0, remoteConfig: true });
      init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
      release({ config: { sampleRate: 1 } });
      await settle();
      expect(storedSession()?.mode).toBe("pending");
      expect(replay.startRecording).not.toHaveBeenCalled();
    });
  });
  describe("settings read again for new sessions", () => {
    it("a session minted an hour after the settings were read asks again and decides with the answer; the live one keeps its mode", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      saveCopy({ sampleRate: 1 });
      start({ sampleRate: 0, remoteConfig: true });
      const { id } = storedSession() ?? { id: "" };
      expect(storedSession()?.mode).toBe("session");
      await vi.waitFor(() => expect(replay.startRecording).toHaveBeenCalledTimes(1));
      const recording = replay.startRecording.mock.results[0].value;

      configAnswer = async () => json({ config: { sampleRate: 0, onErrorSampleRate: 1 } });
      for (const minutes of [25, 50, 61]) {
        vi.setSystemTime(t0 + minutes * 60_000);
        cohorly.track("still here");
      }
      expect(storedSession()).toMatchObject({ id, mode: "session" });
      expect(configCalls()).toHaveLength(0);

      cohorly.reset();
      expect(storedSession()?.id).not.toBe(id);
      expect(storedSession()?.mode).toBe("pending");
      expect(recording.onRotate).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(storedSession()?.mode).toBe("error"));
      expect(recording.onModeChange).toHaveBeenCalledTimes(1);
      expect(configCalls()).toHaveLength(1);
    });

    it("an answer stored after the 3 s wait decides the next session, with no new request", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const release = deferredConfig();
      start({ sampleRate: 0, remoteConfig: true });
      await vi.advanceTimersByTimeAsync(3000);
      expect(storedSession()?.mode).toBe("off");

      await vi.advanceTimersByTimeAsync(1000);
      release({ config: { sampleRate: 1 } });
      await vi.waitFor(() => expect(window.localStorage.getItem(CONFIG_KEY)).not.toBeNull());

      cohorly.reset();
      expect(storedSession()?.mode).toBe("session");
      expect(configCalls()).toHaveLength(1);
    });
  });
});
