/**
 * The `$network` payload of session replay (docs/SESSION-REPLAY.md section 2)
 * and the opt-in `network` option (VEL-2145): which requests get headers and
 * bodies (`allowUrls`), and the app's `redact` on each recorded entry. The
 * reading and sanitizing happen in network-capture.ts, behind network.ts.
 */
import { SCRUB_TRUNCATED } from "@cohorly/core";
import type { NetworkCapture, NetworkDetail, ObservedRequest } from "../network.js";
import { absoluteWithoutQuery } from "../network.js";
import { cleanHeaders, clipText, MAX_BODY_BYTES, networkCapture, utf8Length } from "../network-capture.js";
import type { NetworkEntry, NetworkMessage, SessionReplayNetworkOptions } from "./session.js";

export interface NetworkPayload {
  method: string;
  url: string;
  status: number;
  duration_ms: number;
  kind?: "fetch" | "xhr";
  /** Unix ms the response (or the failure) arrived. */
  ts?: number;
  request?: NetworkMessage;
  response?: NetworkMessage;
  /** headers or bodies are on, but this URL is not in allowUrls. */
  capture?: "not_allowed";
}

/**
 * Most UTF-8 bytes of headers (names and values) and bodies, both sides
 * together, in one `$network` event, after `redact`. Each body is already at
 * most 16 KiB, so this bounds what headers add (and what `redact` puts back):
 * over it, the event keeps only the basic fields, `kind` and `ts`.
 */
export const MAX_DETAIL_BYTES = 40 * 1024;

export interface NetworkRecorder {
  /** What the wrapper should read for `url` (undefined: nothing beyond the basics). */
  detail(url: string): NetworkDetail | undefined;
  /** The reading code for network.ts, only when headers or bodies can be recorded. */
  capture?: NetworkCapture;
  payload(request: ObservedRequest): NetworkPayload;
}

function strippedUrl(url: string): string {
  return absoluteWithoutQuery(url) ?? url.split(/[?#]/)[0];
}

/** A string matches by prefix, a RegExp by test() (a copy, so a /g lastIndex never carries over). */
function urlMatcher(allowUrls: unknown[]): (url: string) => boolean {
  const prefixes: string[] = [];
  const patterns: RegExp[] = [];
  for (const item of allowUrls) {
    if (typeof item === "string" && item !== "") prefixes.push(item);
    else if (item instanceof RegExp) patterns.push(new RegExp(item.source, item.flags.replace(/[gy]/g, "")));
  }
  return (url) =>
    prefixes.some((prefix) => url.startsWith(prefix)) || patterns.some((pattern) => pattern.test(url));
}

/** A message from `redact`, kept only where it has the right shape; secret headers removed again. */
function checkedMessage(value: unknown): NetworkMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { headers, body } = value as { headers?: unknown; body?: unknown };
  const out: NetworkMessage = {};
  if (typeof headers === "object" && headers !== null && !Array.isArray(headers)) {
    out.headers = cleanHeaders(
      Object.entries(headers).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    );
  }
  if (typeof body === "string") out.body = clipBody(body);
  return out;
}

/** A body from `redact` held to the SDK's own limit: 16 KiB of UTF-8, then `[truncated]`. */
function clipBody(body: string): string {
  // Room for the SDK's own marker on a body it already cut.
  if (body.length <= MAX_BODY_BYTES / 3 || utf8Length(body) <= MAX_BODY_BYTES + SCRUB_TRUNCATED.length) {
    return body;
  }
  return `${clipText(body)}${SCRUB_TRUNCATED}`;
}

/**
 * UTF-8 bytes of the header names and values and the bodies of both sides.
 * Not of their JSON: escaping (`\"` for every quote) would make two full
 * 16 KiB JSON bodies, the case the limit is meant to keep, pass 40 KiB.
 */
function detailBytes(...messages: (NetworkMessage | undefined)[]): number {
  let bytes = 0;
  for (const message of messages) {
    for (const [name, value] of Object.entries(message?.headers ?? {})) {
      bytes += utf8Length(name) + utf8Length(value);
    }
    if (message?.body !== undefined) bytes += utf8Length(message.body);
  }
  return bytes;
}

function copyMessage(message: NetworkMessage | undefined): NetworkMessage | undefined {
  if (!message) return undefined;
  return {
    ...(message.headers ? { headers: { ...message.headers } } : {}),
    ...(message.body !== undefined ? { body: message.body } : {}),
  };
}

/**
 * `options` is `sessionReplay.network`. With neither headers nor bodies on,
 * or with no allowUrls, every payload is the basic one.
 */
export function networkRecorder(
  options: SessionReplayNetworkOptions | undefined,
  log: (...args: unknown[]) => void,
): NetworkRecorder {
  const headers = options?.headers === true;
  const bodies = options?.bodies === true;
  const allowUrls = Array.isArray(options?.allowUrls) ? options.allowUrls : [];
  const on = (headers || bodies) && allowUrls.length > 0;
  if ((headers || bodies) && allowUrls.length === 0) {
    log("sessionReplay.network: allowUrls is empty, no headers or bodies are recorded");
  }
  const allowed = on ? urlMatcher(allowUrls) : () => false;
  const redact = typeof options?.redact === "function" ? options.redact : undefined;

  const allowedUrl = (url: string): boolean => {
    try {
      return allowed(strippedUrl(url));
    } catch {
      return false;
    }
  };

  return {
    ...(on ? { capture: networkCapture } : {}),
    detail: (url) => (on && allowedUrl(url) ? { headers, bodies } : undefined),
    payload: (request) => {
      const basic: NetworkPayload = {
        method: request.method,
        url: strippedUrl(request.url),
        status: request.status ?? 0,
        duration_ms: request.durationMs,
      };
      if (!on) return basic;
      // The wrapper sends `request` exactly when detail() asked for this URL;
      // an allowed one without it started before this observer did.
      if (!request.request) return allowedUrl(request.url) ? basic : { ...basic, capture: "not_allowed" };
      const out: NetworkPayload = { ...basic, kind: request.kind };
      if (request.ts !== undefined) out.ts = request.ts;
      let entry: NetworkEntry | null = {
        method: basic.method,
        url: basic.url,
        status: basic.status,
        kind: request.kind,
        request: copyMessage(request.request) ?? {},
        ...(request.response ? { response: copyMessage(request.response) } : {}),
      };
      if (redact) {
        try {
          entry = redact(entry);
        } catch (err) {
          log("sessionReplay.network.redact threw, the request is recorded without headers and bodies", err);
          entry = null;
        }
      }
      if (entry === null || typeof entry !== "object") return out;
      const sent = checkedMessage(entry.request);
      const received = checkedMessage(entry.response);
      if (detailBytes(sent, received) > MAX_DETAIL_BYTES) {
        log("sessionReplay.network: headers and bodies of a request over 40 KiB are not recorded");
        return out;
      }
      if (sent) out.request = sent;
      if (received) out.response = received;
      return out;
    },
  };
}
