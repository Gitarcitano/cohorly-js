/**
 * Opt-in automatic capture (`captureExceptions: true`): the global JS error
 * handler (`ErrorUtils`), Hermes' unhandled promise rejection tracker, and
 * automatic breadcrumbs for AppState changes and failed fetches. Never
 * records request or response bodies, headers, query strings or fragments.
 */
import type { BreadcrumbInput } from "@cohorly/core";
import { isErrorLike, stringifyValue } from "@cohorly/core";
import type { AppStateLike } from "../types.js";

/**
 * How long the global handler waits for a fatal to reach AsyncStorage before
 * handing the error to the previous handler, which usually kills the app.
 */
export const FATAL_PERSIST_TIMEOUT_MS = 1500;

/** Paths under apiHost the SDK itself calls; never recorded as fetch breadcrumbs. */
const SDK_ENDPOINTS = ["/track", "/engage", "/alias", "/flags/evaluate"];

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler?: () => GlobalHandler | undefined;
  setGlobalHandler: (handler: GlobalHandler) => void;
}

interface HermesInternalLike {
  hasPromise?: () => boolean;
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled: (id: number, rejection: unknown) => void;
    onHandled: (id: number) => void;
  }) => void;
}

export interface ExceptionCaptureHooks {
  /**
   * Captures an error from the global handler. The returned promise settles
   * once the exception is persisted; the handler waits for it at most
   * {@link FATAL_PERSIST_TIMEOUT_MS}.
   */
  onGlobalError(error: unknown, isFatal: boolean): Promise<void>;
  onUnhandledRejection(reason: unknown): void;
  addBreadcrumb(crumb: BreadcrumbInput): void;
  apiHost: string;
  appState: AppStateLike | undefined;
}

/** The SDK's handlers must never throw into the app. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // swallowed on purpose: a failure here must not break the app
  }
}

function isDev(): boolean {
  return typeof __DEV__ !== "undefined" && Boolean(__DEV__);
}

declare const __DEV__: boolean | undefined;

function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.catch(() => {}), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The warning React Native's own dev-mode tracker prints; kept since ours replaces it. */
function warnUnhandledRejection(id: number, rejection: unknown): void {
  let message: string;
  let stack: string | undefined;
  if (isErrorLike(rejection)) {
    const name = typeof rejection.name === "string" ? rejection.name : "Error";
    message = `${name}: ${String(rejection.message)}`;
    stack = typeof rejection.stack === "string" ? rejection.stack : undefined;
  } else {
    message = stringifyValue(rejection);
  }
  console.warn(
    `Possible Unhandled Promise Rejection (id: ${id}):\n${message}\n${stack ?? ""}`,
  );
}

