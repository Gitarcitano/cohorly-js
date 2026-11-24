import type { CohorlyStorage } from "@cohorly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionReplayOptions } from "../src/index.js";
import { cohorly, init } from "../src/index.js";
import {
  CANVAS_BUDGET_KEY,
  canvasBudgetFull,
  canvasFilter,
  MAX_CANVAS_FRAME_CHARS,
  MAX_CANVAS_SESSION_CHARS,
  resetCanvasBudget,
} from "../src/replay/canvas.js";
import { MAX_CHUNK_BYTES, recordOptions } from "../src/replay/replay.js";
import { canvasSettings, SESSION_KEY } from "../src/replay/session.js";

// Canvas recording (VEL-2155). jsdom has no canvas: a stand-in for
// @rrweb/record hands the SDK the events the real one emits, and the real
// canvas pipeline (bitmap, worker, WebP) runs in the e2e and the bench.
const rr = vi.hoisted(() => {
  const state = { emit: null as null | ((e: unknown) => void), snapshots: 0, stops: 0 };
  const snapshot = () => {
    state.emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href } });
    state.emit?.({ type: 2, timestamp: Date.now(), data: { node: {} } });
    state.snapshots += 1;
  };
  const record = Object.assign(
    vi.fn((options: { emit: (e: unknown) => void }) => {
      state.emit = options.emit;
      snapshot();
      return () => {
        state.emit = null;
        state.stops += 1;
      };
    }),
    { takeFullSnapshot: () => snapshot() },
  );
  return { state, record };
});
vi.mock("@rrweb/record", () => ({ record: rr.record }));

const API_HOST = "https://ingest.example.com";
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const MiB = 1024 * 1024;

/** An rrweb CanvasMutation (per-frame mode) whose serialized JSON is exactly `chars` long. */
function frame(chars: number, id = 7) {
  const make = (base64: string) => ({
    type: 3,
    timestamp: T0,
    data: {
      source: 9,
      id,
      type: 0,
      commands: [
        { property: "clearRect", args: [0, 0, 800, 600] },
        {
          property: "drawImage",
          args: [
            { rr_type: "ImageBitmap", args: [{ rr_type: "Blob", data: [{ rr_type: "ArrayBuffer", base64 }], type: "image/webp" }] },
            0,
            0,
          ],
        },
      ],
    },
  });
  const overhead = JSON.stringify(make("")).length;
  return make("A".repeat(chars - overhead));
}

const jsonChars = (value: unknown) => JSON.stringify(value).length;
const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const meta = { type: 4, timestamp: T0, data: { href: "https://app.example.com/" } };
const interaction = { type: 3, timestamp: T0, data: { source: 2, type: 2, id: 1 } };

interface Node {
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: Node[];
  id?: number;
}

const canvasNode = (id: number, dataURL: string | null): Node => ({
  type: 2,
  tagName: "canvas",
  id,
  attributes: { width: "800", height: "600", class: "chart", ...(dataURL === null ? {} : { rr_dataURL: dataURL }) },
  childNodes: [],
});

const SMALL_URL = "data:image/webp;base64,AAAA";

/** A snapshot with canvases at the top (carrying `dataURL`), nested, and inside an iframe's document (small pixels), and one with none. */
function snapshotOf(dataURL: string) {
  const iframeDocument: Node = {
    type: 0,
    childNodes: [{ type: 2, tagName: "html", id: 40, attributes: {}, childNodes: [canvasNode(41, SMALL_URL)] }],
  };
  return {
    type: 2,
    timestamp: T0,
    data: {
      initialOffset: { left: 0, top: 0 },
      node: {
        type: 0,
        childNodes: [
          {
            type: 2,
            tagName: "html",
            id: 1,
            attributes: {},
            childNodes: [
              { type: 2, tagName: "p", id: 2, attributes: { class: "keep" }, childNodes: [{ type: 3, id: 3, textContent: "Visible text" }] },
              canvasNode(10, dataURL),
              { type: 2, tagName: "div", id: 20, attributes: {}, childNodes: [{ type: 2, tagName: "section", id: 21, attributes: {}, childNodes: [canvasNode(22, SMALL_URL)] }] },
              { type: 2, tagName: "iframe", id: 30, attributes: {}, childNodes: [iframeDocument] },
              canvasNode(50, null),
            ],
          },
        ],
      },
    },
  };
}

const canvases = (node: Node): Node[] => [
  ...(node.tagName === "canvas" ? [node] : []),
  ...(node.childNodes ?? []).flatMap(canvases),
];

