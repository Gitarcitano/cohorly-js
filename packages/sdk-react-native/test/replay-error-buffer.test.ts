import { describe, expect, it } from "vitest";
import { ERROR_BUFFER_MAX_BYTES, ErrorBuffer } from "../src/replay/error-buffer.js";
import { full, meta, type RrEvent, touch } from "./replay-helpers.js";

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const MB = 1024 * 1024;

function buffer() {
  const clock = { now: T0 };
  const b = new ErrorBuffer(() => clock.now);
  const push = (event: RrEvent) => b.push(event, JSON.stringify(event));
  return { b, clock, push };
}

const blob = (timestamp: number, size: number): RrEvent => ({ type: 3, timestamp, data: { source: 0, blob: "x".repeat(size) } });

describe("ErrorBuffer", () => {
  it("drops whole oldest segments past 10 MB and sends from the snapshot that remains", () => {
    const { b, clock, push } = buffer();
    push(meta(T0));
    push(full(T0));
    push(blob(T0 + 1, 6 * MB));
    clock.now = T0 + 10_000;
    push(meta(T0 + 10_000));
    push(full(T0 + 10_000));
    push(blob(T0 + 10_001, 6 * MB));
    expect(b.size).toBeLessThanOrEqual(ERROR_BUFFER_MAX_BYTES);
    clock.now = T0 + 20_000;
    const cut = b.cut();
    expect(cut.kind).toBe("events");
    if (cut.kind !== "events") return;
    expect(JSON.parse(cut.events[0].json)).toEqual(meta(T0 + 10_000));
    expect(cut.events).toHaveLength(3);
  });

  it("discards a single segment that grows past 10 MB, asks for a checkout, and buffers nothing until the next Meta", () => {
    const { b, clock, push } = buffer();
    push(meta(T0));
    push(full(T0));
    expect(push(blob(T0 + 1, 6 * MB))).toBe(false);
    expect(push(blob(T0 + 2, 6 * MB))).toBe(true);
    expect(b.size).toBe(0);
    expect(b.hasSnapshot()).toBe(false);
    // A mutation of the discarded screen is unusable on its own.
    push(touch(T0 + 3));
    expect(b.size).toBe(0);
    clock.now = T0 + 1000;
    push(meta(T0 + 1000));
    push(full(T0 + 1000));
    push(touch(T0 + 1001));
    clock.now = T0 + 2000;
    const cut = b.cut();
    expect(cut.kind === "events" && cut.events.map((e) => JSON.parse(e.json))).toEqual([
      meta(T0 + 1000),
      full(T0 + 1000),
      touch(T0 + 1001),
    ]);
  });

  it("counts UTF-8 bytes: multibyte text is bounded by its encoded size, before any checkout", () => {
    const { b, push } = buffer();
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes: 3 M of them are 6 MB.
    const accented = (timestamp: number): RrEvent => ({ type: 3, timestamp, data: { text: "é".repeat(3 * MB) } });
    push(meta(T0));
    push(full(T0));
    expect(push(accented(T0 + 1))).toBe(false);
    expect(b.size).toBeGreaterThan(6 * MB);
    // 12 MB of UTF-8 (6 M UTF-16 units): over the bound, so the segment goes.
    expect(push(accented(T0 + 2))).toBe(true);
    expect(b.size).toBeLessThanOrEqual(ERROR_BUFFER_MAX_BYTES);
  });

  it("needs a snapshot before anything can go, and sends nothing twice", () => {
    const { b, clock, push } = buffer();
    push(touch(T0)); // no snapshot yet: unusable
    expect(b.cut()).toEqual({ kind: "need-snapshot" });
    push(meta(T0));
    push(full(T0));
    push(touch(T0 + 1));
    clock.now = T0 + 2000;
    expect(b.cut().kind).toBe("events");
    // Nothing new since: a second error sends nothing.
    expect(b.cut()).toEqual({ kind: "nothing" });
  });
});
