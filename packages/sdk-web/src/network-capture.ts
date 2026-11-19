/**
 * Headers and bodies of a request, read only when an observer asks for them
 * (session replay's opt-in `network` option, VEL-2145). Everything leaving
 * this module is already sanitized: secret headers removed, values and bodies
 * scrubbed, bodies cut at {@link MAX_BODY_BYTES}. The page's own request and
 * response are never consumed: a fetch response (or a `Request` object's
 * body) is read through a clone, at most {@link MAX_BODY_BYTES} and
 * {@link BODY_READ_TIMEOUT_MS}, then its branch is cancelled.
 *
 * network.ts never imports this module: session replay passes it in as the
 * observer's `capture` ({@link networkCapture}), so the error tracking
 * breadcrumbs, which share the wrapper, never load this code.
 */
import { isSecretKey, SCRUB_TOKEN, SCRUB_TRUNCATED, scrubDeep, scrubText } from "@cohorly/core";

/** Bytes of a body kept; the rest is cut and the body ends in `[truncated]`. */
export const MAX_BODY_BYTES = 16 * 1024;
/** How long the SDK waits for its copy of a fetch response body. */
export const BODY_READ_TIMEOUT_MS = 2000;
export const BODY_UNAVAILABLE = "[unavailable]";
export const BODY_FORM_DATA = "[form-data]";
export const BODY_STREAM = "[stream]";

/** What an observer wants recorded beyond method, URL, status and duration. */
export interface NetworkDetail {
  headers: boolean;
  bodies: boolean;
}

/** One side of a request, as recorded. */
export interface CapturedMessage {
  /** Lower-case names, secret ones removed, values scrubbed. */
  headers?: Record<string, string>;
  /** Scrubbed text, at most 16 KiB, or a marker (`[binary N bytes]`, `[form-data]`, ...). */
  body?: string;
}

const ALWAYS_REMOVED = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);
const SECRET_PART = /token|secret|password|auth|session/;

/** Headers that are never recorded, in either direction, whatever the options. */
export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return ALWAYS_REMOVED.has(lower) || SECRET_PART.test(lower) || isSecretKey(lower);
}

/** Sanitized copy of a header map: lower-case names, secrets removed, values scrubbed. */
export function cleanHeaders(entries: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    if (typeof rawName !== "string" || typeof rawValue !== "string") continue;
    const name = rawName.trim().toLowerCase();
    if (!name || isSensitiveHeader(name)) continue;
    const value = scrubText(rawValue);
    // Repeated headers are joined like Headers.get() does.
    out[name] = name in out ? `${out[name]}, ${value}` : value;
  }
  return out;
}

/** The entries of whatever `fetch` accepts as `headers` (Headers, pairs or a record). */
export function headerEntries(init: unknown): [string, string][] {
  if (init === null || init === undefined) return [];
  const out: [string, string][] = [];
  if (typeof Headers !== "undefined" && init instanceof Headers) {
    init.forEach((value, name) => {
      out.push([name, value]);
    });
    return out;
  }
  if (Array.isArray(init)) {
    for (const pair of init) {
      if (Array.isArray(pair) && pair.length === 2) out.push([String(pair[0]), String(pair[1])]);
    }
    return out;
  }
  if (typeof init === "object") {
    for (const [name, value] of Object.entries(init as Record<string, unknown>)) {
      if (value !== undefined && value !== null) out.push([name, String(value)]);
    }
  }
  return out;
}

/** `getAllResponseHeaders()` text as entries. */
export function rawHeaderEntries(raw: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    out.push([line.slice(0, at), line.slice(at + 1).trim()]);
  }
  return out;
}

function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

export function isEventStream(contentType: string | null | undefined): boolean {
  return mediaType(contentType) === "text/event-stream";
}

