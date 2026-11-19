import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservedRequest } from "../src/network.js";
import { observeNetwork } from "../src/network.js";
import { MAX_BODY_BYTES } from "../src/network-capture.js";
import type { NetworkPayload } from "../src/replay/network-record.js";
import { MAX_DETAIL_BYTES, networkRecorder } from "../src/replay/network-record.js";
import type { SessionReplayNetworkOptions } from "../src/replay/session.js";

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
const API = "https://api.example.com";
const encoder = new TextEncoder();

/** Lets the SDK's reads of response clones finish (setImmediate is not faked here). */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A body that sends `first` and never ends (the request is still streaming). */
function openStream(first: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(first));
    },
  });
}

/** Records every cancel() the SDK calls on the reader of a response clone. */
function spyOnCloneCancel(): unknown[] {
  const cancels: unknown[] = [];
  const realClone = Response.prototype.clone;
  vi.spyOn(Response.prototype, "clone").mockImplementation(function (this: Response) {
    const copy = realClone.call(this);
    const stream = copy.body;
    if (stream) {
      const realGetReader = stream.getReader.bind(stream);
      stream.getReader = (() => {
        const reader = realGetReader();
        const realCancel = reader.cancel.bind(reader);
        reader.cancel = (reason?: unknown) => {
          cancels.push(reason);
          return realCancel(reason);
        };
        return reader;
      }) as typeof stream.getReader;
    }
    return copy;
  });
  return cancels;
}

/**
 * The replay's observer (network-record.ts) on the shared wrapper, plus a
 * plain one like the exception breadcrumbs (no `detail`).
 */
function subscribe(options: SessionReplayNetworkOptions | undefined, log = vi.fn()) {
  const recorder = networkRecorder(options, log);
  const payloads: NetworkPayload[] = [];
  const crumbs: ObservedRequest[] = [];
  const offReplay = observeNetwork({
    wants: () => true,
    detail: (url) => recorder.detail(url),
    capture: recorder.capture,
    done: (request) => payloads.push(recorder.payload(request)),
  });
  const offCrumbs = observeNetwork({ wants: () => true, done: (request) => crumbs.push(request) });
  return {
    payloads,
    crumbs,
    log,
    off: () => {
      offReplay();
      offCrumbs();
    },
  };
}

const FULL = { headers: true, bodies: true, allowUrls: [`${API}/`] };

type NetworkEntryLike = Parameters<NonNullable<SessionReplayNetworkOptions["redact"]>>[0];

