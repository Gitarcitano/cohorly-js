import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeModuleBag } from "../src/deviceInfo.js";

// Shared release key (VEL-1772, ADR-0019 Limits amendment 2026-11-14): every
// event carries `$release`/`$release_dist`, the same values the exception
// engine stamps as `$exception_release`/`$exception_dist`.
const native = vi.hoisted(() => ({ bag: {} as Record<string, unknown> }));
vi.mock("../src/deviceInfo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/deviceInfo.js")>();
  return { ...actual, loadNativeModules: () => native.bag as NativeModuleBag };
});

import { CohorlyClient } from "../src/client.js";
import { teardownExceptionCapture } from "../src/exceptions/handlers.js";
import type { CohorlyOptions } from "../src/types.js";
import { createFakeFetch, type FakeRequest, FakeStorage, requestsTo } from "./helpers.js";

type AnyEvent = { event: string; properties: Record<string, any> };

const events = (requests: FakeRequest[]) => requestsTo(requests, "/track").flatMap((r) => r.body as AnyEvent[]);

const clients: CohorlyClient[] = [];

function makeClient(options: Partial<CohorlyOptions> = {}) {
  const fake = createFakeFetch();
  const client = new CohorlyClient({
    apiHost: "http://localhost:4000",
    token: "proj_test",
    storage: new FakeStorage(),
    fetch: fake.fetchImpl,
    flushInterval: 60_000,
    loadFeatureFlags: false,
    appVersion: "3.8.0",
    appBuild: "412",
    platformInfo: { os: "Android" },
    ...options,
  });
  clients.push(client);
  return { client, requests: fake.requests };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  teardownExceptionCapture();
  native.bag = {};
});

const OTA = { expoUpdates: { updateId: "upd-7", runtimeVersion: "1.4.0", isEmbeddedLaunch: false } };

describe("$release / $release_dist on every event", () => {
  it("stamps the same release and dist as the exception engine", async () => {
    native.bag = { expoApplication: { applicationId: "com.app" }, ...OTA };
    const { client, requests } = makeClient();
    await client.exceptionsReady;
    client.track("Screen");
    client.captureException(new Error("boom"));
    await client.flush();
    await vi.waitFor(() => expect(events(requests).some((e) => e.event === "$exception")).toBe(true));

    const screen = events(requests).find((e) => e.event === "Screen");
    const crash = events(requests).find((e) => e.event === "$exception");
    expect(screen?.properties.$release).toBe("com.app@3.8.0+412");
    expect(screen?.properties.$release_dist).toBe("upd-7");
    expect(crash?.properties.$exception_release).toBe(screen?.properties.$release);
    expect(crash?.properties.$exception_dist).toBe(screen?.properties.$release_dist);
  });

  it("has no $release_dist on the embedded bundle", async () => {
    native.bag = { expoUpdates: { updateId: "emb", runtimeVersion: "1.4.0", isEmbeddedLaunch: true } };
    const { client, requests } = makeClient();
    await client.ready;
    client.track("Screen");
    await client.flush();
    const props = events(requests)[0].properties;
    expect(props.$release).toBe("android@3.8.0+412");
    expect(props).not.toHaveProperty("$release_dist");
  });

  it("uses explicit release and dist options, and lets caller and super properties win", async () => {
    native.bag = { ...OTA };
    const { client, requests } = makeClient({ release: "shop-rt-7", dist: "flavor" });
    await client.ready;
    client.track("A");
    client.track("B", { $release: "caller", $release_dist: "caller-dist" });
    client.register({ $release: "super" });
    client.track("C");
    await client.flush();
    const byName = Object.fromEntries(events(requests).map((e) => [e.event, e.properties]));
    expect(byName.A.$release).toBe("shop-rt-7");
    expect(byName.A.$release_dist).toBe("flavor");
    expect(byName.B.$release).toBe("caller");
    expect(byName.B.$release_dist).toBe("caller-dist");
    expect(byName.C.$release).toBe("super");
  });

  it("sends events tracked before the release is known without it, never a guess", async () => {
    native.bag = { ...OTA };
    const { client, requests } = makeClient();
    client.track("Early");
    await client.ready;
    await client.flush();
    const early = events(requests).find((e) => e.event === "Early");
    expect(early?.properties).not.toHaveProperty("$release");
    expect(early?.properties).not.toHaveProperty("$release_dist");
  });

  it("omits $release when no version is known", async () => {
    const { client, requests } = makeClient({ appVersion: undefined, appBuild: undefined });
    await client.ready;
    client.track("Screen");
    await client.flush();
    expect(events(requests)[0].properties).not.toHaveProperty("$release");
  });
});