/** Text bodies the SDK reads; anything else is recorded as a size marker. */
export function isTextType(contentType: string | null | undefined): boolean {
  const type = mediaType(contentType);
  if (!type || type === "text/event-stream") return false;
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/x-www-form-urlencoded" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

export function binaryMarker(size: number | undefined): string {
  return size !== undefined && Number.isFinite(size) && size >= 0
    ? `[binary ${Math.round(size)} bytes]`
    : "[binary]";
}

/** `Content-Length` as a number, or undefined. */
export function contentLength(value: string | null | undefined): number | undefined {
  if (!value || !/^\s*\d+\s*$/.test(value)) return undefined;
  return Number(value);
}

// `"password": "x"` in JSON that was cut, so never parsed: scrubText alone
// only knows `password=x`. The value is a string or a bare scalar.
// A bare scalar never starts an object or array, so a non-secret parent
// (`"data": {"password": ...}`) is not matched and its nested pairs still are.
const JSON_PAIR = /"((?:[^"\\]|\\.){1,64})"(\s*:\s*)("(?:[^"\\]|\\.)*"?|[^,{}[\]\s"]+)/g;

function scrubJsonPairs(text: string): string {
  return text.replace(JSON_PAIR, (match, key: string, colon: string) =>
    isSecretKey(key) || isSecretEscapedKey(key) ? `"${key}"${colon}"${SCRUB_TOKEN}"` : match,
  );
}

/** A key written with escapes (`"pass\u0077ord"`) is tested as JSON reads it. */
function isSecretEscapedKey(key: string): boolean {
  if (!key.includes("\\")) return false;
  try {
    const name: unknown = JSON.parse(`"${key}"`);
    return typeof name === "string" && isSecretKey(name);
  } catch {
    return false;
  }
}

function looksLikeJson(type: string, text: string): boolean {
  if (type === "application/json" || type.endsWith("+json")) return true;
  const start = text.trimStart()[0];
  return start === "{" || start === "[";
}

/** `a=1&password=x`: the value of a secret key becomes `[token]`, the rest as it was. */
function scrubForm(text: string): string {
  const pairs = text.split("&").map((pair) => {
    const at = pair.indexOf("=");
    if (at < 0) return pair;
    let name = pair.slice(0, at);
    try {
      name = decodeURIComponent(name.replace(/\+/g, " "));
    } catch {
      // a malformed escape: test the raw name
    }
    return isSecretKey(name) ? `${pair.slice(0, at)}=${SCRUB_TOKEN}` : pair;
  });
  return scrubText(pairs.join("&"));
}

/**
 * A scrubbed body from text: JSON that fits whole goes through `scrubDeep`
 * (values under secret keys become `[token]`), every text through
 * `scrubText`, and a body cut at the limit ends in `[truncated]`.
 */
export function textBody(text: string, contentType: string | null | undefined, cut = false): string {
  const type = mediaType(contentType);
  const clipped = clipText(text);
  const truncated = cut || clipped.length < text.length;
  if (truncated) {
    // Never parsed: a form by its pairs, anything else by the JSON pair pattern.
    const scrubbed =
      type === "application/x-www-form-urlencoded" ? scrubForm(clipped) : scrubText(scrubJsonPairs(clipped));
    return `${scrubbed}${SCRUB_TRUNCATED}`;
  }
  if (looksLikeJson(type, clipped)) {
    try {
      return JSON.stringify(scrubDeep(JSON.parse(clipped)));
    } catch {
      return scrubText(scrubJsonPairs(clipped));
    }
  }
  if (type === "application/x-www-form-urlencoded") return scrubForm(clipped);
  return scrubText(clipped);
}

/** At most MAX_BODY_BYTES of UTF-8, never splitting a character. */
export function clipText(text: string): string {
  // A UTF-16 unit is at most 3 UTF-8 bytes: short text needs no encoding.
  if (text.length * 3 <= MAX_BODY_BYTES) return text;
  const head = text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
  const bytes = new TextEncoder().encode(head);
  if (bytes.length <= MAX_BODY_BYTES) return head;
  return decodeHead(bytes.subarray(0, MAX_BODY_BYTES));
}

/** Bytes of `text` in UTF-8, without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Decodes bytes, dropping a character cut at the end. */
function decodeHead(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes, { stream: true });
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value);
}

/**
 * The recorded form of a request body as the page passed it to fetch() or
 * XHR send(). Never reads a Blob or a stream: those become markers.
 */
export function requestBody(body: unknown, contentType: string | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    if (!contentType) return textBody(body, looksLikeJson("", body) ? "application/json" : "text/plain");
    // A string the page declared as something else is recorded like that type.
    if (isEventStream(contentType)) return BODY_STREAM;
    if (!isTextType(contentType)) return binaryMarker(utf8Length(body));
    return textBody(body, contentType);
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return textBody(body.toString(), "application/x-www-form-urlencoded");
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) return BODY_FORM_DATA;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return BODY_STREAM;
  if (typeof Blob !== "undefined" && body instanceof Blob) return binaryMarker(body.size);
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return binaryMarker(body.byteLength);
  }
  if (isArrayBufferView(body)) return binaryMarker(body.byteLength);
  return binaryMarker(undefined);
}