describe("$network headers and bodies (VEL-2145)", () => {
  let responder: (url: string, init?: RequestInit) => Response | Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;
  // Every unsubscribe of the test, run in afterEach (a test may subscribe twice).
  const offs: (() => void)[] = [];

  const listen = (options: SessionReplayNetworkOptions | undefined, log = vi.fn()) => {
    const sub = subscribe(options, log);
    offs.push(sub.off);
    return sub;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(T0);
    responder = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "r1" },
      });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => responder(String(url), init));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const off of offs.splice(0)) off();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("default", () => {
    it("records only method, query-less URL, status and duration, and never clones (fetch)", async () => {
      const clone = vi.spyOn(Response.prototype, "clone");
      const { payloads } = listen(undefined);
      const res = await fetch(`${API}/items?token=1`, {
        method: "POST",
        headers: { "x-trace": "t" },
        body: '{"a":1}',
      });
      expect(await res.json()).toEqual({ ok: true });
      await drain();

      expect(payloads).toHaveLength(1);
      expect(Object.keys(payloads[0]).sort()).toEqual(["duration_ms", "method", "status", "url"]);
      expect(payloads[0]).toMatchObject({ method: "POST", url: `${API}/items`, status: 200 });
      expect(clone).not.toHaveBeenCalled();
    });

    it("headers and bodies both false, or allowUrls empty, record nothing more (and warn in debug)", async () => {
      const clone = vi.spyOn(Response.prototype, "clone");
      const first = listen({ headers: false, bodies: false, allowUrls: [`${API}/`] });
      await fetch(`${API}/a`);
      first.off();
      const log = vi.fn();
      const second = listen({ headers: true, bodies: true, allowUrls: [] }, log);
      await fetch(`${API}/b`);
      second.off();
      const third = listen({ headers: true, bodies: true });
      await fetch(`${API}/c`);
      await drain();

      for (const payload of [...first.payloads, ...second.payloads, ...third.payloads]) {
        expect(Object.keys(payload).sort()).toEqual(["duration_ms", "method", "status", "url"]);
      }
      expect(log).toHaveBeenCalledWith(expect.stringContaining("allowUrls is empty"));
      expect(third.log).toHaveBeenCalledWith(expect.stringContaining("allowUrls is empty"));
      expect(clone).not.toHaveBeenCalled();
    });
  });

  describe("allowUrls", () => {
    it("matches a string by prefix of the query-less absolute URL, and marks the rest not_allowed", async () => {
      const { payloads } = listen({ headers: true, allowUrls: [`${API}/v1/`] });
      await fetch(`${API}/v1/items?x=1`);
      await fetch(`${API}/v2/items`);
      // The query is not part of the match: a prefix that only a query would satisfy never matches.
      const other = listen({ headers: true, allowUrls: [`${API}/v3?debug`] });
      await fetch(`${API}/v3?debug=1`);
      await drain();

      expect(payloads[0]).toMatchObject({ kind: "fetch", ts: T0, request: { headers: {} } });
      expect(payloads[1]).toEqual({
        method: "GET",
        url: `${API}/v2/items`,
        status: 200,
        duration_ms: expect.any(Number),
        capture: "not_allowed",
      });
      expect(other.payloads.at(-1)?.capture).toBe("not_allowed");
    });

    it("matches a RegExp by test, a /g one on every request", async () => {
      const { payloads } = listen({ headers: true, allowUrls: [/\/orders\/\d+$/g] });
      await fetch(`${API}/orders/1`);
      await fetch(`${API}/orders/2`);
      await fetch(`${API}/orders/new`);
      await drain();

      expect(payloads.map((p) => p.capture ?? p.kind)).toEqual(["fetch", "fetch", "not_allowed"]);
    });
  });

  describe("headers", () => {
    it("removes secret headers in both directions and scrubs the rest", async () => {
      responder = () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "set-cookie": "sid=1",
            "x-secret-thing": "s",
            "x-request-id": "r1",
            "x-owner": "ana@example.com",
          },
        });
      const { payloads } = listen({ headers: true, allowUrls: [`${API}/`] });
      await fetch(`${API}/me`, {
        headers: {
          Authorization: "Bearer abc",
          "Proxy-Authorization": "Basic x",
          Cookie: "a=b",
          "X-Api-Key": "k",
          "X-CSRF-Token": "t",
          "X-Session-Id": "s",
          "X-Custom-Auth": "c",
          "X-Password-Hint": "p",
          "Content-Type": "application/json",
          "X-Trace": "trace-1",
        },
      });
      await drain();

      expect(payloads[0].request?.headers).toEqual({
        "content-type": "application/json",
        "x-trace": "trace-1",
      });
      expect(payloads[0].response?.headers).toEqual({
        "content-type": "application/json",
        "x-request-id": "r1",
        "x-owner": "[email]",
      });
      expect(payloads[0].request?.body).toBeUndefined();
      expect(payloads[0].response?.body).toBeUndefined();
    });
  });

  describe("bodies", () => {
    it("scrubs a JSON body (secret keys and e-mails) and text bodies", async () => {
      responder = () =>
        new Response(JSON.stringify({ user: { email: "ana@example.com", apiKey: "k1" }, n: 1 }), {
          headers: { "content-type": "application/json" },
        });
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      await fetch(`${API}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.co", password: "x", name: "Ana" }),
      });
      responder = () => new Response("write to ana@example.com", { headers: { "content-type": "text/plain" } });
      await fetch(`${API}/note`, { method: "POST", body: "from a@b.co" });
      await drain();

      expect(JSON.parse(payloads[0].request?.body ?? "")).toEqual({
        email: "[email]",
        password: "[token]",
        name: "Ana",
      });
      expect(JSON.parse(payloads[0].response?.body ?? "")).toEqual({
        user: { email: "[email]", apiKey: "[token]" },
        n: 1,
      });
      expect(payloads[0].request?.headers).toBeUndefined();
      expect(payloads[1].request?.body).toBe("from [email]");
      expect(payloads[1].response?.body).toBe("write to [email]");
    });

    it("cuts a body over 16 KiB and ends it in [truncated], secret JSON keys still scrubbed", async () => {
      const big = JSON.stringify({ password: "hunter2", pad: "x".repeat(40_000) });
      responder = () => new Response(big, { headers: { "content-type": "application/json" } });
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      await fetch(`${API}/big`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
      await drain();

      for (const body of [payloads[0].request?.body, payloads[0].response?.body]) {
        expect(body?.endsWith("[truncated]")).toBe(true);
        expect(body?.length).toBeLessThanOrEqual(MAX_BODY_BYTES + "[truncated]".length);
        expect(body).not.toContain("hunter2");
        expect(body).toContain('"password":"[token]"');
      }
    });

    it("records binary, form-data, stream and Blob request bodies as markers", async () => {
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      const form = new FormData();
      form.append("file", "x");
      await fetch(`${API}/1`, { method: "POST", body: form });
      await fetch(`${API}/2`, { method: "POST", body: new Uint8Array(10) });
      await fetch(`${API}/3`, { method: "POST", body: new ArrayBuffer(7) });
      await fetch(`${API}/4`, { method: "POST", body: new Blob(["abc"]) });
      await fetch(`${API}/5`, { method: "POST", body: openStream("x"), duplex: "half" } as RequestInit);
      await fetch(`${API}/6`, { method: "POST", body: new URLSearchParams({ q: "a", password: "x" }) });
      await fetch(`${API}/7`);
      await drain();

      expect(payloads.map((p) => p.request?.body)).toEqual([
        "[form-data]",
        "[binary 10 bytes]",
        "[binary 7 bytes]",
        "[binary 3 bytes]",
        "[stream]",
        "q=a&password=[token]",
        undefined,
      ]);
      // A GET without a body has no `body` key at all.
      expect(payloads[6].request).toEqual({});
    });

    it("records a binary or event-stream response from its headers, never cloning it", async () => {
      const clone = vi.spyOn(Response.prototype, "clone");
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      responder = () =>
        new Response(new Uint8Array(2048), {
          headers: { "content-type": "application/octet-stream", "content-length": "2048" },
        });
      await fetch(`${API}/file`);
      responder = () => new Response(new Uint8Array(3), { headers: { "content-type": "image/png" } });
      await fetch(`${API}/img`);
      responder = () => new Response(openStream("data: 1\n\n"), { headers: { "content-type": "text/event-stream" } });
      await fetch(`${API}/events`);
      await drain();

      expect(payloads.map((p) => p.response?.body)).toEqual(["[binary 2048 bytes]", "[binary]", "[stream]"]);
      expect(clone).not.toHaveBeenCalled();
    });

    it("a response body the page already used reads [unavailable]", async () => {
      vi.spyOn(Response.prototype, "clone").mockImplementation(() => {
        throw new TypeError("Response body is already used");
      });
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      await fetch(`${API}/x`);
      await drain();
      expect(payloads[0].response?.body).toBe("[unavailable]");
    });

    it("keeps a body of exactly 16 KiB whole and cuts one byte more", async () => {
      const exact = "a".repeat(MAX_BODY_BYTES);
      const over = "b".repeat(MAX_BODY_BYTES + 1);
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      responder = () => new Response(exact, { headers: { "content-type": "text/plain" } });
      await fetch(`${API}/exact`, { method: "POST", headers: { "content-type": "text/plain" }, body: exact });
      responder = () => new Response(over, { headers: { "content-type": "text/plain" } });
      await fetch(`${API}/over`, { method: "POST", headers: { "content-type": "text/plain" }, body: over });
      await drain();

      expect(payloads[0].request?.body).toBe(exact);
      expect(payloads[0].response?.body).toBe(exact);
      expect(payloads[1].request?.body).toBe(`${"b".repeat(MAX_BODY_BYTES)}[truncated]`);
      expect(payloads[1].response?.body).toBe(`${"b".repeat(MAX_BODY_BYTES)}[truncated]`);
    });

    it("cuts multibyte text on a character boundary, at most 16 KiB of UTF-8", async () => {
      // 3 bytes each: 16 KiB falls inside a character.
      const euros = "€".repeat(6000);
      responder = () => new Response(euros, { headers: { "content-type": "text/plain; charset=utf-8" } });
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      await fetch(`${API}/eur`, { method: "POST", headers: { "content-type": "text/plain" }, body: euros });
      await drain();

      for (const body of [payloads[0].request?.body, payloads[0].response?.body]) {
        expect(body?.endsWith("[truncated]")).toBe(true);
        const kept = body?.slice(0, -"[truncated]".length) ?? "";
        expect(kept).not.toContain("�");
        expect(kept).toBe("€".repeat(Math.floor(MAX_BODY_BYTES / 3)));
        expect(encoder.encode(kept).byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
      }
    });

    it("cancels its branch of a body that is still streaming once past 16 KiB; the page keeps reading", async () => {
      const cancels = spyOnCloneCancel();
      responder = () => new Response(openStream("x".repeat(20_000)), { headers: { "content-type": "text/plain" } });
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      const res = await fetch(`${API}/live`);
      await drain();

      expect(cancels).toHaveLength(1);
      expect(payloads[0].response?.body).toBe(`${"x".repeat(MAX_BODY_BYTES)}[truncated]`);
      const first = await res.body?.getReader().read();
      expect(first?.value?.byteLength).toBe(20_000);
    });

    it("scrubs a cut form body by its pairs and a cut JSON body by its keys, escaped ones too", async () => {
      const pad = "x".repeat(20_000);
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      responder = () =>
        new Response(`user=ana&password=hunter2&pass%77ord=hunter3&sessionid=sess-secret&pad=${pad}`, {
          headers: { "content-type": "application/x-www-form-urlencoded" },
        });
      await fetch(`${API}/form`);
      responder = () =>
        new Response(`{"access_token":"tok-one","pass\\u0077ord":"tok-two","pad":"${pad}"}`, {
          headers: { "content-type": "application/json" },
        });
      await fetch(`${API}/json`);
      await drain();

      const form = payloads[0].response?.body ?? "";
      expect(form.endsWith("[truncated]")).toBe(true);
      expect(form.startsWith("user=ana&password=[token]&pass%77ord=[token]&sessionid=[token]&pad=x")).toBe(true);
      const json = payloads[1].response?.body ?? "";
      expect(json.endsWith("[truncated]")).toBe(true);
      expect(json).not.toContain("tok-one");
      expect(json).not.toContain("tok-two");
      expect(json).toContain('"pass\\u0077ord":"[token]"');
    });

    it("scrubs secret keys nested in objects and arrays of a cut JSON body", async () => {
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      responder = () =>
        new Response(
          JSON.stringify({
            data: { password: "hunter2", user: { api_key: "key-1" } },
            list: [{ token: "tok-3" }],
            pad: "x".repeat(20_000),
          }),
          { headers: { "content-type": "application/json" } },
        );
      await fetch(`${API}/nested`);
      await drain();

      const json = payloads[0].response?.body ?? "";
      expect(json.endsWith("[truncated]")).toBe(true);
      for (const secret of ["hunter2", "key-1", "tok-3"]) expect(json).not.toContain(secret);
      expect(json).toContain('"data":{"password":"[token]"');
    });

    it("reads the body of a Request object from a clone taken before fetch() consumes it", async () => {
      const sentBody = JSON.stringify({ email: "a@b.co", password: "x" });
      const received: string[] = [];
      fetchMock.mockImplementation(async (input: Request) => {
        received.push(input.bodyUsed ? "" : await input.text());
        return new Response("{}", { headers: { "content-type": "application/json" } });
      });
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      await fetch(
        new Request(`${API}/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: sentBody,
        }),
      );
      const used = new Request(`${API}/used`, { method: "POST", body: "x" });
      await used.text();
      await fetch(used);
      await drain();

      // The page's fetch got the whole body.
      expect(received[0]).toBe(sentBody);
      expect(JSON.parse(payloads[0].request?.body ?? "")).toEqual({ email: "[email]", password: "[token]" });
      expect(payloads[1].request?.body).toBe("[unavailable]");
    });

    it("records a string sent as binary or as an event stream as a marker", async () => {
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      await fetch(`${API}/bin`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "héllo",
      });
      await fetch(`${API}/sse`, { method: "POST", headers: { "content-type": "text/event-stream" }, body: "data: 1\n\n" });
      await drain();

      expect(payloads.map((p) => p.request?.body)).toEqual(["[binary 6 bytes]", "[stream]"]);
    });
  });

  describe("URLs", () => {
    it("resolves a relative URL against <base href>", async () => {
      const base = document.createElement("base");
      base.href = `${API}/v1/`;
      document.head.append(base);
      try {
        const { payloads } = listen({ headers: true, allowUrls: [`${API}/v1/`] });
        await fetch("items?x=1");
        await drain();
        expect(payloads[0]).toMatchObject({ url: `${API}/v1/items`, kind: "fetch", request: { headers: {} } });
        expect(payloads[0].capture).toBeUndefined();
      } finally {
        base.remove();
      }
    });

    it("after a redirect outside allowUrls, records no response headers or body", async () => {
      const clone = vi.spyOn(Response.prototype, "clone");
      responder = () => {
        const res = new Response('{"a":1}', { headers: { "content-type": "application/json", "x-b": "1" } });
        Object.defineProperty(res, "url", { value: "https://other.example.com/landing" });
        return res;
      };
      const { payloads } = listen(FULL);
      await fetch(`${API}/go`, { method: "POST", headers: { "x-trace": "t" }, body: '{"q":1}' });
      await drain();

      expect(payloads[0].url).toBe(`${API}/go`);
      expect(payloads[0].request).toEqual({ headers: { "x-trace": "t" }, body: '{"q":1}' });
      expect(payloads[0].response).toEqual({});
      expect(clone).not.toHaveBeenCalled();
    });
  });

  describe("the page's response", () => {
    it("the page reads a 5 MB body whole with json(), text() and getReader(); the SDK keeps 16 KiB", async () => {
      const huge = JSON.stringify({ data: "y".repeat(5 * 1024 * 1024) });
      responder = () => new Response(huge, { headers: { "content-type": "application/json" } });
      const { payloads } = listen(FULL);

      const viaJson = await (await fetch(`${API}/json`)).json();
      expect(viaJson.data).toHaveLength(5 * 1024 * 1024);
      const viaText = await (await fetch(`${API}/text`)).text();
      expect(viaText).toBe(huge);
      const reader = (await fetch(`${API}/reader`)).body?.getReader();
      let read = 0;
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        read += chunk.value.byteLength;
      }
      expect(read).toBe(encoder.encode(huge).byteLength);
      await drain();

      expect(payloads).toHaveLength(3);
      for (const payload of payloads) {
        expect(payload.response?.body?.endsWith("[truncated]")).toBe(true);
        expect(payload.response?.body?.length).toBeLessThanOrEqual(MAX_BODY_BYTES + "[truncated]".length);
      }
    });

    it("resolves the page's fetch without waiting for the SDK; a body that never ends is [unavailable] after 2 s", async () => {
      responder = () => new Response(openStream('{"partial":'), { headers: { "content-type": "application/json" } });
      const { payloads } = listen(FULL);

      const res = await fetch(`${API}/live`);
      // The page has its response and reads what has arrived; the SDK is still waiting.
      const first = await res.body?.getReader().read();
      expect(new TextDecoder().decode(first?.value)).toBe('{"partial":');
      await drain();
      await vi.advanceTimersByTimeAsync(1999);
      expect(payloads).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await drain();

      expect(payloads).toHaveLength(1);
      expect(payloads[0].response?.body).toBe("[unavailable]");
      expect(payloads[0].ts).toBe(T0);
    });

    it("hands the page the same response object and the same rejection", async () => {
      const original = new Response("{}", { headers: { "content-type": "application/json" } });
      responder = () => original;
      const { payloads } = listen(FULL);
      expect(await fetch(`${API}/same`)).toBe(original);

      const failure = new TypeError("Failed to fetch");
      responder = () => Promise.reject(failure);
      await expect(fetch(`${API}/down`)).rejects.toBe(failure);
      await drain();

      // The failure is reported at once, the success after its body is read: find each by URL.
      const down = payloads.find((p) => p.url === `${API}/down`);
      expect(down).toMatchObject({ status: 0, kind: "fetch", request: {} });
      expect(down?.response).toBeUndefined();
    });
  });

  describe("redact", () => {
    it("holds what it returns to 16 KiB per body and drops headers and bodies over 40 KiB", async () => {
      const many = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`x-h${i}`, "v".repeat(100)]));
      const redact = (entry: NetworkEntryLike) =>
        entry.url.endsWith("/body")
          ? { ...entry, response: { body: "r".repeat(100 * 1024) } }
          : { ...entry, request: { headers: many } };
      const { payloads } = listen({ ...FULL, redact });
      await fetch(`${API}/body`);
      await fetch(`${API}/headers`);
      await drain();

      expect(payloads[0].response?.body).toBe(`${"r".repeat(MAX_BODY_BYTES)}[truncated]`);
      expect(MAX_DETAIL_BYTES).toBe(40 * 1024);
      expect(Object.keys(payloads[1]).sort()).toEqual(["duration_ms", "kind", "method", "status", "ts", "url"]);
    });

    it("keeps two full 16 KiB JSON bodies, whatever JSON escaping would add", async () => {
      // Dense JSON: many quotes, each escaped when the event is serialized.
      const dense = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ k: String(i % 10) })));
      responder = () => new Response(dense, { headers: { "content-type": "application/json" } });
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      await fetch(`${API}/dense`, { method: "POST", headers: { "content-type": "application/json" }, body: dense });
      await drain();

      expect(payloads[0].request?.body?.endsWith("[truncated]")).toBe(true);
      expect(payloads[0].response?.body?.endsWith("[truncated]")).toBe(true);
    });

    it("gets the scrubbed entry and may change it; null drops headers and bodies; throwing too", async () => {
      const seen: unknown[] = [];
      const redact = vi.fn((entry) => {
        seen.push(structuredClone(entry));
        if (entry.url.endsWith("/drop")) return null;
        if (entry.url.endsWith("/boom")) throw new Error("bug in redact");
        return {
          ...entry,
          request: { ...entry.request, body: "[removed by app]" },
          // An app that adds a secret header back still never records it.
          response: { headers: { ...entry.response?.headers, authorization: "Bearer x" } },
        };
      });
      const log = vi.fn();
      const { payloads } = listen({ ...FULL, redact }, log);
      await fetch(`${API}/keep`, { method: "POST", headers: { authorization: "Bearer a" }, body: '{"a":"b@c.io"}' });
      await fetch(`${API}/drop`);
      await fetch(`${API}/boom`);
      await drain();

      expect(seen[0]).toEqual({
        method: "POST",
        url: `${API}/keep`,
        status: 200,
        kind: "fetch",
        request: { headers: {}, body: '{"a":"[email]"}' },
        response: { headers: { "content-type": "application/json", "x-request-id": "r1" }, body: '{"ok":true}' },
      });
      expect(payloads[0].request).toEqual({ headers: {}, body: "[removed by app]" });
      expect(payloads[0].response).toEqual({ headers: { "content-type": "application/json", "x-request-id": "r1" } });
      for (const dropped of payloads.slice(1)) {
        expect(dropped).toMatchObject({ kind: "fetch", status: 200 });
        expect(dropped.request).toBeUndefined();
        expect(dropped.response).toBeUndefined();
      }
      expect(log).toHaveBeenCalledWith(expect.stringContaining("redact threw"), expect.any(Error));
    });
  });

  describe("breadcrumb observers", () => {
    it("get a request the moment it settles, while the replay still reads its open body", async () => {
      responder = () =>
        new Response(openStream('{"error":'), { status: 500, headers: { "content-type": "application/json" } });
      const { crumbs, payloads } = listen(FULL);
      await fetch(`${API}/fail`);

      expect(crumbs).toEqual([
        { kind: "fetch", method: "GET", url: `${API}/fail`, status: 500, durationMs: expect.any(Number) },
      ]);
      expect(payloads).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2000);
      await drain();
      expect(payloads).toHaveLength(1);
    });

    it("never load the reading code: network.ts imports only types from network-capture.ts", () => {
      const source = readFileSync(resolve(__dirname, "../src/network.ts"), "utf8");
      const imports = source.match(/^import[^;]*from "\.\/network-capture\.js";/gm) ?? [];
      expect(imports.length).toBeGreaterThan(0);
      for (const line of imports) expect(line.startsWith("import type")).toBe(true);
    });

    it("see the basic request only, with the replay's detail on at the same time", async () => {
      const { crumbs, payloads } = listen(FULL);
      await fetch(`${API}/x`, { headers: { "x-trace": "t" }, body: "b", method: "POST" });
      await drain();

      expect(payloads[0].request).toBeDefined();
      expect(crumbs).toHaveLength(1);
      expect(Object.keys(crumbs[0]).sort()).toEqual(["durationMs", "kind", "method", "status", "url"]);
    });

    it("alone, never clone a response or read its headers", async () => {
      const clone = vi.spyOn(Response.prototype, "clone");
      const forEach = vi.spyOn(Headers.prototype, "forEach");
      const crumbs: ObservedRequest[] = [];
      offs.push(observeNetwork({ wants: () => true, done: (r) => crumbs.push(r) }));
      await fetch(`${API}/x`, { headers: { "x-trace": "t" } });
      await drain();
      expect(Object.keys(crumbs[0]).sort()).toEqual(["durationMs", "kind", "method", "status", "url"]);
      expect(clone).not.toHaveBeenCalled();
      expect(forEach).not.toHaveBeenCalled();
    });
  });

  describe("XHR", () => {
    /** XMLHttpRequest with headers both ways and the response types the SDK reads. */
    class FakeXHR extends EventTarget {
      status = 0;
      readyState = 0;
      responseType: XMLHttpRequestResponseType = "";
      responseText = "";
      response: unknown = "";
      sentHeaders: [string, string][] = [];
      sentBody: unknown;
      private responseHeaders: Record<string, string> = {};
      open() {}
      setRequestHeader(name: string, value: string) {
        this.sentHeaders.push([name, value]);
      }
      send(body?: unknown) {
        this.sentBody = body;
        this.dispatchEvent(new Event("loadstart"));
      }
      getResponseHeader(name: string) {
        return this.responseHeaders[name.toLowerCase()] ?? null;
      }
      getAllResponseHeaders() {
        return Object.entries(this.responseHeaders)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("");
      }
      finish(status: number, headers: Record<string, string>, body: unknown) {
        this.status = status;
        this.readyState = 4;
        this.responseHeaders = headers;
        if (this.responseType === "" || this.responseType === "text") {
          this.responseText = String(body);
          this.response = this.responseText;
        } else {
          this.response = body;
        }
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("load"));
      }
    }

    const xhr = () => new XMLHttpRequest() as unknown as FakeXHR & XMLHttpRequest;

    beforeEach(() => {
      vi.stubGlobal("XMLHttpRequest", FakeXHR);
    });

    it("by default records the basics and passes what the page sends through untouched", () => {
      const { payloads } = listen(undefined);
      const req = xhr();
      req.open("POST", `${API}/x?y=1`);
      req.setRequestHeader("authorization", "Bearer a");
      req.send('{"a":1}');
      req.finish(201, { "content-type": "application/json" }, '{"ok":true}');

      expect(req.sentHeaders).toEqual([["authorization", "Bearer a"]]);
      expect(req.sentBody).toBe('{"a":1}');
      expect(payloads).toEqual([
        { method: "POST", url: `${API}/x`, status: 201, duration_ms: expect.any(Number) },
      ]);
    });

    it("records request and response headers and bodies, secrets removed and scrubbed", () => {
      const { payloads, crumbs } = listen(FULL);
      const req = xhr();
      req.open("POST", `${API}/login`);
      req.setRequestHeader("Content-Type", "application/json");
      req.setRequestHeader("Authorization", "Bearer a");
      req.setRequestHeader("X-Trace", "t1");
      req.send(JSON.stringify({ email: "a@b.co", password: "x" }));
      req.finish(
        200,
        { "content-type": "application/json", "set-cookie": "sid=1", "x-request-id": "r1" },
        JSON.stringify({ token: "abc", name: "Ana" }),
      );

      expect(payloads[0]).toEqual({
        method: "POST",
        url: `${API}/login`,
        status: 200,
        duration_ms: expect.any(Number),
        kind: "xhr",
        ts: T0,
        request: {
          headers: { "content-type": "application/json", "x-trace": "t1" },
          body: '{"email":"[email]","password":"[token]"}',
        },
        response: {
          headers: { "content-type": "application/json", "x-request-id": "r1" },
          body: '{"token":"[token]","name":"Ana"}',
        },
      });
      // The page's XHR got everything it sent, and the breadcrumb observer only the basics.
      expect(req.sentHeaders.map(([name]) => name)).toEqual(["Content-Type", "Authorization", "X-Trace"]);
      expect(Object.keys(crumbs[0]).sort()).toEqual(["durationMs", "kind", "method", "status", "url"]);
    });

    it("reads json, text over 16 KiB and binary response types; FormData as a marker", () => {
      const { payloads } = listen({ bodies: true, allowUrls: [`${API}/`] });
      const json = xhr();
      json.responseType = "json";
      json.open("GET", `${API}/j`);
      json.send();
      json.finish(200, { "content-type": "application/json" }, { email: "a@b.co" });

      const text = xhr();
      text.open("POST", `${API}/t`);
      const form = new FormData();
      text.send(form);
      text.finish(200, { "content-type": "text/plain" }, "z".repeat(20_000));

      const buffer = xhr();
      buffer.responseType = "arraybuffer";
      buffer.open("GET", `${API}/b`);
      buffer.send();
      buffer.finish(200, { "content-type": "application/octet-stream" }, new ArrayBuffer(12));

      const html = xhr();
      html.open("GET", `${API}/png`);
      html.send();
      html.finish(200, { "content-type": "image/png", "content-length": "99" }, "....");

      expect(payloads[0].response?.body).toBe('{"email":"[email]"}');
      expect(payloads[1].request?.body).toBe("[form-data]");
      expect(payloads[1].response?.body?.endsWith("[truncated]")).toBe(true);
      expect(payloads[1].response?.body).toHaveLength(MAX_BODY_BYTES + "[truncated]".length);
      expect(payloads[2].response?.body).toBe("[binary 12 bytes]");
      expect(payloads[3].response?.body).toBe("[binary 99 bytes]");
    });

    it("marks a URL outside allowUrls not_allowed", () => {
      const { payloads } = listen(FULL);
      const req = xhr();
      req.open("GET", "https://other.example.com/x");
      req.send();
      req.finish(200, {}, "");
      expect(payloads[0].capture).toBe("not_allowed");
      expect(payloads[0].request).toBeUndefined();
    });
  });
});
