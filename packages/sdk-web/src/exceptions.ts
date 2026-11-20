/**
 * Opt-in automatic error tracking (`captureExceptions: true`): global
 * `error` / `unhandledrejection` handlers, automatic breadcrumbs (navigation,
 * clicks, `console.error`, failed fetches) and a local per-fingerprint rate
 * limit. Never captures request or response bodies, headers, query strings,
 * element text or input values.
 */
import type {
  BreadcrumbInput,
  CaptureExceptionOptions,
  ExceptionListEntry,
} from "@cohorly/core";
import {
  buildExceptionList,
  buildRejectionList,
  createStackFrame,
  ExceptionRateLimiter,
  isErrorLike,
  localFingerprint,
  MAX_DEDUP_FINGERPRINTS,
  stringifyValue,
} from "@cohorly/core";
import { observeConsole } from "./console.js";
import { onNavigation } from "./navigation.js";
import { observeNetwork, safely, sdkRequestMatcher } from "./network.js";

export { EXCEPTION_DEDUP_WINDOW_MS, MAX_EXCEPTIONS_PER_FINGERPRINT } from "@cohorly/core";

const MAX_SELECTOR_LENGTH = 100;
const MAX_SELECTOR_CLASSES = 2;
const CLICK_SELECTOR =
  'a, button, [role="button"], input[type="button"], input[type="submit"]';

/** The page's local rate limit (one client per page; cleared on init()). */
const rateLimiter = new ExceptionRateLimiter();

/**
 * Whether an exception passes the local rate limit (see
 * `ExceptionRateLimiter` in @cohorly/core, shared with React Native).
 */
export function allowException(list: ExceptionListEntry[], now = Date.now()): boolean {
  return rateLimiter.allow(list, now);
}

export type ErrorSource = "global" | "manual";

/** Window in which the same error seen from both sources counts as one. */
export const CROSS_SOURCE_DEDUP_WINDOW_MS = 1000;

/** The last capture QUEUED per local fingerprint and its source; bounded like the rate limit. */
const lastQueued = new Map<string, { source: ErrorSource; at: number }>();

/**
 * Records that `source` queued this exception now. Only a queued capture
 * anchors the window: a dropped duplicate must not extend it, or two sources
 * reporting one recurring error less than a second apart would suppress each
 * other for good instead of reaching the rate limit.
 */
export function markExceptionQueued(
  list: ExceptionListEntry[],
  source: ErrorSource,
  now = Date.now(),
): void {
  if (list.length === 0) return;
  const key = localFingerprint(list);
  lastQueued.delete(key);
  lastQueued.set(key, { source, at: now });
  if (lastQueued.size > MAX_DEDUP_FINGERPRINTS) {
    const oldest = lastQueued.keys().next().value;
    if (oldest !== undefined) lastQueued.delete(oldest);
  }
}

/**
 * Whether the OTHER source queued this local fingerprint within
 * {@link CROSS_SOURCE_DEDUP_WINDOW_MS}. React 18 in development re-runs a
 * failing render and re-reports the error to `window` even though its boundary
 * caught it, each time with a NEW Error object, so identity cannot match them;
 * type + message + crashing frame can. Same-source repeats are never
 * duplicates here (the rate limit handles those).
 */
export function isCrossSourceDuplicate(
  list: ExceptionListEntry[],
  source: ErrorSource,
  now = Date.now(),
): boolean {
  if (list.length === 0) return false;
  const last = lastQueued.get(localFingerprint(list));
  return (
    last !== undefined && last.source !== source && now - last.at < CROSS_SOURCE_DEDUP_WINDOW_MS
  );
}

/** Fingerprints the global handlers reported in the current task. */
let globalsThisRun: Set<string> | null = null;

/**
 * Whether a global handler already reported this local fingerprint in the same
 * task (until a zero-delay timer fires). React 18 in dev re-runs a failing
 * render before its boundary commits, so `window` gets the same error twice
 * before the boundary's own capture arrives; separate tasks (two clicks, two
 * timers) are never merged, they follow the rate limit.
 */
export function isGlobalRepeatInSameRun(list: ExceptionListEntry[]): boolean {
  if (list.length === 0) return false;
  const key = localFingerprint(list);
  if (globalsThisRun?.has(key)) return true;
  if (!globalsThisRun) {
    const run = new Set<string>();
    globalsThisRun = run;
    setTimeout(() => {
      if (globalsThisRun === run) globalsThisRun = null;
    }, 0);
  }
  globalsThisRun.add(key);
  return false;
}

/** Forgets the local rate limit's history (on init()). */
export function resetExceptionRateLimit(): void {
  rateLimiter.reset();
}

/**
 * Forgets the cross-source and same-task history. Not part of init() on
 * purpose: `<CohorlyProvider>` calls init() while rendering, and React 18 in
 * dev replays a failing render, so init() runs again between the errors this
 * history has to match. It expires by itself (1 second, next task).
 */
export function resetCrossSourceDedup(): void {
  lastQueued.clear();
  globalsThisRun = null;
}

export interface ExceptionCaptureHooks {
  /** Queue an exception list (rate limit and default properties applied by the caller). */
  capture(list: ExceptionListEntry[], options: CaptureExceptionOptions): void;
  addBreadcrumb(crumb: BreadcrumbInput): void;
  /** Base URL of the SDK's own requests, which are never recorded as breadcrumbs. */
  apiHost: string;
}