describe("sessionReplay.canvas options (C1)", () => {
  const keys = ["recordCanvas", "sampling", "dataURLOptions"];

  it("adds the three rrweb keys only when canvas is an object", () => {
    for (const canvas of [undefined, null, false, true, 1, "yes", ["fps"]]) {
      const options = recordOptions({ sampleRate: 1, canvas } as unknown as SessionReplayOptions);
      for (const key of keys) expect(key in options).toBe(false);
    }
    expect(recordOptions({ sampleRate: 1 })).not.toHaveProperty("recordCanvas");
  });

  it("canvas: {} turns it on with 2 fps and quality 0.4, and keeps the existing keys", () => {
    const off = recordOptions({ sampleRate: 1, blockSelector: ".b", maskTextSelector: ".m" });
    const on = recordOptions({ sampleRate: 1, blockSelector: ".b", maskTextSelector: ".m", canvas: {} });
    expect(on).toMatchObject({
      recordCanvas: true,
      sampling: { canvas: 2 },
      dataURLOptions: { type: "image/webp", quality: 0.4 },
    });
    for (const key of ["maskInputOptions", "maskTextSelector", "blockSelector"]) expect(on[key]).toEqual(off[key]);
  });

  it("takes fps and quality as given inside the range", () => {
    expect(recordOptions({ canvas: { fps: 5, quality: 0.8 } })).toMatchObject({
      sampling: { canvas: 5 },
      dataURLOptions: { quality: 0.8 },
    });
  });

  it("clamps out of range values and falls back to the default for anything that is not a finite number", () => {
    const fps = (value: unknown) => canvasSettings({ fps: value })?.fps;
    const quality = (value: unknown) => canvasSettings({ quality: value })?.quality;
    expect([fps(0), fps(-4), fps(99), fps(12), fps(1)]).toEqual([1, 1, 12, 12, 1]);
    expect([fps(Number.NaN), fps("3"), fps(Number.POSITIVE_INFINITY), fps(null), fps(undefined)]).toEqual([2, 2, 2, 2, 2]);
    expect([quality(0.01), quality(0), quality(5), quality(1), quality(0.1)]).toEqual([0.1, 0.1, 1, 1, 0.1]);
    expect([quality(Number.NaN), quality("0.9"), quality(Number.NEGATIVE_INFINITY)]).toEqual([0.4, 0.4, 0.4]);
  });
});

describe("canvas frame limits (C2, C3, C6)", () => {
  const log = vi.fn();
  beforeEach(() => {
    resetCanvasBudget();
    log.mockClear();
  });

  it("keeps a frame of exactly 400000 characters and drops one of 400001", () => {
    const filter = canvasFilter(log);
    const exact = frame(400_000);
    expect(jsonChars(exact)).toBe(400_000);
    expect(filter(exact)).toBe(exact);
    expect(filter(frame(400_001))).toBeNull();
    expect(MAX_CANVAS_FRAME_CHARS).toBe(400_000);
  });

  it("stops at 64 MiB, says so once, and once a frame was refused for it takes no other", () => {
    const filter = canvasFilter(log);
    expect(MAX_CANVAS_SESSION_CHARS).toBe(64 * MiB);
    // 64 MiB = 167 x 400000 + 308864.
    for (let i = 0; i < 167; i += 1) expect(filter(frame(400_000))).not.toBeNull();
    expect(filter(frame(400_000))).toBeNull();
    expect(filter(frame(399_999))).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("canvas");
    // The budget is spent (the recorder restarts without canvas): even a frame that would fit what is left goes.
    expect(filter(frame(64 * MiB - 167 * 400_000))).toBeNull();
    expect(filter(frame(10_000))).toBeNull();
    // Events that are not canvas frames carry on.
    for (const event of [interaction, meta, { type: 5, timestamp: T0, data: { tag: "$network", payload: {} } }]) {
      expect(filter(event)).toBe(event);
    }
  });

  it("a frame dropped for its size does not use the page budget", () => {
    const filter = canvasFilter(log);
    for (let i = 0; i < 300; i += 1) expect(filter(frame(500_000))).toBeNull();
    for (let i = 0; i < 167; i += 1) expect(filter(frame(400_000))).not.toBeNull();
    expect(filter(frame(400_000))).toBeNull();
  });

  it("with budget off (error mode) frames are size-checked but never counted", () => {
    const filter = canvasFilter(log);
    for (let i = 0; i < 200; i += 1) expect(filter(frame(400_000), { budget: false })).not.toBeNull();
    expect(filter(frame(400_001), { budget: false })).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(filter(frame(400_000))).not.toBeNull();
  });

  it("keeps the budget across recorders of the page (restart)", () => {
    const first = canvasFilter(log);
    for (let i = 0; i < 167; i += 1) first(frame(400_000));
    const second = canvasFilter(log);
    expect(second(frame(400_000))).toBeNull();
  });

  it("filters without any canvas option, and leaves other events as the very same object", () => {
    const filter = canvasFilter(log);
    const events = [
      meta,
      { type: 2, timestamp: T0, data: { node: {} } },
      interaction,
      { type: 3, timestamp: T0, data: { source: 8, id: 1 } },
      { type: 3, timestamp: T0, data: undefined },
    ];
    for (const event of events) expect(filter(event)).toBe(event);
    expect(filter(frame(500_000))).toBeNull();
  });
});

