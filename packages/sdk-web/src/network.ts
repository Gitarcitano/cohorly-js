/**
 * The one place the web SDK wraps `fetch` and `XMLHttpRequest.prototype.open`.
 * Exception breadcrumbs (VEL-1789) and session replay `$network` events
 * (VEL-1782) both subscribe here, so the page's request functions are wrapped
 * once, whatever is enabled. The wrapper is installed with the first observer
 * and removed with the last one; a wrapped call always settles exactly like
 * the original. Reads no header and no body unless an observer asks for them
 * through `detail` (session replay's opt-in `network` option, VEL-2145): the
 * breadcrumbs never do, so for them nothing is read and no response is cloned.
 * The code that reads them (network-capture.ts) comes in with the observer
 * that asks (`capture`), so this module, which the breadcrumbs load, only
 * imports its types.
 */
import type {
  CapturedMessage,
  FetchRequestCapture,
  NetworkCapture,
  NetworkDetail,
} from "./network-capture.js";

export type { CapturedMessage, NetworkCapture, NetworkDetail };

/** One finished request. `status` is undefined for a network error or a timeout. */
export interface ObservedRequest {
  kind: "fetch" | "xhr";
  /** Upper-case method. */
  method: string;
  /** The URL as the page passed it (may carry a query: observers strip it). */
  url: string;
  status: number | undefined;
  durationMs: number;
  /**
   * Only for an observer whose `detail` asked for headers or bodies: what was
   * sent and received, already sanitized (network-capture.ts), and the unix ms
   * the response (or the failure) arrived, since the report can come up to
   * 2 s later while the bodies are read. After a redirect, `response` carries
   * only what `detail` still asks for the final URL (nothing: an empty one).
   */
  request?: CapturedMessage;
  response?: CapturedMessage;
  ts?: number;
}

export interface NetworkObserver {
  /** Whether this observer wants the request; asked once, when it starts. */
  wants(url: string): boolean;
  /** Called once per wanted request that completed or failed (never for an XHR abort). */
  done(request: ObservedRequest): void;
  /**
   * Headers and/or bodies this observer wants for a request it wants, asked
   * once when it starts (and again for the final URL of a redirected fetch).
   * Absent or undefined: none, and the request is observed exactly as without
   * this method. Only honoured with `capture`.
   */
  detail?(url: string): NetworkDetail | undefined;
  /**
   * A report of this observer's that waits for bodies: `reported` settles
   * once `done` ran (at most 2 s after the response). Called before the page
   * gets the response.
   */
  reading?(reported: Promise<void>): void;
  /**
   * The reading code (network-capture.ts `networkCapture`), passed by the
   * observer that asks for detail so this module never imports it. The
   * request uses the one of its first observer with detail.
   */
  capture?: NetworkCapture;
}

/** What the page sent on an XHR some observer wants detail of. */
interface Outgoing {
  detail: NetworkDetail;
  capture: NetworkCapture;
  headers: [string, string][];
  /** Set by send(). */
  message?: CapturedMessage;
}

/** What one observer asked for, kept with it for the report. */
interface Target {
  observer: NetworkObserver;
  detail: NetworkDetail | undefined;
  /** What it still asks for the response, after a redirect; absent: `detail`. */
  responseDetail?: NetworkDetail;
}

const NOTHING: NetworkDetail = { headers: false, bodies: false };

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** `this` of a patched XHR method: only objects can key the per-request WeakMaps. */
function hasIdentity(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Replaces `target[key]` with a wrapper and returns its restore. Restoring
 * only puts the original back while the wrapper is still the installed
 * function: if something wrapped it afterwards, unwrapping would drop that
 * layer too, so the (by then inert) wrapper stays in the chain.
 */
export function patchMethod(
  target: object,
  key: string,
  wrap: (original: AnyFunction) => AnyFunction,
): () => void {
  const host = target as Record<string, unknown>;
  const original = host[key];
  if (typeof original !== "function") return () => {};
  const wrapped = wrap(original as AnyFunction);
  host[key] = wrapped;
  return () => {
    if (host[key] === wrapped) host[key] = original;
  };
}

/** The SDK's handlers must never throw into the page. */
export function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // swallowed on purpose: a failure here must not break the app
  }
}