/** Bytes read from the SDK's copy of a body. */
interface ReadResult {
  bytes: Uint8Array;
  /** The SDK stopped before the end. */
  cut: boolean;
}

/**
 * Reads at most `limit` bytes of `stream` into one buffer of `limit` bytes,
 * copying only what still fits from each chunk (a chunk is never kept), then
 * cancels it as soon as a byte past `limit` arrives. A body of exactly
 * `limit` bytes is not cut: at the limit one more read tells whether it
 * ended. Gives up after `timeoutMs` (cancelling too): undefined, or a cut
 * result when the buffer was already full. Never throws.
 */
export function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit = MAX_BODY_BYTES,
  timeoutMs = BODY_READ_TIMEOUT_MS,
): Promise<ReadResult | undefined> {
  return new Promise((resolve) => {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = stream.getReader();
    } catch {
      resolve(undefined);
      return;
    }
    let settled = false;
    const buffer = new Uint8Array(limit);
    let total = 0;
    const cancel = () => {
      try {
        // Cancelling this branch of the tee leaves the page's branch untouched.
        reader.cancel().catch(() => {});
      } catch {
        // already released or errored
      }
    };
    const finish = (result: ReadResult | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      cancel();
      finish(total >= limit ? { bytes: buffer, cut: true } : undefined);
    }, timeoutMs);
    const pump = (): void => {
      reader.read().then(
        ({ done, value }) => {
          if (settled) return;
          if (value && value.byteLength > 0) {
            const room = limit - total;
            if (value.byteLength > room) {
              if (room > 0) buffer.set(value.subarray(0, room), total);
              total = limit;
              cancel();
              finish({ bytes: buffer, cut: true });
              return;
            }
            buffer.set(value, total);
            total += value.byteLength;
          }
          if (done) {
            finish({ bytes: buffer.subarray(0, total), cut: false });
            return;
          }
          pump();
        },
        () => finish(undefined),
      );
    };
    pump();
  });
}

interface ResponseLike {
  headers?: { get?(name: string): string | null; forEach?: Headers["forEach"] };
  body?: unknown;
  clone?: () => ResponseLike;
}

/** Response headers of a fetch, sanitized. */
export function fetchResponseHeaders(value: unknown): Record<string, string> {
  const response = value as ResponseLike;
  const entries: [string, string][] = [];
  try {
    response.headers?.forEach?.((value, name) => {
      entries.push([name, value]);
    });
  } catch {
    // an exotic Response: no headers
  }
  return cleanHeaders(entries);
}

/**
 * The recorded body of a fetch response. Must be called before the page can
 * touch the body (synchronously in the wrapper's then), since it clones. Only
 * text types are cloned and read; the rest is a marker from Content-Length.
 */
export function fetchResponseBody(value: unknown): Promise<string | undefined> {
  const response = value as ResponseLike;
  let contentType: string | null = null;
  let length: number | undefined;
  try {
    contentType = response.headers?.get?.("content-type") ?? null;
    length = contentLength(response.headers?.get?.("content-length"));
  } catch {
    return Promise.resolve(BODY_UNAVAILABLE);
  }
  if (response.body === null) return Promise.resolve(undefined);
  if (isEventStream(contentType)) return Promise.resolve(BODY_STREAM);
  if (!isTextType(contentType)) return Promise.resolve(binaryMarker(length));
  let copy: ResponseLike | undefined;
  try {
    copy = response.clone?.();
  } catch {
    // clone() throws once the body was used
    return Promise.resolve(BODY_UNAVAILABLE);
  }
  const stream = copy?.body;
  if (!stream || typeof (stream as ReadableStream).getReader !== "function") {
    return Promise.resolve(BODY_UNAVAILABLE);
  }
  return readCapped(stream as ReadableStream<Uint8Array>).then((read) => {
    if (!read) return BODY_UNAVAILABLE;
    if (read.bytes.byteLength === 0 && !read.cut) return undefined;
    return textBody(decodeHead(read.bytes), contentType, read.cut);
  });
}

/** What a fetch() call sends, read before the original fetch runs. */
export interface FetchRequestCapture {
  message: CapturedMessage;
  /** A `Request` object's body, read from its clone; the report waits for it. */
  body?: Promise<string | undefined>;
}

function contentTypeOf(entries: [string, string][]): string | undefined {
  return entries.find(([name]) => name.toLowerCase() === "content-type")?.[1];
}