/** sessionStorage as the SDK sees it (storage.ts), in memory; `broken` throws on every call. */
function memoryStorage(broken = false): CohorlyStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const check = () => {
    if (broken) throw new DOMException("blocked", "SecurityError");
  };
  return {
    data,
    get: (key) => {
      check();
      return data.get(key) ?? null;
    },
    set: (key, value) => {
      check();
      data.set(key, value);
    },
    remove: (key) => {
      check();
      data.delete(key);
    },
  };
}

describe("canvas budget per session, across page loads (VEL-2176)", () => {
  const log = vi.fn();
  beforeEach(() => {
    resetCanvasBudget();
    log.mockClear();
  });

  /** Frames of 400000 characters offered to `filter` until one is refused; the characters it kept. */
  function fill(filter: ReturnType<typeof canvasFilter>, sessionId: string, max: number): number {
    let kept = 0;
    for (let i = 0; i < max; i += 1) {
      const f = frame(400_000);
      if (filter(f, { sessionId }) === null) break;
      kept += jsonChars(f);
    }
    return kept;
  }

  it("never keeps more than 64 MiB in a session, summing its page loads and recorders (C1)", () => {
    const storage = memoryStorage();
    const onCeiling = vi.fn();
    // First page load: 100 frames.
    const first = canvasFilter(log, { storage, onCeiling });
    let kept = fill(first, "s1", 100);
    expect(kept).toBe(100 * 400_000);
    // A reload: a new module state (memory forgotten) and a new recorder, the same session in sessionStorage.
    resetCanvasBudget();
    const second = canvasFilter(log, { storage, onCeiling });
    kept += fill(second, "s1", 1000);
    // 64 MiB = 167 x 400000 + 308864: the 168th frame of the session is the one refused.
    expect(kept).toBe(167 * 400_000);
    expect(kept).toBeLessThanOrEqual(MAX_CANVAS_SESSION_CHARS);
    expect(onCeiling).toHaveBeenCalledWith("s1");
    // A third load of the session starts full: no frame at all, and the recorder knows before asking rrweb.
    resetCanvasBudget();
    expect(canvasBudgetFull(storage, "s1")).toBe(true);
    const third = canvasFilter(log, { storage, onCeiling });
    expect(third(frame(1000), { sessionId: "s1" })).toBeNull();
    expect(JSON.parse(storage.data.get(CANVAS_BUDGET_KEY) as string)).toEqual({ id: "s1", chars: 167 * 400_000, full: true });
  });

  it("a new session starts from zero, and its count replaces the old one in sessionStorage (C2)", () => {
    const storage = memoryStorage();
    const filter = canvasFilter(log, { storage });
    fill(filter, "s1", 1000);
    expect(canvasBudgetFull(storage, "s1")).toBe(true);
    expect(canvasBudgetFull(storage, "s2")).toBe(false);
    resetCanvasBudget();
    const next = canvasFilter(log, { storage });
    expect(fill(next, "s2", 1000)).toBe(167 * 400_000);
    expect(JSON.parse(storage.data.get(CANVAS_BUDGET_KEY) as string)).toMatchObject({ id: "s2" });
  });

  it("without sessionStorage (every call throws) it counts in memory for the page load and never throws (C3)", () => {
    const storage = memoryStorage(true);
    const filter = canvasFilter(log, { storage });
    expect(() => fill(filter, "s1", 1000)).not.toThrow();
    expect(filter(frame(1000), { sessionId: "s1" })).toBeNull();
    // A recorder restart on the same page keeps the memory count...
    expect(canvasFilter(log, { storage })(frame(1000), { sessionId: "s1" })).toBeNull();
    expect(canvasBudgetFull(storage, "s1")).toBe(true);
    // ...and a new page load starts over, as before VEL-2176.
    resetCanvasBudget();
    expect(fill(canvasFilter(log, { storage }), "s1", 1000)).toBe(167 * 400_000);
  });

  it("error mode (budget off) still counts nothing in sessionStorage (C4)", () => {
    const storage = memoryStorage();
    const filter = canvasFilter(log, { storage });
    for (let i = 0; i < 200; i += 1) expect(filter(frame(400_000), { sessionId: "s1", budget: false })).not.toBeNull();
    expect(storage.data.has(CANVAS_BUDGET_KEY)).toBe(false);
  });
});

