import { vi } from "vitest";
import type {
  OnRequestErrorContext,
  OnRequestErrorRequest,
} from "../src/request-error.js";

export const HOST = "http://cohorly.test";

export const REQUEST: OnRequestErrorRequest = {
  path: "/boom?token=abc&email=a@b.c#section-secret",
  method: "GET",
  headers: {
    cookie: "session=cookie-secret-value",
    authorization: "Bearer header-secret-value",
    "x-forwarded-for": "203.0.113.7",
  },
};

export const CONTEXT: OnRequestErrorContext = {
  routerKind: "App Router",
  routePath: "/boom",
  routeType: "render",
  renderSource: "react-server-components",
};

export const SECRETS = [
  "cookie-secret-value",
  "header-secret-value",
  "203.0.113.7",
  "token=abc",
  "a@b.c",
  "section-secret",
];

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  events: Array<{ event: string; properties: Record<string, unknown> }>;
}

/** fetch stub that answers 200 after `delayMs` and records what was sent. */
export function recordingFetch(delayMs = 0) {
  const sent: SentRequest[] = [];
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const body = String(init.body);
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body,
      events: JSON.parse(body),
    });
    return new Response(JSON.stringify({ status: 1 }), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return { mock, sent };
}

/** fetch stub that never answers, rejecting only when its signal aborts. */
export function hangingFetch() {
  const mock = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function rejectingFetch() {
  const mock = vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Clears every env var the hook reads, so the machine's env never leaks into a test. */
export function clearCohorlyEnv() {
  vi.stubEnv("COHORLY_TOKEN", "");
  vi.stubEnv("COHORLY_API_HOST", "");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
}

export class ServerComponentError extends Error {
  digest = "1234567890";
}
