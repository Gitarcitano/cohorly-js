import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleLevel } from "../src/console.js";
import { observeConsole } from "../src/console.js";

const LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error"];

describe("observeConsole", () => {
  const saved = {} as Record<ConsoleLevel, unknown>;
  const offs: (() => void)[] = [];
  const observe = (...args: Parameters<typeof observeConsole>) => {
    const off = observeConsole(...args);
    offs.push(off);
    return off;
  };

  beforeEach(() => {
    for (const level of LEVELS) {
      saved[level] = console[level];
      console[level] = vi.fn();
    }
  });

  afterEach(() => {
    for (const off of offs.splice(0)) off();
    for (const level of LEVELS) console[level] = saved[level] as never;
  });

  it("wraps a level with its first observer, once, and restores it with the last; other levels stay untouched", () => {
    const original = console.warn;
    const errorBefore = console.error;
    const logBefore = console.log;
    const first = observe({ levels: ["warn"], call: () => {} });
    const wrapped = console.warn;
    expect(wrapped).not.toBe(original);
    const second = observe({ levels: ["warn", "error"], call: () => {} });
    expect(console.warn).toBe(wrapped);
    expect(console.log).toBe(logBefore);

    first();
    expect(console.warn).toBe(wrapped);
    second();
    expect(console.warn).toBe(original);
    expect(console.error).toBe(errorBefore);
    second(); // a second unsubscribe is a no-op
    expect(console.warn).toBe(original);
  });

  it("calls the page's console with the same this and arguments, returns its result, after the observers", () => {
    const order: string[] = [];
    const original = vi.fn(function (this: unknown) {
      order.push("page");
      return "page-result";
    });
    console.info = original;
    const seen: unknown[][] = [];
    observe({
      levels: ["info"],
      call: (level, args) => {
        order.push(`observer:${level}`);
        seen.push([...args]);
      },
    });

    const target = { name: "custom this" };
    const payload = { id: 1 };
    const result = console.info.call(target, "hello", payload, 3);

    expect(result).toBe("page-result");
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]).toEqual(["hello", payload, 3]);
    expect(original.mock.calls[0][1]).toBe(payload);
    expect(original.mock.contexts[0]).toBe(target);
    expect(seen).toEqual([["hello", payload, 3]]);
    expect(order).toEqual(["observer:info", "page"]);
  });

  it("never throws into the page: an observer that throws skips nothing else", () => {
    const original = console.error as ReturnType<typeof vi.fn>;
    const after = vi.fn();
    observe({
      levels: ["error"],
      call: () => {
        throw new Error("observer blew up");
      },
    });
    observe({ levels: ["error"], call: after });

    expect(() => console.error("boom")).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith("boom");
  });

  it("an error thrown by the page's own console still reaches the caller", () => {
    const failure = new Error("page console failed");
    console.log = () => {
      throw failure;
    };
    observe({ levels: ["log"], call: () => {} });
    expect(() => console.log("x")).toThrow(failure);
  });

  it("a console call made while observers run reaches the page but is not dispatched again", () => {
    const page = console.warn as ReturnType<typeof vi.fn>;
    const calls: unknown[][] = [];
    observe({
      levels: ["warn", "log"],
      call: (_level, args) => {
        calls.push([...args]);
        console.warn("[cohorly] nested");
        console.log("nested log");
      },
    });

    console.warn("outer");
    expect(calls).toEqual([["outer"]]);
    expect(page.mock.calls).toEqual([["[cohorly] nested"], ["outer"]]);
    // Dispatching again once the outer call is done.
    console.log("next");
    expect(calls).toEqual([["outer"], ["next"]]);
  });

  it("leaves a wrapper installed by the page afterwards in place on unsubscribe", () => {
    const off = observe({ levels: ["log"], call: () => {} });
    const ours = console.log;
    const pageWrapper = (...args: unknown[]) => ours(...args);
    console.log = pageWrapper;
    off();
    expect(console.log).toBe(pageWrapper);
  });
  it("skips a read-only method and still wraps the others", () => {
    const info = console.info;
    const log = console.log;
    Object.defineProperty(console, "info", { value: info, writable: false, configurable: true });
    try {
      const calls: string[] = [];
      const off = observe({ levels: ["log", "info", "warn"], call: (level) => calls.push(level) });
      expect(console.info).toBe(info);
      console.log("a");
      console.warn("b");
      expect(calls).toEqual(["log", "warn"]);
      off();
      expect(console.log).toBe(log);
    } finally {
      Object.defineProperty(console, "info", { value: info, writable: true, configurable: true });
    }
  });
});
