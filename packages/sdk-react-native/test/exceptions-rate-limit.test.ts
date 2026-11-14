import { MAX_EXCEPTIONS_PER_FINGERPRINT } from "@cohorly/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CohorlyClient } from "../src/client.js";
import { createFakeFetch, type FakeRequest, FakeStorage, requestsTo } from "./helpers.js";

type AnyEvent = { event: string; properties: Record<string, any> };

const clients: CohorlyClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers();
});

async function makeClient() {
  const { fetchImpl, requests } = createFakeFetch();
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    storage: new FakeStorage(),
    fetch: fetchImpl,
    flushInterval: 60_000,
    loadFeatureFlags: false,
    platformInfo: { os: "Android" },
  });
  clients.push(client);
  await client.exceptionsReady;
  return { client, requests };
}

function sentValues(requests: FakeRequest[]): string[] {
  return requestsTo(requests, "/track")
    .flatMap((r) => r.body as AnyEvent[])
    .filter((e) => e.event === "$exception")
    .map((e) => e.properties.$exception_list[0].value);
}

/** Same type, message and throw site on every call: one local fingerprint. */
function fail(message: string): Error {
  return new Error(message);
}

describe("local rate limit per fingerprint (same as the web SDK)", () => {
  it("sends at most 10 of 1000 captures of the same error", async () => {
    const { client, requests } = await makeClient();
    for (let i = 0; i < 1000; i++) client.captureException(fail("render loop"));
    await client.flush();

    expect(MAX_EXCEPTIONS_PER_FINGERPRINT).toBe(10);
    await vi.waitFor(() => expect(sentValues(requests)).toHaveLength(MAX_EXCEPTIONS_PER_FINGERPRINT));
  });

  it("does not let one error use up the quota of another", async () => {
    const { client, requests } = await makeClient();
    for (let i = 0; i < 15; i++) {
      client.captureException(fail("first"));
      client.captureException(fail("second"));
    }
    await client.flush();

    await vi.waitFor(() => expect(sentValues(requests)).toHaveLength(20));
    expect(sentValues(requests).filter((v) => v === "first")).toHaveLength(10);
    expect(sentValues(requests).filter((v) => v === "second")).toHaveLength(10);
  });

  it("accepts the error again once the 60 s window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client, requests } = await makeClient();
    for (let i = 0; i < 12; i++) client.captureException(fail("timer"));

    vi.setSystemTime(Date.now() + 59_999);
    client.captureException(fail("timer"));
    vi.setSystemTime(Date.now() + 1);
    client.captureException(fail("timer"));
    await client.flush();

    await vi.waitFor(() => expect(sentValues(requests)).toHaveLength(11));
  });

  it("starts afresh with a new client (init())", async () => {
    const first = await makeClient();
    for (let i = 0; i < 12; i++) first.client.captureException(fail("boot"));
    first.client.stop();
    const second = await makeClient();
    second.client.captureException(fail("boot"));
    await second.client.flush();

    await vi.waitFor(() => expect(sentValues(second.requests)).toHaveLength(1));
  });
});
