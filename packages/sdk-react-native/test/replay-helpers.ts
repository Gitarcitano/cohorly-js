import { vi } from "vitest";
import type { AppStateLike } from "../src/types.js";
import { FakeStorage } from "./helpers.js";

export type AnyEvent = { event: string; properties: Record<string, any> };

export interface RrEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export const meta = (timestamp: number): RrEvent => ({
  type: 4,
  timestamp,
  data: { width: 390, height: 844, href: "Home" },
});
export const full = (timestamp: number, label = "screen"): RrEvent => ({
  type: 2,
  timestamp,
  data: { wireframes: [{ id: 10000000, type: "text", text: label }], initialOffset: { top: 0, left: 0 } },
});
export const touch = (timestamp: number): RrEvent => ({
  type: 3,
  timestamp,
  data: { source: 2, type: 7, id: 0, x: 10, y: 20, pointerType: 2 },
});

/**
 * A linked `CohorlyReactNativeReplay`: `capture()` adds a batch the next
 * `replayDrain()` returns, like the native recorder's pending list.
 */
export function fakeReplayModule() {
  const pending: string[] = [];
  const mod = {
    replayStart: vi.fn(async (_configJson: string): Promise<boolean> => true),
    replayStop: vi.fn(async (): Promise<void> => {}),
    replayCheckout: vi.fn(async (): Promise<void> => {}),
    replayDrain: vi.fn(async (): Promise<string[]> => pending.splice(0)),
  };
  return {
    mod,
    capture: (...events: RrEvent[]) => {
      pending.push(JSON.stringify(events));
    },
    captureRaw: (batch: string) => {
      pending.push(batch);
    },
  };
}

export interface ReplayRequest {
  url: string;
  raw: string;
  headers: Record<string, string>;
  body: {
    session_id: string;
    distinct_id: string;
    seq: number;
    mode: "session" | "error";
    lib: string;
    lib_version: string;
    events: RrEvent[];
  };
}

/**
 * Fetch that records `/replay` posts (answered by `respond`, 200 by
 * default) and the events posted to `/track`.
 */
export function replayFetch(respond?: (n: number, request: ReplayRequest) => Response | Promise<Response>) {
  const replays: ReplayRequest[] = [];
  const tracked: AnyEvent[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/flags/evaluate") return new Response(JSON.stringify({ flags: {} }), { status: 200 });
    const raw = String(init?.body ?? "");
    if (path === "/replay") {
      const request: ReplayRequest = {
        url,
        raw,
        headers: { ...(init?.headers as Record<string, string>) },
        body: JSON.parse(raw),
      };
      replays.push(request);
      if (respond) return respond(replays.length, request);
      return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    }
    if (path === "/track") tracked.push(...(JSON.parse(raw) as AnyEvent[]));
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, replays, tracked };
}

export function fakeAppState(initial = "active") {
  const listeners: ((state: string) => void)[] = [];
  const appState: AppStateLike & { emit(state: string): void } = {
    currentState: initial,
    addEventListener: (_event: "change", cb: (state: string) => void) => {
      listeners.push(cb);
      return { remove: () => {} };
    },
    emit(state: string) {
      appState.currentState = state;
      for (const cb of listeners) cb(state);
    },
  };
  return appState;
}

/**
 * Lets every pending promise chain run (native calls, storage, fetch and
 * Response bodies). setImmediate is never faked in these tests.
 */
export async function settle(rounds = 15): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Fake timers that leave setImmediate, nextTick and microtasks real. */
export function useClock(now: number): void {
  vi.useFakeTimers({ now, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

/** Moves time forward and lets what it woke up finish. */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** Storage whose reads or writes of one key wait until `open()`. */
export class HeldStorage extends FakeStorage {
  private held: { key: string; kind: "get" | "set" } | null = null;
  private waiters: (() => void)[] = [];

  hold(key: string, kind: "get" | "set"): void {
    this.held = { key, kind };
  }

  open(): void {
    this.held = null;
    for (const resume of this.waiters.splice(0)) resume();
  }

  private wait(key: string, kind: "get" | "set"): Promise<void> {
    if (this.held?.key !== key || this.held.kind !== kind) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  override async getItem(key: string): Promise<string | null> {
    await this.wait(key, "get");
    return super.getItem(key);
  }

  override async setItem(key: string, value: string): Promise<void> {
    await this.wait(key, "set");
    return super.setItem(key, value);
  }
}

/** A promise and the function that resolves it. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Storage whose writes of one key hang while `stuck` is true, each until
 * `release()`, and land (in the order they were made) only then.
 */
export class StuckStorage extends FakeStorage {
  stuck = false;
  private hung: (() => void)[] = [];

  constructor(private readonly key: string) {
    super();
  }

  get hangingWrites(): number {
    return this.hung.length;
  }

  release(): void {
    for (const land of this.hung.splice(0)) land();
  }

  override async setItem(key: string, value: string): Promise<void> {
    if (key === this.key && this.stuck) await new Promise<void>((resolve) => this.hung.push(resolve));
    return super.setItem(key, value);
  }
}