/**
 * Headers and body the page passes to fetch(), as far as `detail` asks. Must
 * run before the original fetch: a `Request` object's body is cloned here,
 * since fetch() consumes it (a clone that throws, the body already used, is
 * `[unavailable]`).
 */
export function fetchRequest(input: unknown, init: unknown, detail: NetworkDetail): FetchRequestCapture {
  const options = (init ?? {}) as { headers?: unknown; body?: unknown };
  const fromRequest = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
  // fetch() uses init.headers instead of the Request's when both are given.
  const entries = headerEntries(options.headers ?? fromRequest?.headers);
  const contentType = contentTypeOf(entries) ?? fromRequest?.headers.get("content-type") ?? undefined;
  const message: CapturedMessage = {};
  if (detail.headers) message.headers = cleanHeaders(entries);
  if (!detail.bodies) return { message };
  if (options.body !== undefined && options.body !== null) {
    const body = requestBody(options.body, contentType);
    if (body !== undefined) message.body = body;
    return { message };
  }
  if (!fromRequest || fromRequest.body === null) return { message };
  if (isEventStream(contentType)) {
    message.body = BODY_STREAM;
    return { message };
  }
  if (contentType && !isTextType(contentType)) {
    message.body = binaryMarker(undefined);
    return { message };
  }
  let stream: ReadableStream<Uint8Array> | null | undefined;
  try {
    stream = fromRequest.clone().body;
  } catch {
    message.body = BODY_UNAVAILABLE;
    return { message };
  }
  if (!stream) return { message };
  const type = contentType ?? "text/plain";
  const body = readCapped(stream).then((read) => {
    if (!read) return BODY_UNAVAILABLE;
    if (read.bytes.byteLength === 0 && !read.cut) return undefined;
    return textBody(decodeHead(read.bytes), type, read.cut);
  });
  return { message, body };
}

/** What the page sent on an XHR: headers from setRequestHeader(), body from send(). */
export function xhrRequest(headers: [string, string][], body: unknown, detail: NetworkDetail): CapturedMessage {
  const out: CapturedMessage = {};
  if (detail.headers) out.headers = cleanHeaders(headers);
  if (detail.bodies) {
    const recorded = requestBody(body, contentTypeOf(headers));
    if (recorded !== undefined) out.body = recorded;
  }
  return out;
}

interface XhrLike {
  responseType?: XMLHttpRequestResponseType;
  responseText?: string;
  response?: unknown;
  getResponseHeader?(name: string): string | null;
  getAllResponseHeaders?(): string;
}

export function xhrResponseHeaders(xhr: XhrLike): Record<string, string> {
  try {
    return cleanHeaders(rawHeaderEntries(xhr.getAllResponseHeaders?.() ?? ""));
  } catch {
    return {};
  }
}

/** The recorded body of a finished XHR (read from what the XHR already holds). */
export function xhrResponseBody(xhr: XhrLike): string | undefined {
  try {
    const contentType = xhr.getResponseHeader?.("content-type") ?? null;
    const length = contentLength(xhr.getResponseHeader?.("content-length"));
    if (isEventStream(contentType)) return BODY_STREAM;
    const type = xhr.responseType ?? "";
    if (type === "" || type === "text") {
      const text = xhr.responseText ?? "";
      if (text === "") return undefined;
      return isTextType(contentType) ? textBody(text, contentType) : binaryMarker(length);
    }
    if (type === "json") {
      // The object the browser already parsed: stringifying it costs time in
      // proportion to the response, synchronously, but only for an allowed URL
      // with bodies on (the text itself is no longer available).
      if (xhr.response === null || xhr.response === undefined) return undefined;
      return textBody(JSON.stringify(xhr.response), "application/json");
    }
    const response = xhr.response;
    if (response === null || response === undefined) return undefined;
    if (typeof Blob !== "undefined" && response instanceof Blob) return binaryMarker(response.size);
    if (typeof ArrayBuffer !== "undefined" && response instanceof ArrayBuffer) {
      return binaryMarker(response.byteLength);
    }
    return binaryMarker(length);
  } catch {
    return BODY_UNAVAILABLE;
  }
}

/**
 * Everything network.ts needs to record headers and bodies, passed in by
 * session replay as its observer's `capture` (network.ts imports only the type).
 */
export const networkCapture = {
  fetchRequest,
  fetchResponseHeaders,
  fetchResponseBody,
  xhrRequest,
  xhrResponseHeaders,
  xhrResponseBody,
};

export type NetworkCapture = typeof networkCapture;
