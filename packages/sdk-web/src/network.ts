/**
 * The one place the web SDK wraps `fetch` and `XMLHttpRequest.prototype.open`.
 * Exception breadcrumbs (VEL-1789) and session replay `$network` events
 * (VEL-1782) both subscribe here, so the page's request functions are wrapped
 * once, whatever is enabled. The wrapper is installed with the first observer
 * and removed with the last one; a wrapped call always settles exactly like
 * the original. Never reads bodies or headers.
 */

/** One finished request. `status` is undefined for a network error or a timeout. */
export interface ObservedRequest {
  kind: "fetch" | "xhr";
  /** Upper-case method. */
  method: string;
  /** The URL as the page passed it (may carry a query: observers strip it). */
  url: string;
  status: number | undefined;
  durationMs: number;
}

export interface NetworkObserver {
  /** Whether this observer wants the request; asked once, when it starts. */
  wants(url: string): boolean;
  /** Called once per wanted request that completed or failed (never for an XHR abort). */
  done(request: ObservedRequest): void;
}

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

/** Absolute URL without query and hash, or undefined when unparseable. */
export function absoluteWithoutQuery(url: string): string | undefined {
  try {
    const parsed = new URL(url, location.href);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** Paths under apiHost the SDK itself calls (breadcrumbs and `$network` both skip them). */
export const SDK_ENDPOINTS = ["/track", "/engage", "/alias", "/flags/evaluate", "/replay"];

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
  return () => {
    if (!observers.delete(observer)) return;
    if (observers.size === 0 && uninstall) {
      const off = uninstall;
      uninstall = null;
      off();
    }
  };
}

/** The observers that want `url`, asked once when the request starts. */
function interested(url: string): NetworkObserver[] {
  const out: NetworkObserver[] = [];
  for (const observer of observers) {
    try {
      if (observer.wants(url)) out.push(observer);
    } catch {
      // an observer that throws does not get the request
    }
  }
  return out;
}

function report(targets: NetworkObserver[], request: ObservedRequest): void {
  for (const observer of targets) {
    // An observer that unsubscribed while the request was in flight is skipped.
    if (observers.has(observer)) safely(() => observer.done(request));
  }
}

function install(): () => void {
  let active = true;
  const cleanups: (() => void)[] = [];

  cleanups.push(
    patchMethod(globalThis, "fetch", (original) =>
      function patchedFetch(this: unknown, ...args: unknown[]) {
        const startedAt = now();
        const result = original.apply(this, args);
        if (!active) return result;
        let url: string | undefined;
        let method = "GET";
        let targets: NetworkObserver[];
        try {
          url = requestUrl(args[0]);
          if (url === undefined) return result;
          targets = interested(url);
          if (targets.length === 0) return result;
          method = requestMethod(args[0], args[1]);
        } catch {
          return result;
        }
        const pending = result as Promise<{ status?: unknown }> | undefined;
        if (typeof pending?.then !== "function") return result;
        const shownUrl = url;
        const finish = (status: number | undefined) =>
          safely(() => {
            if (!active) return;
            report(targets, {
              kind: "fetch",
              method,
              url: shownUrl,
              status,
              durationMs: Math.max(0, Math.round(now() - startedAt)),
            });
          });
        // The caller gets a promise that settles exactly like the original,
        // so an unawaited failed fetch still reaches `unhandledrejection`.
        return pending.then(
          (response) => {
            const status = response?.status;
            finish(typeof status === "number" ? status : undefined);
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
    cleanups.push(
      patchMethod(XMLHttpRequest.prototype, "open", (original) =>
        function patchedOpen(this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args);
          if (active && hasIdentity(this)) {
            const xhr = this as XMLHttpRequest;
            safely(() => {
              watching.get(xhr)?.();
              watching.delete(xhr);
              const target = args[1];
              if (target === undefined || target === null) return;
              const url = String(target);
              const targets = interested(url);
              if (targets.length === 0) return;
              watching.set(
                xhr,
                watchXhr(xhr, String(args[0]).toUpperCase(), url, targets, () =>
                  watching.delete(xhr),
                ),
              );
            });
          }
          return result;
        },
      ),
    );
  }

  // Listeners, never onload/onreadystatechange, so the app's own handlers are
  // untouched. Capturing too, for engines that run those first at the target.
  // They come off at the first outcome; the returned function removes them early.
  const watchXhr = (
    xhr: XMLHttpRequest,
    method: string,
    url: string,
    targets: NetworkObserver[],
    finished: () => void,
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
      detach();
      finished();
      if (!active || outcome === "abort") return;
      report(targets, {
        kind: "xhr",
        method,
        url,
        status: outcome === "failed" ? undefined : xhr.status,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
      });
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
    for (const cleanup of cleanups) safely(cleanup);
  };
}