/** A snapshot with three canvases of the given pixel lengths and a paragraph of `textChars` characters. */
function threeCanvases(pixels: [number, number, number], textChars = 0) {
  return {
    type: 2,
    timestamp: T0,
    data: {
      node: {
        type: 0,
        childNodes: [
          {
            type: 2,
            tagName: "html",
            id: 1,
            attributes: {},
            childNodes: [
              { type: 2, tagName: "p", id: 2, attributes: {}, childNodes: [{ type: 3, id: 3, textContent: "t".repeat(textChars) }] },
              canvasNode(10, `data:image/webp;base64,${"S".repeat(pixels[0])}`),
              { type: 2, tagName: "div", id: 20, attributes: {}, childNodes: [canvasNode(22, `data:image/webp;base64,${"L".repeat(pixels[1])}`)] },
              canvasNode(30, `data:image/webp;base64,${"M".repeat(pixels[2])}`),
            ],
          },
        ],
      },
    },
  };
}

/** Ids of the canvases that still carry rr_dataURL. */
const withPixels = (node: Node) => canvases(node).filter((n) => "rr_dataURL" in (n.attributes ?? {})).map((n) => n.id);

describe("largest canvas pixels go first, only until the event fits (C5)", () => {
  /** What enqueue counts for a Meta and a FullSnapshot kept in one chunk. */
  const unitBytes = (snapshot: unknown) => 2 + (utf8(meta) + 1) + (utf8(snapshot) + 1);

  it("drops only the largest canvas when that is enough; the two smaller keep theirs", () => {
    const filter = canvasFilter(vi.fn());
    filter(meta);
    // Small (id 10), large (22), medium (30).
    const big = threeCanvases([1000, 700_000, 300_000]);
    expect(unitBytes(big)).toBeGreaterThan(MAX_CHUNK_BYTES);
    const before = JSON.stringify(big);
    const out = filter(big) as typeof big;
    expect(out).not.toBe(big);
    expect(withPixels(out.data.node as Node)).toEqual([10, 30]);
    expect(unitBytes(out)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    expect(JSON.stringify(big)).toBe(before);
    expect(withPixels(big.data.node as Node)).toEqual([10, 22, 30]);
  });

  it("drops the second largest too when the largest is not enough; the smallest stays", () => {
    const filter = canvasFilter(vi.fn());
    filter(meta);
    // 850000 of text: without the largest it is still over, without the two largest it fits.
    const big = threeCanvases([1000, 200_000, 150_000], 850_000);
    expect(unitBytes(big)).toBeGreaterThan(MAX_CHUNK_BYTES);
    const out = filter(big) as typeof big;
    expect(withPixels(out.data.node as Node)).toEqual([10]);
    expect(unitBytes(out)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    expect(withPixels(big.data.node as Node)).toEqual([10, 22, 30]);
  });

  it("an event that fits is the same object", () => {
    const filter = canvasFilter(vi.fn());
    filter(meta);
    const small = threeCanvases([1000, 2000, 3000]);
    expect(filter(small)).toBe(small);
  });

  it("the same in a DOM mutation that adds several canvases", () => {
    const filter = canvasFilter(vi.fn());
    const mutation = {
      type: 3,
      timestamp: T0,
      data: {
        source: 0,
        texts: [],
        attributes: [],
        removes: [],
        adds: [
          { parentId: 1, nextId: null, node: canvasNode(60, `data:image/webp;base64,${"S".repeat(1000)}`) },
          { parentId: 1, nextId: null, node: canvasNode(61, `data:image/webp;base64,${"L".repeat(700_000)}`) },
          { parentId: 1, nextId: null, node: canvasNode(62, `data:image/webp;base64,${"M".repeat(300_000)}`) },
        ],
      },
    };
    const before = JSON.stringify(mutation);
    const out = filter(mutation) as typeof mutation;
    expect(out.data.adds.map((a) => "rr_dataURL" in (a.node.attributes ?? {}))).toEqual([true, false, true]);
    expect(out.data.adds[0]).toBe(mutation.data.adds[0]);
    expect(Buffer.byteLength(JSON.stringify(out)) + 3).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    expect(JSON.stringify(mutation)).toBe(before);
  });
});

describe("full snapshot over the chunk limit (C4)", () => {
  /** What enqueue (replay.ts) counts for a Meta and a FullSnapshot kept in one chunk: 2 brackets, 1 comma per event. */
  const unitBytes = (snapshot: unknown) => 2 + (utf8(meta) + 1) + (utf8(snapshot) + 1);
  /** A dataURL length that makes the Meta + snapshot unit exactly `total` bytes. */
  function dataUrlFor(total: number): string {
    return "x".repeat(total - unitBytes(snapshotOf("")));
  }

  it("a snapshot that fits comes back untouched, the same object, canvases included", () => {
    const filter = canvasFilter(vi.fn());
    filter(meta);
    const small = snapshotOf("data:image/webp;base64,AAAA");
    expect(filter(small)).toBe(small);
    const exact = snapshotOf(dataUrlFor(MAX_CHUNK_BYTES));
    expect(unitBytes(exact)).toBe(MAX_CHUNK_BYTES);
    expect(filter(exact)).toBe(exact);
  });

  it("one byte over drops rr_dataURL from the largest canvas only, and keeps the rest", () => {
    const filter = canvasFilter(vi.fn());
    filter(meta);
    const big = snapshotOf(dataUrlFor(MAX_CHUNK_BYTES + 1));
    const out = filter(big);
    expect(out).not.toBe(big);
    // Parseable, and everything but the large pixels is as it was (the nested and the iframe's small ones too).
    const parsed = JSON.parse(JSON.stringify(out)) as typeof big;
    expect(withPixels(parsed.data.node as Node)).toEqual([22, 41]);
    const found = canvases(parsed.data.node as Node);
    expect(found.map((n) => n.id)).toEqual([10, 22, 41, 50]);
    for (const node of found) expect(node.attributes).toMatchObject({ width: "800", height: "600", class: "chart" });
    expect(JSON.stringify(parsed.data.node)).toContain("Visible text");
    expect(parsed.data.initialOffset).toEqual({ left: 0, top: 0 });
    expect(parsed.timestamp).toBe(T0);
    expect(unitBytes(out)).toBeLessThan(MAX_CHUNK_BYTES);
  });

  it("never mutates the object rrweb handed over", () => {
    const filter = canvasFilter(vi.fn());
    filter(meta);
    const big = snapshotOf(dataUrlFor(MAX_CHUNK_BYTES + 10));
    const before = JSON.stringify(big);
    filter(big);
    expect(JSON.stringify(big)).toBe(before);
    expect(canvases(big.data.node as Node).filter((n) => "rr_dataURL" in (n.attributes ?? {}))).toHaveLength(3);
  });

  it("counts UTF-8 bytes, not characters", () => {
    const filter = canvasFilter(vi.fn());
    filter(meta);
    // Under the limit in characters, over it in bytes.
    const wide = snapshotOf("é".repeat(499_400));
    expect(jsonChars(wide)).toBeLessThan(MAX_CHUNK_BYTES);
    expect(utf8(wide)).toBeGreaterThan(MAX_CHUNK_BYTES);
    const out = filter(wide) as typeof wide;
    expect(withPixels(out.data.node as Node)).toEqual([22, 41]);
  });

  it("counts the Meta that came before it", () => {
    const filter = canvasFilter(vi.fn());
    const snapshot = snapshotOf(dataUrlFor(MAX_CHUNK_BYTES));
    // Alone it fits (as if no Meta preceded it)...
    expect(filter(snapshot)).toBe(snapshot);
    // ...with a Meta of any size in front it does not.
    filter({ type: 4, timestamp: T0, data: { href: `https://app.example.com/${"p".repeat(100)}` } });
    expect(filter(snapshot)).not.toBe(snapshot);
  });

  it("a snapshot without canvas is returned as is, however large", () => {
    const filter = canvasFilter(vi.fn());
    filter(meta);
    const dom = { type: 2, timestamp: T0, data: { node: { type: 2, tagName: "p", attributes: { title: "z".repeat(MAX_CHUNK_BYTES) }, childNodes: [] } } };
    expect(filter(dom)).toBe(dom);
  });
});

describe("canvas added by a DOM mutation, and the pixels gate", () => {
  const addCanvas = (dataURL: string) => ({
    type: 3,
    timestamp: T0,
    data: {
      source: 0,
      texts: [],
      attributes: [],
      removes: [],
      adds: [
        { parentId: 1, nextId: null, node: canvasNode(60, dataURL) },
        { parentId: 1, nextId: null, node: { type: 2, tagName: "p", id: 61, attributes: {}, childNodes: [] } },
      ],
    },
  });
  type Mutation = ReturnType<typeof addCanvas>;

  it("one that fits comes back as is; one over the limit loses the pixels and keeps the rest", () => {
    const filter = canvasFilter(vi.fn());
    const small = addCanvas("data:image/webp;base64,AAAA");
    expect(filter(small)).toBe(small);
    const big = addCanvas(`data:image/webp;base64,${"B".repeat(MAX_CHUNK_BYTES)}`);
    const before = JSON.stringify(big);
    const out = filter(big) as Mutation;
    expect(out).not.toBe(big);
    expect(JSON.stringify(out)).not.toContain("rr_dataURL");
    expect(out.data.adds.map((a) => (a.node as Node).id)).toEqual([60, 61]);
    expect((out.data.adds[0].node as Node).attributes).toMatchObject({ width: "800", height: "600" });
    expect(JSON.stringify(big)).toBe(before);
    expect(Buffer.byteLength(JSON.stringify(out)) + 3).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
  });

  it("with pixels off (a page with no canvas option and nothing from a child) nothing is inspected", () => {
    const filter = canvasFilter(vi.fn());
    const big = addCanvas(`data:image/webp;base64,${"B".repeat(MAX_CHUNK_BYTES)}`);
    expect(filter(big, { pixels: false })).toBe(big);
    const snapshot = snapshotOf(`data:image/webp;base64,${"B".repeat(MAX_CHUNK_BYTES)}`);
    expect(filter(snapshot, { pixels: false })).toBe(snapshot);
  });
});

describe("through the SDK", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function start(sessionReplay: SessionReplayOptions, debug = false) {
    init({ apiHost: API_HOST, token: "tok", loadFeatureFlags: false, flushIntervalMs: 0, debug, sessionReplay });
  }
  async function recording() {
    await vi.waitFor(() => expect(rr.record).toHaveBeenCalledTimes(1));
  }
  const emit = (event: unknown) => rr.state.emit?.(event);
  const sent = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith(`${API_HOST}/replay`))
      .map(([, req]) => String((req as { body: string }).body));
  const sentEvents = () =>
    sent().flatMap((body) => (JSON.parse(body) as { events: { type: number; data?: { source?: number } }[] }).events);

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    rr.record.mockClear();
    rr.state.snapshots = 0;
    rr.state.stops = 0;
    resetCanvasBudget();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("CompressionStream", undefined);
    fetchMock = vi.fn(async () => new Response('{"status":1}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cohorly.optOutTracking();
    init({ apiHost: API_HOST, loadFeatureFlags: false, flushIntervalMs: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hands rrweb the canvas options only when the option is on", async () => {
    start({ sampleRate: 1, canvas: { fps: 4 } });
    await recording();
    expect(rr.record.mock.calls[0][0]).toMatchObject({
      recordCanvas: true,
      sampling: { canvas: 4 },
      dataURLOptions: { type: "image/webp", quality: 0.4 },
    });
  });

  it("drops an oversized frame and sends the rest of the chunk, canvas option on or off (C2, C6)", async () => {
    for (const canvas of [undefined, {}]) {
      rr.record.mockClear();
      fetchMock.mockClear();
      window.sessionStorage.clear();
      start({ sampleRate: 1, canvas });
      await recording();
      emit(interaction);
      emit(frame(400_001, 99));
      emit(frame(400_000, 7));
      emit({ ...interaction, data: { source: 2, type: 2, id: 2 } });
      await vi.advanceTimersByTimeAsync(5000);
      const events = sentEvents();
      expect(events.filter((e) => e.data?.source === 9)).toHaveLength(1);
      expect(events.map((e) => e.type)).toEqual([4, 2, 3, 3, 3]);
      expect(sent().join("")).not.toContain('"source":9,"id":99');
      expect(sent().join("")).toContain('"source":9,"id":7');
    }
  });

  it("past 64 MiB later frames are dropped, the rest keeps flowing, and the log is a single line (C3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    start({ sampleRate: 1, canvas: {} }, true);
    await recording();
    const kept = Math.floor((64 * MiB) / 399_000);
    let delivered = 0;
    // A few frames per flush, like a real canvas: the 5 MB outbox bound never has to drop anything.
    for (let sentFrames = 0; sentFrames < kept + 20; sentFrames += 3) {
      for (let i = 0; i < 3; i += 1) emit(frame(399_000, 7));
      emit(interaction);
      await vi.advanceTimersByTimeAsync(5000);
      delivered = sentEvents().filter((e) => e.data?.source === 9).length;
    }
    expect(delivered).toBe(kept);
    expect(sentEvents().filter((e) => e.type === 3 && e.data?.source === 2).length).toBeGreaterThanOrEqual((kept + 20) / 3);
    expect(warn.mock.calls.filter((args) => String(args[1]).includes("64 MiB"))).toHaveLength(1);
  });

  it("a snapshot over the limit goes out without its canvas pixels and its chunk is accepted whole, in session and error mode (C4)", async () => {
    for (const mode of ["session", "error"] as const) {
      rr.record.mockClear();
      fetchMock.mockClear();
      window.sessionStorage.clear();
      start(mode === "session" ? { sampleRate: 1, canvas: {} } : { sampleRate: 0, onErrorSampleRate: 1, canvas: {} });
      await recording();
      const snapshot = snapshotOf(`data:image/webp;base64,${"B".repeat(1_300_000)}`);
      const before = JSON.stringify(snapshot);
      emit(meta);
      emit(snapshot);
      emit(interaction);
      if (mode === "session") {
        await vi.advanceTimersByTimeAsync(5000);
      } else {
        vi.advanceTimersByTime(31_000);
        cohorly.captureException(new Error("boom"));
        await vi.advanceTimersByTimeAsync(0);
      }
      const bodies = sent();
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(Buffer.byteLength(body)).toBeLessThan(1_000_000);
        expect(body).not.toContain("BBBB");
      }
      // Only the large canvas lost its pixels.
      expect(bodies.join("")).toContain(SMALL_URL);
      expect(bodies.join("")).toContain("Visible text");
      expect(JSON.stringify(snapshot)).toBe(before);
    }
  });

  it("no chunk passes the limit and no kept event is lost with many frames near the frame ceiling (C5)", async () => {
    start({ sampleRate: 1, canvas: {} });
    await recording();
    let emitted = 0;
    for (let round = 0; round < 20; round += 1) {
      for (let i = 0; i < 3; i += 1) {
        emit(frame(399_000 + i, 7));
        emitted += 1;
      }
      await vi.advanceTimersByTimeAsync(5000);
    }
    const bodies = sent();
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) {
      const chunk = JSON.parse(body) as { events: unknown[] };
      expect(Buffer.byteLength(JSON.stringify(chunk.events))).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(Buffer.byteLength(body)).toBeLessThan(1_000_000);
    }
    expect(sentEvents().filter((e) => e.data?.source === 9)).toHaveLength(emitted);
  });

  const sessionId = () => (JSON.parse(window.sessionStorage.getItem(SESSION_KEY) as string) as { id: string }).id;
  /** The session's canvas budget, as an earlier page load of it would have left it. */
  const spendBudget = (chars: number, full = false) =>
    window.sessionStorage.setItem(CANVAS_BUDGET_KEY, JSON.stringify({ id: sessionId(), chars, full }));
  const recordCalls = () => rr.record.mock.calls.map(([options]) => options as Record<string, unknown>);

  it("past the session budget the recorder restarts once without canvas, keeps recording the DOM, and a reload starts without canvas (C8)", async () => {
    start({ sampleRate: 1, canvas: {} });
    await recording();
    expect(recordCalls()[0]).toMatchObject({ recordCanvas: true, sampling: { canvas: 2 } });
    const id = sessionId();
    spendBudget(MAX_CANVAS_SESSION_CHARS - 50_000);
    emit(interaction);
    emit(frame(40_000));
    emit(frame(40_000)); // over the ceiling
    emit(frame(40_000)); // still over: no second restart
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(rr.record).toHaveBeenCalledTimes(2));
    const restarted = recordCalls()[1];
    for (const key of ["recordCanvas", "sampling", "dataURLOptions"]) expect(key in restarted).toBe(false);
    expect(restarted).toHaveProperty("maskInputOptions");
    expect(rr.state.stops).toBe(1);
    // The new recorder keeps the DOM coming, same session; frames that still arrive (a child iframe) are dropped.
    emit({ ...interaction, data: { source: 2, type: 2, id: 9 } });
    emit(frame(40_000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionId()).toBe(id);
    const events = sentEvents();
    // What was pending went out (the interaction and the frame that fit), then the restart's snapshot.
    expect(events.map((e) => [e.type, e.data?.source])).toEqual([
      [4, undefined],
      [2, undefined],
      [3, 2],
      [3, 9],
      [4, undefined],
      [2, undefined],
      [3, 2],
    ]);
    expect(rr.record).toHaveBeenCalledTimes(2);
    // A later page load of this session (memory gone, sessionStorage kept) asks rrweb for no canvas from the start.
    resetCanvasBudget();
    start({ sampleRate: 1, canvas: {} });
    await vi.waitFor(() => expect(rr.record).toHaveBeenCalledTimes(3));
    expect(sessionId()).toBe(id);
    expect("recordCanvas" in recordCalls()[2]).toBe(false);
    emit(frame(40_000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(rr.record).toHaveBeenCalledTimes(3);
  });

  it("a session not at the ceiling asks rrweb for canvas on a reload, and a new session starts from zero (C8, C2)", async () => {
    start({ sampleRate: 1, canvas: {} });
    await recording();
    spendBudget(MAX_CANVAS_SESSION_CHARS - 50_000);
    resetCanvasBudget();
    start({ sampleRate: 1, canvas: {} });
    await vi.waitFor(() => expect(rr.record).toHaveBeenCalledTimes(2));
    expect(recordCalls()[1]).toMatchObject({ recordCanvas: true });
    // Full, but for another session: this one records canvas.
    window.sessionStorage.setItem(CANVAS_BUDGET_KEY, JSON.stringify({ id: "older-session", chars: MAX_CANVAS_SESSION_CHARS, full: true }));
    resetCanvasBudget();
    start({ sampleRate: 1, canvas: {} });
    await vi.waitFor(() => expect(rr.record).toHaveBeenCalledTimes(3));
    expect(recordCalls()[2]).toMatchObject({ recordCanvas: true });
  });

  it("frames from a child iframe still count, but a parent that records no canvas is never restarted for them (C9)", async () => {
    start({ sampleRate: 1 });
    await recording();
    spendBudget(MAX_CANVAS_SESSION_CHARS - 50_000);
    emit(frame(40_000));
    emit(frame(40_000)); // over the ceiling: dropped
    emit(interaction);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rr.record).toHaveBeenCalledTimes(1);
    expect(rr.state.stops).toBe(0);
    expect(sentEvents().filter((e) => e.data?.source === 9)).toHaveLength(1);
  });

  it("error mode counts nothing and never restarts for canvas (C4)", async () => {
    start({ sampleRate: 0, onErrorSampleRate: 1, canvas: {} });
    await recording();
    spendBudget(MAX_CANVAS_SESSION_CHARS, true);
    for (let i = 0; i < 5; i += 1) emit(frame(40_000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(rr.record).toHaveBeenCalledTimes(1);
    expect(recordCalls()[0]).toMatchObject({ recordCanvas: true });
  });

  it("a canvas frame is activity for the error buffer: it earns the next checkout, silence does not (C7)", async () => {
    start({ sampleRate: 0, onErrorSampleRate: 1 });
    await recording();
    expect(rr.state.snapshots).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rr.state.snapshots).toBe(1);

    emit(frame(50_000));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rr.state.snapshots).toBe(2);
  });

  it("canvas frames alone never keep a session alive: it expires after 30 minutes of no interaction (C7)", async () => {
    start({ sampleRate: 1, canvas: {} });
    await recording();
    for (let minute = 0; minute < 31; minute += 1) {
      emit(frame(10_000));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(rr.state.stops).toBe(1);
  });

  it("an interaction every few minutes does keep it alive (the same loop, so the expiry above is the canvas frames' doing)", async () => {
    start({ sampleRate: 1, canvas: {} });
    await recording();
    for (let minute = 0; minute < 31; minute += 1) {
      emit(frame(10_000));
      if (minute % 10 === 0) emit(interaction);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(rr.state.stops).toBe(0);
  });

  it("error mode frames do not use the page budget, since most never leave the page (C3)", async () => {
    start({ sampleRate: 0, onErrorSampleRate: 1, canvas: {} });
    await recording();
    for (let i = 0; i < 170; i += 1) emit(frame(399_000));
    expect(window.sessionStorage.getItem(CANVAS_BUDGET_KEY)).toBeNull();
    expect(canvasFilter(vi.fn())(frame(400_000), { sessionId: sessionId() })).not.toBeNull();
  });

  it("a page that does not record canvas never has its snapshots touched (pixels are only looked for when the option is on)", async () => {
    start({ sampleRate: 1 });
    await recording();
    emit(meta);
    emit(snapshotOf(`data:image/webp;base64,${"B".repeat(1_300_000)}`));
    emit(interaction);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent().join("")).toContain("rr_dataURL");
  });

  it("a canvas added over the limit by a mutation goes out without its pixels and the chunk is accepted whole", async () => {
    start({ sampleRate: 1, canvas: {} });
    await recording();
    emit({
      type: 3,
      timestamp: T0,
      data: { source: 0, texts: [], attributes: [], removes: [], adds: [{ parentId: 1, nextId: null, node: canvasNode(60, `data:image/webp;base64,${"B".repeat(1_100_000)}`) }] },
    });
    emit(interaction);
    await vi.advanceTimersByTimeAsync(5000);
    const bodies = sent();
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(Buffer.byteLength(body)).toBeLessThan(1_000_000);
      expect(body).not.toContain("rr_dataURL");
    }
    expect(bodies.join("")).toContain('"id":60');
  });
});