function requestUrl(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  const url = (input as { url?: unknown } | null)?.url;
  return typeof url === "string" ? url : undefined;
}

function requestMethod(input: unknown, init: unknown): string {
  const fromInit = (init as { method?: unknown } | null | undefined)?.method;
  const fromRequest = (input as { method?: unknown } | null | undefined)?.method;
  const method =
    typeof fromInit === "string"
      ? fromInit
      : typeof fromRequest === "string"
        ? fromRequest
        : "GET";
  return method.toUpperCase();
}

/** What a relative URL resolves against: the document's base (`<base href>`), else the page. */
function baseUrl(): string {
  try {
    if (typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI) {
      return document.baseURI;
    }
  } catch {
    // no document
  }
  return location.href;
}

function absoluteHref(url: string): string {
  try {
    return new URL(url, baseUrl()).href;
  } catch {
    return url;
  }
}

/** Absolute URL without query and hash, or undefined when unparseable. */
export function absoluteWithoutQuery(url: string): string | undefined {
  try {
    const parsed = new URL(url, baseUrl());
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** Paths under apiHost the SDK itself calls (breadcrumbs and `$network` both skip them). */
export const SDK_ENDPOINTS = ["/track", "/engage", "/alias", "/flags/evaluate", "/replay", "/replay/config"];

/**
 * Whether a URL is one of the SDK's own requests to `apiHost`. Only the SDK's
 * endpoints: apiHost may be the page's own origin (a same-origin proxy), and
 * the app's other requests there still count. apiHost may also be relative
 * (`/api/cohorly` behind the Next.js proxy).
 */
export function sdkRequestMatcher(apiHost: string): (url: string) => boolean {
  const base = absoluteWithoutQuery(apiHost)?.replace(/\/+$/, "");
  if (base === undefined) return () => false;
  return (url) => {
    const absolute = absoluteWithoutQuery(url);
    return (
      absolute !== undefined && SDK_ENDPOINTS.some((endpoint) => absolute === `${base}${endpoint}`)
    );
  };
}

const now = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

const observers = new Set<NetworkObserver>();
let uninstall: (() => void) | null = null;
/** Wraps XHR setRequestHeader() and send(), once per installation; set by install(). */
let ensureOutgoing: (() => void) | null = null;

/**
 * Subscribes an observer and returns its unsubscribe. The first subscriber
 * installs the wrappers, the last unsubscribe removes them, so a re-init
 * that unsubscribes then subscribes installs a fresh wrapper and requests
 * opened under the previous one are not reported. No-op during SSR.
 */
export function observeNetwork(observer: NetworkObserver): () => void {
  if (typeof window === "undefined") return () => {};
  observers.add(observer);
  if (!uninstall) uninstall = install();
  if (observer.capture) ensureOutgoing?.();
  return () => {
    if (!observers.delete(observer)) return;
    if (observers.size === 0 && uninstall) {
      const off = uninstall;
      uninstall = null;
      off();
    }
  };
}

/** What `observer` asks for `url`: undefined without `capture`, when it asks nothing or throws. */
function askDetail(observer: NetworkObserver, url: string): NetworkDetail | undefined {
  if (!observer.capture) return undefined;
  try {
    const asked = observer.detail?.(url);
    if (asked && (asked.headers === true || asked.bodies === true)) {
      return { headers: asked.headers === true, bodies: asked.bodies === true };
    }
  } catch {
    // a detail that throws gets none
  }
  return undefined;
}

/** The observers that want `url`, and the detail each asked for, once when the request starts. */
function interested(url: string): Target[] {
  const out: Target[] = [];
  for (const observer of observers) {
    try {
      if (!observer.wants(url)) continue;
    } catch {
      // an observer that throws does not get the request
      continue;
    }
    out.push({ observer, detail: askDetail(observer, url) });
  }
  return out;
}

/** The reading code of the first target with detail. */
function captureOf(targets: Target[]): NetworkCapture | undefined {
  return targets.find((target) => target.detail)?.observer.capture;
}

/** Whether some observer could ask for detail at all. */
function capturing(): boolean {
  for (const observer of observers) if (observer.capture) return true;
  return false;
}

/** The union of what was asked, or undefined when nothing was. */
function wanted(details: (NetworkDetail | undefined)[]): NetworkDetail | undefined {
  let headers = false;
  let bodies = false;
  for (const detail of details) {
    headers ||= detail?.headers === true;
    bodies ||= detail?.bodies === true;
  }
  return headers || bodies ? { headers, bodies } : undefined;
}

/** Only the parts this observer asked for. */
function partFor(message: CapturedMessage | undefined, detail: NetworkDetail): CapturedMessage {
  const out: CapturedMessage = {};
  if (detail.headers && message?.headers) out.headers = message.headers;
  if (detail.bodies && message?.body !== undefined) out.body = message.body;
  return out;
}

function report(targets: Target[], request: ObservedRequest): void {
  const { request: sent, response: received, ts, ...basic } = request;
  for (const { observer, detail, responseDetail } of targets) {
    // An observer that unsubscribed while the request was in flight is skipped.
    if (!observers.has(observer)) continue;
    // Each observer sees only what it asked for: one without detail gets the
    // basic shape, never another observer's headers or bodies.
    const view: ObservedRequest = detail
      ? {
          ...basic,
          request: partFor(sent, detail),
          ...(received ? { response: partFor(received, responseDetail ?? detail) } : {}),
          ...(ts !== undefined ? { ts } : {}),
        }
      : basic;
    safely(() => observer.done(view));
  }
}

/** What the fetch wrapper decided when the request started. */
interface Prepared {
  url: string;
  method: string;
  targets: Target[];
  capture?: NetworkCapture;
  /** What was sent, only when some target asked for detail. */
  sent?: FetchRequestCapture;
}

/** The observers of a fetch() call and what it sends; null when nobody wants it. */
function prepare(args: unknown[]): Prepared | null {
  try {
    const url = requestUrl(args[0]);
    if (url === undefined) return null;
    const targets = interested(url);
    if (targets.length === 0) return null;
    const method = requestMethod(args[0], args[1]);
    const detail = wanted(targets.map((target) => target.detail));
    const capture = detail ? captureOf(targets) : undefined;
    if (!detail || !capture) return { url, method, targets };
    return { url, method, targets, capture, sent: capture.fetchRequest(args[0], args[1], detail) };
  } catch {
    return null;
  }
}

/** A `Request` object carrying a body that init does not replace: fetch() will consume it. */
function sendsRequestBody(args: unknown[]): boolean {
  try {
    const input = args[0];
    if (typeof Request === "undefined" || !(input instanceof Request)) return false;
    const initBody = (args[1] as { body?: unknown } | null | undefined)?.body;
    return input.body !== null && (initBody === undefined || initBody === null);
  } catch {
    return false;
  }
}

/** The final URL of a fetch response when it differs from the requested one (a redirect). */
function redirectedTo(response: unknown, requested: string): string | undefined {
  try {
    const final = (response as { url?: unknown } | null)?.url;
    if (typeof final !== "string" || final === "") return undefined;
    return final !== absoluteHref(requested) ? final : undefined;
  } catch {
    return undefined;
  }
}

function install(): () => void {
  let active = true;
  const cleanups: (() => void)[] = [];

  cleanups.push(
    patchMethod(globalThis, "fetch", (original) =>
      function patchedFetch(this: unknown, ...args: unknown[]) {
        const startedAt = now();
        // fetch() consumes a Request object's body, so its clone must be taken
        // first: for that one case, and only when some observer can read
        // detail at all, the observers are asked before the original runs.
        // Every other call runs the original first, exactly as without detail.
        const early = active && capturing() && sendsRequestBody(args) ? prepare(args) : undefined;
        const result = original.apply(this, args);
        if (!active) return result;
        const prepared = early !== undefined ? early : prepare(args);
        if (!prepared) return result;
        const pending = result as Promise<{ status?: unknown }> | undefined;
        if (typeof pending?.then !== "function") return result;
        const { url, method, targets, capture, sent } = prepared;
        // Observers without detail (the breadcrumbs) get the request the moment
        // it settles; only those with detail wait for the bodies.
        // (A target has detail only with a capture, so `sent` is there for them.)
        const plain = targets.filter((target) => !target.detail);
        const detailed = targets.filter((target) => target.detail);
        const finish = (status: number | undefined, response?: unknown) =>
          safely(() => {
            if (!active) return;
            const basic: ObservedRequest = {
              kind: "fetch",
              method,
              url,
              status,
              durationMs: Math.max(0, Math.round(now() - startedAt)),
            };
            report(plain, basic);
            if (detailed.length === 0 || !sent || !capture) return;
            const full: ObservedRequest = { ...basic, ts: Date.now(), request: { ...sent.message } };
            let responseBody: Promise<string | undefined> | undefined;
            if (response !== undefined) {
              // After a redirect, each observer is asked again for the final
              // URL: one that no longer wants detail gets an empty response.
              const final = redirectedTo(response, url);
              if (final !== undefined) {
                for (const target of detailed) {
                  const again = askDetail(target.observer, final);
                  target.responseDetail = {
                    headers: target.detail?.headers === true && again?.headers === true,
                    bodies: target.detail?.bodies === true && again?.bodies === true,
                  };
                }
              }
              const need = wanted(detailed.map((target) => target.responseDetail ?? target.detail ?? NOTHING));
              const received: CapturedMessage = {};
              if (need?.headers) received.headers = capture.fetchResponseHeaders(response);
              // Cloned here, before the page gets the response; read in the
              // background, so the page's promise resolves exactly when it did.
              if (need?.bodies) responseBody = capture.fetchResponseBody(response);
              full.response = received;
            }
            if (!sent.body && !responseBody) {
              report(detailed, full);
              return;
            }
            // Both reads stop at 16 KiB or 2 s; the request's started before
            // the fetch, so the report waits at most 2 s after the response.
            const done = () => {
              if (active) report(detailed, full);
            };
            const reported = Promise.all([sent.body, responseBody]).then(([requestText, responseText]) => {
              if (requestText !== undefined && full.request) full.request.body = requestText;
              if (responseText !== undefined && full.response) full.response.body = responseText;
              done();
            }, done);
            // Told before the page gets the response, so an error it captures
            // right away can wait for this request's report.
            for (const { observer } of detailed) safely(() => observer.reading?.(reported));
          });
        // The caller gets a promise that settles exactly like the original,
        // so an unawaited failed fetch still reaches `unhandledrejection`.
        return pending.then(
          (response) => {
            const status = response?.status;
            finish(typeof status === "number" ? status : undefined, response ?? undefined);
            return response;
          },
          (err: unknown) => {
            finish(undefined);
            throw err;
          },
        );
      },
    ),
  );

  if (typeof XMLHttpRequest !== "undefined") {
    // The listeners are attached in open(), not send(): an app usually assigns
    // onload/onreadystatechange between the two, and a handler registered
    // before ours runs first, so a handler that throws on a 5xx would capture
    // its exception before the breadcrumb of that very request existed (seen
    // in Chromium even with a capturing listener). They go on AFTER the native
    // open() returns: reopening a request in flight fires `abort` in some
    // engines (Firefox), which must hit the previous request's listeners, not
    // the new ones. open() also resets a request in flight, so it drops the
    // previous request's listeners.
    // A request opened before a re-install is not reported (the new
    // installation never saw its open()): accepted.
    const watching = new WeakMap<object, () => void>();
    /**
     * What the page sent on a request some observer wants detail of, filled by
     * setRequestHeader() and send(). Only requests asking for detail get an entry.
     */
    const outgoing = new WeakMap<object, Outgoing>();
    cleanups.push(
      patchMethod(XMLHttpRequest.prototype, "open", (original) =>
        function patchedOpen(this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args);
          if (active && hasIdentity(this)) {
            const xhr = this as XMLHttpRequest;
            safely(() => {
              watching.get(xhr)?.();
              watching.delete(xhr);
              outgoing.delete(xhr);
              const target = args[1];
              if (target === undefined || target === null) return;
              const url = String(target);
              const targets = interested(url);
              if (targets.length === 0) return;
              const detail = wanted(targets.map((target) => target.detail));
              const capture = detail ? captureOf(targets) : undefined;
              if (detail && capture) outgoing.set(xhr, { detail, capture, headers: [] });
              const finished = () => {
                watching.delete(xhr);
                outgoing.delete(xhr);
              };
              const method = String(args[0]).toUpperCase();
              watching.set(
                xhr,
                watchXhr(xhr, method, url, targets, finished, () => outgoing.get(xhr)),
              );
            });
          }
          return result;
        },
      ),
    );
    // setRequestHeader() and send() are wrapped only once an observer that can
    // read detail subscribes (session replay with the network option): with the
    // breadcrumbs alone they stay the page's own functions.
    let outgoingPatched = false;
    ensureOutgoing = () => {
      if (outgoingPatched || !active) return;
      outgoingPatched = true;
      // Both only record into `outgoing` and call the native method with the
      // same `this` and arguments. setRequestHeader records after the native call
      // (one that throws records nothing); send records before it, since a
      // synchronous request finishes inside the native send().
        cleanups.push(
          patchMethod(XMLHttpRequest.prototype, "setRequestHeader", (original) =>
          function patchedSetRequestHeader(this: unknown, ...args: unknown[]) {
            const result = original.apply(this, args);
            if (active && hasIdentity(this)) {
              const entry = outgoing.get(this);
              // Kept even for bodies alone: the Content-Type decides how the body reads.
              if (entry) {
                safely(() => entry.headers.push([String(args[0]), String(args[1])]));
              }
            }
            return result;
          },
        ),
      );
      cleanups.push(
        patchMethod(XMLHttpRequest.prototype, "send", (original) =>
          function patchedSend(this: unknown, ...args: unknown[]) {
            if (active && hasIdentity(this)) {
              const entry = outgoing.get(this);
              if (entry) {
                safely(() => {
                  entry.message = entry.capture.xhrRequest(entry.headers, args[0], entry.detail);
                });
              }
            }
            return original.apply(this, args);
          },
        ),
      );
    };
  }

  // Listeners, never onload/onreadystatechange, so the app's own handlers are
  // untouched. Capturing too, for engines that run those first at the target.
  // They come off at the first outcome; the returned function removes them early.
  const watchXhr = (
    xhr: XMLHttpRequest,
    method: string,
    url: string,
    targets: Target[],
    finished: () => void,
    sentBy: () => Outgoing | undefined,
  ): (() => void) => {
    const options = { capture: true } as const;
    let startedAt = now();
    const detach = () => {
      xhr.removeEventListener("loadstart", onStart, options);
      xhr.removeEventListener("readystatechange", onDone, options);
      xhr.removeEventListener("load", onLoad, options);
      xhr.removeEventListener("error", onFailed, options);
      xhr.removeEventListener("timeout", onFailed, options);
      xhr.removeEventListener("abort", onAbort, options);
    };
    const settle = (outcome: "done" | "load" | "failed" | "abort") => {
      // Read before finished() drops the entry.
      const sent = sentBy();
      detach();
      finished();
      if (!active || outcome === "abort") return;
      const request: ObservedRequest = {
        kind: "xhr",
        method,
        url,
        status: outcome === "failed" ? undefined : xhr.status,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
      };
      if (sent) {
        const { detail, capture } = sent;
        request.ts = Date.now();
        request.request = sent.message ?? capture.xhrRequest(sent.headers, undefined, detail);
        if (outcome !== "failed") {
          const body = detail.bodies ? capture.xhrResponseBody(xhr) : undefined;
          request.response = {
            ...(detail.headers ? { headers: capture.xhrResponseHeaders(xhr) } : {}),
            ...(body !== undefined ? { body } : {}),
          };
        }
      }
      report(targets, request);
    };
    // send() fires loadstart; the duration counts from there when it comes.
    const onStart = () => {
      startedAt = now();
    };
    // The DONE readystatechange comes before load, and an app that captures an
    // error from onreadystatechange must find the breadcrumb already there. A
    // DONE with status 0 is a network error, timeout or abort: their own
    // events decide, so it is skipped here.
    const onDone = () =>
      safely(() => {
        if (xhr.readyState === 4 && xhr.status !== 0) settle("done");
      });
    const onLoad = () => safely(() => settle("load"));
    const onFailed = () => safely(() => settle("failed"));
    const onAbort = () => safely(() => settle("abort"));
    xhr.addEventListener("loadstart", onStart, options);
    xhr.addEventListener("readystatechange", onDone, options);
    xhr.addEventListener("load", onLoad, options);
    xhr.addEventListener("error", onFailed, options);
    xhr.addEventListener("timeout", onFailed, options);
    xhr.addEventListener("abort", onAbort, options);
    return detach;
  };

  return () => {
    active = false;
    ensureOutgoing = null;
    for (const cleanup of cleanups) safely(cleanup);
  };
}