/** `onerror` without an Error object (cross-origin "Script error.", old browsers). */
function syntheticFromErrorEvent(event: ErrorEvent): ExceptionListEntry {
  const raw =
    typeof event.message === "string" && event.message ? event.message : "Unknown error";
  const parsed = /^(?:Uncaught\s+)?([A-Za-z$_][\w$]*Error):\s*([\s\S]*)$/.exec(raw);
  const entry: ExceptionListEntry = {
    type: parsed ? parsed[1] : "Error",
    value: stringifyValue(parsed ? parsed[2] : raw),
    mechanism: { handled: false, type: "onerror", synthetic: true },
  };
  if (event.filename) {
    entry.stacktrace = {
      type: "raw",
      frames: [
        createStackFrame(
          event.filename,
          undefined,
          event.lineno || undefined,
          event.colno || undefined,
        ),
      ],
    };
  }
  return entry;
}

/** Same rule as React Native (`buildRejectionList` in @cohorly/core). */
export function rejectionList(reason: unknown): ExceptionListEntry[] {
  return buildRejectionList(reason);
}

/** Path only; a hash route (`#/cart`) counts, a plain fragment or any query never does. */
function currentRoute(): string {
  const { pathname, hash } = location;
  return hash.startsWith("#/") ? pathname + hash.split("?")[0] : pathname;
}

/** `button#pay`, `a.nav-link`: tag plus id, else up to two classes. Never text. */
function describeElement(el: Element): string {
  let out = el.tagName.toLowerCase();
  if (el.id) {
    out += `#${el.id}`;
  } else {
    const classes = Array.from(el.classList).slice(0, MAX_SELECTOR_CLASSES);
    if (classes.length > 0) out += `.${classes.join(".")}`;
  }
  return out.slice(0, MAX_SELECTOR_LENGTH);
}

function consoleArg(arg: unknown): string {
  if (isErrorLike(arg)) {
    const name = typeof arg.name === "string" ? arg.name : "Error";
    return `${name}: ${String(arg.message)}`;
  }
  return stringifyValue(arg);
}

/** What a fetch breadcrumb shows: the path for same-origin requests, origin + path otherwise. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin === location.origin
      ? parsed.pathname
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

let activeTeardown: (() => void) | null = null;

/**
 * Installs the global handlers and automatic breadcrumbs and returns their
 * teardown. Idempotent: a second call tears the previous installation down
 * first. Existing handlers keep running: listeners are added with
 * addEventListener and every wrapped function still calls the original.
 * No-op during SSR.
 */
export function setupExceptionCapture(hooks: ExceptionCaptureHooks): () => void {
  activeTeardown?.();
  activeTeardown = null;
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  let active = true;
  const cleanups: (() => void)[] = [];
  const crumb = (input: BreadcrumbInput) =>
    safely(() => {
      if (active) hooks.addBreadcrumb(input);
    });

  const onError = (event: Event) =>
    safely(() => {
      if (!active) return;
      const errorEvent = event as ErrorEvent;
      if (errorEvent.error === undefined && typeof errorEvent.message !== "string") return;
      const list = isErrorLike(errorEvent.error)
        ? buildExceptionList(errorEvent.error, { handled: false, type: "onerror" })
        : [syntheticFromErrorEvent(errorEvent)];
      hooks.capture(list, { level: "fatal" });
    });
  const onRejection = (event: Event) =>
    safely(() => {
      if (!active) return;
      hooks.capture(rejectionList((event as { reason?: unknown }).reason), {
        level: "error",
      });
    });
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  cleanups.push(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  });

  let lastRoute = currentRoute();
  const onNavigate = () =>
    safely(() => {
      const to = currentRoute();
      if (to === lastRoute) return;
      crumb({ category: "navigation", message: `${lastRoute} -> ${to}`, level: "info" });
      lastRoute = to;
    });
  // pushState, replaceState and popstate through the shared observer (navigation.ts).
  cleanups.push(
    onNavigation(() => {
      if (active) onNavigate();
    }),
  );
  window.addEventListener("hashchange", onNavigate);
  cleanups.push(() => window.removeEventListener("hashchange", onNavigate));

  const onClick = (event: Event) =>
    safely(() => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest(CLICK_SELECTOR) ?? target;
      crumb({ category: "ui.click", message: describeElement(el), level: "info" });
    });
  document.addEventListener("click", onClick, true);
  cleanups.push(() => document.removeEventListener("click", onClick, true));

  // One shared console.error wrapper (console.ts), also used by session replay.
  cleanups.push(
    observeConsole({
      levels: ["error"],
      call: (_level, args) => {
        if (active) {
          crumb({ category: "console", level: "error", message: args.map(consoleArg).join(" ") });
        }
      },
    }),
  );

  // The SDK's own requests (network.ts SDK_ENDPOINTS, /replay included) are
  // never breadcrumbs.
  const isSdkRequest = sdkRequestMatcher(hooks.apiHost);
  const recordRequest = (
    category: "fetch" | "xhr",
    method: string,
    url: string,
    status: number | undefined,
  ) => {
    const shown = displayUrl(url);
    crumb({
      category,
      level: status === undefined || status >= 500 ? "error" : "warning",
      message: `${method} ${shown} ${status ?? "failed"}`,
      data: {
        method,
        url: shown,
        ...(status !== undefined ? { status_code: status } : {}),
      },
    });
  };
  // One shared wrapper for fetch and XHR (network.ts), also used by session
  // replay: only failures become breadcrumbs.
  cleanups.push(
    observeNetwork({
      wants: (url) => active && !isSdkRequest(url),
      done: (request) => {
        if (!active) return;
        if (request.status === undefined || request.status >= 400) {
          recordRequest(request.kind, request.method, request.url, request.status);
        }
      },
    }),
  );

  const teardown = () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups) safely(cleanup);
    if (activeTeardown === teardown) activeTeardown = null;
  };
  activeTeardown = teardown;
  return teardown;
}