/** String slicing, not `new URL()`: React Native's URL polyfill has no `pathname` on older versions. */
function withoutQuery(url: string): string {
  return url.split(/[?#]/)[0];
}

/** A URL string, a Request (`url`) or a URL object (`href`). */
function requestUrl(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const candidate = input as { url?: unknown; href?: unknown } | null;
  const url = candidate?.url ?? candidate?.href;
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

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/**
 * The Hermes tracker cannot be removed, only replaced, so one tracker is
 * installed per process and forwards to whichever installation is active.
 */
let rejectionSink: ((reason: unknown) => void) | null = null;
let activeTeardown: (() => void) | null = null;

/** Tears down the active installation, if any (init() calls this before a new client). */
export function teardownExceptionCapture(): void {
  activeTeardown?.();
}

/**
 * Installs the handlers and returns their teardown. Idempotent across
 * clients: installing again tears the previous installation down first, so
 * handlers never stack. Teardown restores `ErrorUtils`' handler and `fetch`
 * only while ours are still the installed ones (something that wrapped them
 * afterwards keeps working; our inert layer then just passes through).
 */
export function setupExceptionCapture(hooks: ExceptionCaptureHooks): () => void {
  teardownExceptionCapture();
  let active = true;
  const cleanups: (() => void)[] = [];
  const g = globalThis as Record<string, unknown>;

  const errorUtils = g.ErrorUtils as ErrorUtilsLike | undefined;
  if (errorUtils && typeof errorUtils.setGlobalHandler === "function") {
    let previous: GlobalHandler | undefined;
    try {
      previous = errorUtils.getGlobalHandler?.();
    } catch {
      previous = undefined;
    }
    const handler: GlobalHandler = (error, isFatal) => {
      let called = false;
      const callPrevious = () => {
        if (called) return;
        called = true;
        previous?.(error, isFatal);
      };
      if (!active) {
        callPrevious();
        return;
      }
      let captured: Promise<void>;
      try {
        captured = hooks.onGlobalError(error, isFatal === true);
      } catch {
        captured = Promise.resolve();
      }
      void settleWithin(captured, FATAL_PERSIST_TIMEOUT_MS).then(callPrevious, callPrevious);
    };
    safely(() => errorUtils.setGlobalHandler(handler));
    cleanups.push(() => {
      const current = errorUtils.getGlobalHandler?.();
      if (current === handler && previous) errorUtils.setGlobalHandler(previous);
    });
  }

  const hermes = g.HermesInternal as HermesInternalLike | undefined;
  safely(() => {
    if (
      !hermes ||
      typeof hermes.hasPromise !== "function" ||
      !hermes.hasPromise() ||
      typeof hermes.enablePromiseRejectionTracker !== "function"
    ) {
      return;
    }
    const sink = (reason: unknown) => hooks.onUnhandledRejection(reason);
    rejectionSink = sink;
    cleanups.push(() => {
      if (rejectionSink === sink) rejectionSink = null;
    });
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (id, rejection) =>
        safely(() => {
          if (isDev()) warnUnhandledRejection(id, rejection);
          rejectionSink?.(rejection);
        }),
      onHandled: (id) =>
        safely(() => {
          if (!isDev()) return;
          console.warn(
            `Promise Rejection Handled (id: ${id})\nThis means you can ignore any previous messages of the form "Possible Unhandled Promise Rejection (id: ${id}):"`,
          );
        }),
    });
  });

  const crumb = (input: BreadcrumbInput) =>
    safely(() => {
      if (active) hooks.addBreadcrumb(input);
    });

  safely(() => {
    const subscription = hooks.appState?.addEventListener?.("change", (state: string) =>
      crumb({ category: "app.lifecycle", message: String(state), level: "info" }),
    ) as { remove?: () => void } | undefined;
    cleanups.push(() => subscription?.remove?.());
  });

  // Only the SDK's own endpoints: the app may talk to the same host.
  const sdkBase = withoutQuery(hooks.apiHost).replace(/\/+$/, "");
  const isSdkRequest = (url: string) =>
    SDK_ENDPOINTS.some((endpoint) => withoutQuery(url) === `${sdkBase}${endpoint}`);
  const recordFetch = (method: string, url: string, status: number | undefined) => {
    const shown = withoutQuery(url);
    crumb({
      category: "fetch",
      level: status === undefined || status >= 500 ? "error" : "warning",
      message: `${method} ${shown} ${status ?? "failed"}`,
      data: { method, url: shown, ...(status !== undefined ? { status_code: status } : {}) },
    });
  };
  const original = g.fetch;
  if (typeof original === "function") {
    const wrapped = function patchedFetch(this: unknown, ...args: unknown[]) {
      const result = (original as AnyFunction).apply(this, args);
      if (!active) return result;
      let url: string | undefined;
      let method = "GET";
      try {
        url = requestUrl(args[0]);
        if (url === undefined || isSdkRequest(url)) return result;
        method = requestMethod(args[0], args[1]);
      } catch {
        return result;
      }
      const pending = result as Promise<{ status?: unknown }> | undefined;
      if (typeof pending?.then !== "function") return result;
      const shownUrl = url;
      // Settles exactly like the original: same response, same rejection.
      return pending.then(
        (response) => {
          safely(() => {
            const status = response?.status;
            if (typeof status === "number" && status >= 400) recordFetch(method, shownUrl, status);
          });
          return response;
        },
        (err: unknown) => {
          safely(() => recordFetch(method, shownUrl, undefined));
          throw err;
        },
      );
    };
    g.fetch = wrapped;
    cleanups.push(() => {
      if (g.fetch === wrapped) g.fetch = original;
    });
  }

  const teardown = () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups) safely(cleanup);
    if (activeTeardown === teardown) activeTeardown = null;
  };
  activeTeardown = teardown;
  return teardown;
}
