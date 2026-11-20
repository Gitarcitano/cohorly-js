import type { CohorlyStorage } from "@cohorly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SDK_ENDPOINTS, sdkRequestMatcher } from "../src/network.js";
import {
  loadReplayConfig,
  parseReplayConfig,
  REPLAY_CONFIG_ABORT_MS,
  REPLAY_CONFIG_TIMEOUT_MS,
} from "../src/replay/remote-config.js";

const API_HOST = "https://ingest.example.com";
const TOKEN = "tok/web";
const KEY = `chl_replay_config:${TOKEN}`;
const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function memoryStorage(): CohorlyStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("loadReplayConfig", () => {
  let clock = T0;
  let storage: ReturnType<typeof memoryStorage>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const load = (overrides: Partial<Parameters<typeof loadReplayConfig>[0]> = {}) =>
    loadReplayConfig({
      apiHost: API_HOST,
      token: TOKEN,
      storage,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => clock,
      ...overrides,
    });

  const store = (fetchedAt: number, config: unknown) =>
    storage.set(KEY, JSON.stringify({ fetchedAt, config }));

  beforeEach(() => {
    clock = T0;
    storage = memoryStorage();
    fetchMock = vi.fn(async () => answer({ config: { sampleRate: 0.5 } }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a copy younger than an hour is used with no request", async () => {
    store(T0 - HOUR + 1, { sampleRate: 1, minDurationMs: 5000 });
    const result = load();
    expect(result.fresh).toBe(true);
    expect(result.cached).toEqual({ sampleRate: 1, minDurationMs: 5000 });
    expect(result.fetchedAt).toBe(T0 - HOUR + 1);
    await expect(result.ready).resolves.toEqual({ sampleRate: 1, minDurationMs: 5000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an expired copy is renewed with one simple GET and stored again", async () => {
    store(T0 - HOUR, { sampleRate: 1 });
    clock = T0 + 10;
    const result = load();
    expect(result.fresh).toBe(false);
    expect(result.cached).toEqual({ sampleRate: 1 });
    await expect(result.ready).resolves.toEqual({ sampleRate: 0.5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_HOST}/replay/config?token=tok%2Fweb`);
    expect(init.credentials).toBe("omit");
    expect(init.headers).toBeUndefined();
    expect(init.method).toBeUndefined();
    expect(JSON.parse(storage.get(KEY) as string)).toEqual({ fetchedAt: T0 + 10, config: { sampleRate: 0.5 } });
  });

  it("no network and no copy: null, nothing stored", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(load().ready).resolves.toBeNull();
    expect(storage.get(KEY)).toBeNull();
  });

  it("an expired copy and no network: the expired copy", async () => {
    store(T0 - 2 * HOUR, { onErrorSampleRate: 1 });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(load().ready).resolves.toEqual({ onErrorSampleRate: 1 });
    expect(JSON.parse(storage.get(KEY) as string).fetchedAt).toBe(T0 - 2 * HOUR);
  });

  it.each([
    ["a 401", () => answer({ status: 0, error: "invalid token" }, 401)],
    ["a 500", () => answer({ status: 0 }, 500)],
    ["invalid JSON", () => new Response("not json", { status: 200 })],
    ["no config object", () => answer({ config: [1] })],
  ])("%s is a failure: nothing stored, the copy or null", async (_, respond) => {
    fetchMock.mockImplementation(async () => respond());
    await expect(load().ready).resolves.toBeNull();
    expect(storage.get(KEY)).toBeNull();

    store(T0 - 2 * HOUR, { sampleRate: 0.2 });
    await expect(load().ready).resolves.toEqual({ sampleRate: 0.2 });
    expect(JSON.parse(storage.get(KEY) as string).fetchedAt).toBe(T0 - 2 * HOUR);
  });

  it("decides after 3 s without an answer; a later answer is still stored for the next sessions", async () => {
    vi.useFakeTimers();
    let respond: (res: Response) => void = () => {};
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          signal = init.signal ?? undefined;
          respond = resolve;
        }),
    );
    const settled = vi.fn();
    void load().ready.then(settled);

    await vi.advanceTimersByTimeAsync(REPLAY_CONFIG_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(null);

    clock = T0 + 5000;
    respond(answer({ config: { sampleRate: 1 } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.get(KEY) as string)).toEqual({ fetchedAt: T0 + 5000, config: { sampleRate: 1 } });
    expect(signal?.aborted).toBe(false);
  });

  it("aborts a request that never answers", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const ready = load().ready;
    await vi.advanceTimersByTimeAsync(REPLAY_CONFIG_ABORT_MS);
    expect(signal?.aborted).toBe(true);
    await expect(ready).resolves.toBeNull();
    expect(storage.get(KEY)).toBeNull();
  });

  it("a copy stamped in the future is no copy: neither fresh nor a fallback, and the answer replaces it", async () => {
    store(T0 + 60_000, { sampleRate: 1 });
    const result = load();
    expect(result.cached).toBeNull();
    expect(result.fetchedAt).toBeNull();
    expect(result.fresh).toBe(false);
    await expect(result.ready).resolves.toEqual({ sampleRate: 0.5 });
    expect(JSON.parse(storage.get(KEY) as string)).toEqual({ fetchedAt: T0, config: { sampleRate: 0.5 } });

    store(T0 + 60_000, { sampleRate: 1 });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(load().ready).resolves.toBeNull();
  });

  it("an answer never replaces a copy stored after its request began", async () => {
    let respond: (res: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const ready = load().ready;

    clock = T0 + 100;
    store(T0 + 100, { sampleRate: 0.9 });
    clock = T0 + 200;
    respond(answer({ config: { sampleRate: 0.1 } }));
    await expect(ready).resolves.toEqual({ sampleRate: 0.1 });
    expect(JSON.parse(storage.get(KEY) as string)).toEqual({ fetchedAt: T0 + 100, config: { sampleRate: 0.9 } });
  });

  it("a storage that throws counts as no copy and never makes ready reject", async () => {
    const broken: CohorlyStorage = {
      get: () => {
        throw new Error("SecurityError");
      },
      set: () => {
        throw new Error("SecurityError");
      },
      remove: () => {},
    };
    const result = load({ storage: broken });
    expect(result.cached).toBeNull();
    expect(result.fresh).toBe(false);
    await expect(result.ready).resolves.toEqual({ sampleRate: 0.5 });
  });

  it("a stored copy that is not valid JSON counts as no copy", async () => {
    storage.set(KEY, "{oops");
    const result = load();
    expect(result.cached).toBeNull();
    await expect(result.ready).resolves.toEqual({ sampleRate: 0.5 });
  });

  it("keeps only the three fields from the answer and from the stored copy", async () => {
    const forged = {
      sampleRate: 1,
      maskTextSelector: "",
      blockSelector: "",
      allowedIframeOrigins: ["*"],
      triggers: [{ kind: "url", pattern: "/*" }],
    };
    fetchMock.mockImplementation(async () => answer({ config: forged }));
    await expect(load().ready).resolves.toEqual({ sampleRate: 1 });
    expect(JSON.parse(storage.get(KEY) as string).config).toEqual({ sampleRate: 1 });

    store(T0, forged);
    expect(load().cached).toEqual({ sampleRate: 1 });
  });
});

describe("parseReplayConfig", () => {
  it("drops values that are not valid and clamps the minimum duration at 30 s", () => {
    expect(parseReplayConfig({ sampleRate: 0.001, onErrorSampleRate: 0, minDurationMs: 0 })).toEqual({
      sampleRate: 0.001,
      onErrorSampleRate: 0,
      minDurationMs: 0,
    });
    expect(parseReplayConfig({ sampleRate: 1.5, onErrorSampleRate: -0.1, minDurationMs: -1 })).toEqual({});
    expect(parseReplayConfig({ sampleRate: "1", onErrorSampleRate: Number.NaN, minDurationMs: Infinity })).toEqual({});
    expect(parseReplayConfig({ minDurationMs: 45_000 })).toEqual({ minDurationMs: 30_000 });
    expect(parseReplayConfig(null)).toBeNull();
    expect(parseReplayConfig([])).toBeNull();
    expect(parseReplayConfig("{}")).toBeNull();
  });
});

describe("the SDK's own requests", () => {
  it("count /replay/config as an SDK endpoint, so the network wrapper never records it", () => {
    expect(SDK_ENDPOINTS).toContain("/replay/config");
    expect(sdkRequestMatcher(API_HOST)(`${API_HOST}/replay/config?token=tok`)).toBe(true);
  });
});
