import { describe, expect, it } from "vitest";
import { postWithRetry, type SendResult } from "../src/import-sender.js";
import { json } from "./import-fake.js";

const URL_ = "https://api.example.com/api/import/events?projectId=7";
const BODY = Buffer.from('[{"event":"A","properties":{"time":1700000000000,"distinct_id":"u"}}]');
const OK = { status: 1, received: 1, inserted: 1, duplicates: 0, refused: [] };

/** A fetch answering from a list (the last entry repeats), recording each call. */
function scripted(answers: Array<() => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return answers[Math.min(calls.length, answers.length) - 1]!();
  }) as typeof globalThis.fetch;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { deps: { fetch, sleep }, calls, sleeps };
}

const send = (s: ReturnType<typeof scripted>): Promise<SendResult> => postWithRetry({ url: URL_, token: "tok", body: BODY }, s.deps);

describe("postWithRetry", () => {
  it("POSTs the gzipped body with Bearer auth and JSON content type", async () => {
    const s = scripted([() => json(200, OK)]);
    const result = await send(s);
    expect(result).toEqual({ kind: "ok", status: 200, body: OK });
    const { url, init } = s.calls[0]!;
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer tok", "Content-Type": "application/json", "Content-Encoding": "gzip" });
  });

  it("waits Retry-After seconds on 429 and resends the same bytes", async () => {
    const s = scripted([() => json(429, { status: 0, error: "import busy" }, { "Retry-After": "1" }), () => json(200, OK)]);
    expect((await send(s)).kind).toBe("ok");
    expect(s.sleeps).toEqual([1000]);
    expect(s.calls).toHaveLength(2);
    expect(Buffer.from(s.calls[1]!.init.body as Uint8Array).equals(Buffer.from(s.calls[0]!.init.body as Uint8Array))).toBe(true);
  });

  it("uses each status's own Retry-After, and 1 s (429) or 5 s (503) without a valid one", async () => {
    const s = scripted([
      () => json(503, { error: "partitions busy" }, { "Retry-After": "7" }),
      () => json(503, { error: "partitions busy" }),
      () => json(429, { error: "import busy" }),
      () => json(429, { error: "import busy" }, { "Retry-After": "soon" }),
      () => json(429, { error: "import busy" }, { "Retry-After": "0" }),
      () => json(200, OK),
    ]);
    expect((await send(s)).kind).toBe("ok");
    expect(s.sleeps).toEqual([7000, 5000, 1000, 1000, 0]);
  });

  it("caps a huge or overflowing Retry-After at one day instead of letting the timer fire at once", async () => {
    const s = scripted([
      () => json(429, { error: "import busy" }, { "Retry-After": "99999999999999999999" }),
      () => json(429, { error: "import busy" }, { "Retry-After": "9".repeat(400) }),
      () => json(429, { error: "import busy" }, { "Retry-After": "86400" }),
      () => json(200, OK),
    ]);
    expect((await send(s)).kind).toBe("ok");
    expect(s.sleeps).toEqual([86_400_000, 86_400_000, 86_400_000]);
  });

  it("retries when the connection drops while the 200 answer is being read", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200 },
      );
    const s = scripted([broken, broken, () => json(200, OK)]);
    expect((await send(s)).kind).toBe("ok");
    expect(s.calls).toHaveLength(3);
    expect(s.sleeps).toEqual([1000, 2000]);
  });

  it("gives up after 100 waits in a row", async () => {
    const s = scripted([() => json(429, { error: "import busy" }, { "Retry-After": "1" })]);
    const result = await send(s);
    expect(result).toMatchObject({ kind: "failed", reason: "busy", status: 429 });
    expect((result as { message: string }).message).toContain("100 waits");
    expect(s.sleeps).toHaveLength(100);
    expect(s.calls).toHaveLength(101);
  });

  it("backs off 1, 2, 4 ... 60 s on 5xx and stops after 8 attempts", async () => {
    const s = scripted([() => json(500, { error: "boom" })]);
    const result = await send(s);
    expect(result).toMatchObject({ kind: "failed", reason: "server_error", status: 500 });
    expect((result as { message: string }).message).toContain("gave up after 8 attempts");
    expect(s.calls).toHaveLength(8);
    expect(s.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
  });

  it("treats a network error like a 5xx", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await postWithRetry(
      { url: URL_, token: "tok", body: BODY },
      {
        fetch: (async () => {
          calls++;
          throw new TypeError("fetch failed");
        }) as typeof globalThis.fetch,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toMatchObject({ kind: "failed", reason: "network", status: null });
    expect(calls).toBe(8);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
  });

  it("succeeds when a retry after a 502 succeeds", async () => {
    const s = scripted([() => new Response("bad gateway", { status: 502 }), () => json(200, OK)]);
    expect((await send(s)).kind).toBe("ok");
    expect(s.sleeps).toEqual([1000]);
  });

  it("returns too_large on 413 without retrying", async () => {
    const s = scripted([() => json(413, { status: 0, error: "payload too large" })]);
    expect(await send(s)).toEqual({ kind: "too_large" });
    expect(s.calls).toHaveLength(1);
  });

  it("stops at once on 401, 403, 400, other 4xx and a 200 without status 1", async () => {
    const cases: Array<[Response, string, string]> = [
      [json(401, { error: "unauthorized" }), "auth", "HTTP 401: unauthorized"],
      [json(403, { error: "forbidden" }), "auth", "HTTP 403: forbidden"],
      [json(400, { status: 0, error: "batch too large (max 5000)" }), "bad_request", "HTTP 400: batch too large (max 5000)"],
      [new Response("not here", { status: 404 }), "client_error", "HTTP 404: not here"],
      [json(200, { status: 0 }), "bad_response", 'without "status": 1'],
    ];
    for (const [res, reason, message] of cases) {
      const s = scripted([() => res]);
      const result = await send(s);
      expect(result).toMatchObject({ kind: "failed", reason });
      expect((result as { message: string }).message).toContain(message);
      expect(s.calls).toHaveLength(1);
      expect(s.sleeps).toEqual([]);
    }
  });
});
