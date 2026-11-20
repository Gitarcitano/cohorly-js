/**
 * The one place the web SDK wraps `history.pushState` / `replaceState` and
 * listens to `popstate`. SPA pageviews (pageview.ts), exception navigation
 * breadcrumbs (exceptions.ts) and replay URL triggers (replay/session.ts,
 * VEL-2187) all subscribe here, so `history` is wrapped once, whatever is
 * enabled. The methods are wrapped with the first observer and restored with
 * the last one (`patchMethod`: only while nothing wrapped them afterwards).
 *
 * The wrapper calls the page's original with the same `this` and arguments,
 * then notifies the observers in the order they subscribed, each inside
 * `safely`, and returns the original's result. `hashchange` is not here: only
 * the breadcrumbs listen to it.
 */
import { patchMethod, safely } from "./network.js";

const observers = new Set<() => void>();
let uninstall: (() => void) | null = null;

function dispatch(): void {
  for (const observer of [...observers]) {
    // One that unsubscribed while an earlier one ran is skipped.
    if (observers.has(observer)) safely(observer);
  }
}

function install(): () => void {
  let active = true;
  const notify = () => {
    if (active) dispatch();
  };
  const restores: (() => void)[] = [];
  if (typeof history !== "undefined") {
    for (const method of ["pushState", "replaceState"]) {
      try {
        restores.push(
          patchMethod(history, method, (original) =>
            function patchedHistory(this: unknown, ...args: unknown[]) {
              const result = original.apply(this, args);
              notify();
              return result;
            },
          ),
        );
      } catch {
        // a read-only history: that method is not observed
      }
    }
  }
  window.addEventListener("popstate", notify);
  return () => {
    active = false;
    window.removeEventListener("popstate", notify);
    for (const restore of restores) safely(restore);
  };
}

/**
 * Calls `cb` after every `pushState`, `replaceState` and `popstate`, and
 * returns its unsubscribe. No-op during SSR.
 */
export function onNavigation(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  observers.add(cb);
  if (!uninstall) uninstall = install();
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    observers.delete(cb);
    if (observers.size === 0 && uninstall) {
      const done = uninstall;
      uninstall = null;
      safely(done);
    }
  };
}
