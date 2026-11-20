import type { BreadcrumbInput } from "@cohorly/core";

/**
 * The part of a React Navigation container ref (`createNavigationContainerRef()`,
 * `useNavigationContainerRef()` from React Navigation or expo-router) this
 * uses. A React ref object (`{ current }`) holding one works too.
 */
export interface NavigationRefLike {
  addListener?: (event: "state", callback: () => void) => unknown;
  getCurrentRoute?: () => { name?: unknown; key?: unknown } | undefined | null;
  isReady?: () => boolean;
  current?: NavigationRefLike | null;
}

function resolve(ref: NavigationRefLike | null | undefined): NavigationRefLike | undefined {
  if (!ref) return undefined;
  if (typeof ref.addListener === "function") return ref;
  return ref.current ?? undefined;
}

function currentRoute(nav: NavigationRefLike): { name: string; key?: string } | undefined {
  try {
    // getCurrentRoute() before the container is ready logs an error in React Navigation.
    if (typeof nav.isReady === "function" && !nav.isReady()) return undefined;
    const route = nav.getCurrentRoute?.();
    const name = route?.name;
    if (typeof name !== "string" || !name) return undefined;
    const key = route?.key;
    return typeof key === "string" && key ? { name, key } : { name };
  } catch {
    return undefined;
  }
}

/**
 * Records a `navigation` breadcrumb ("Home -> Cart") on every route change.
 * Route names only: params can hold ids, e-mails or tokens and are never
 * read. Returns the unsubscribe. Never throws; a missing ref is a no-op.
 *
 * `onScreen(name)` (optional) is called for each screen view: the initial
 * route (now if the container is ready, else on the first `state` event that
 * yields a route) and every later route whose `key` differs from the one that
 * last produced a screen view (the name when the route has no key), so
 * `setParams` never repeats it. It returns whether the screen was sent; the
 * dedupe marker only advances then. A throwing `onScreen` is swallowed.
 */
export function watchNavigation(
  navigationRef: NavigationRefLike | null | undefined,
  addBreadcrumb: (crumb: BreadcrumbInput) => void,
  onScreen?: (name: string) => boolean,
): () => void {
  const nav = resolve(navigationRef);
  if (!nav || typeof nav.addListener !== "function" || typeof nav.getCurrentRoute !== "function") {
    return () => {};
  }
  let lastScreenId: string | undefined;
  const emitScreen = () => {
    if (!onScreen) return;
    try {
      const route = currentRoute(nav);
      if (!route) return;
      const id = route.key ? `key:${route.key}` : `name:${route.name}`;
      if (id === lastScreenId) return;
      if (onScreen(route.name) === true) lastScreenId = id;
    } catch {
      // a screen view must never break navigation
    }
  };
  let last = currentRoute(nav)?.name;
  emitScreen();
  let unsubscribe: unknown;
  try {
    unsubscribe = nav.addListener("state", () => {
      emitScreen();
      const to = currentRoute(nav)?.name;
      if (!to || to === last) return;
      const from = last;
      last = to;
      try {
        addBreadcrumb({
          category: "navigation",
          message: `${from ?? "(none)"} -> ${to}`,
          level: "info",
          data: from ? { from, to } : { to },
        });
      } catch {
        // a breadcrumb must never break navigation
      }
    });
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (typeof unsubscribe === "function") unsubscribe();
    } catch {
      // already gone
    }
  };
}
