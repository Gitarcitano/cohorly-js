import type { BreadcrumbInput } from "@cohorly/core";

/**
 * The part of a React Navigation container ref (`createNavigationContainerRef()`,
 * `useNavigationContainerRef()` from React Navigation or expo-router) this
 * uses. A React ref object (`{ current }`) holding one works too.
 */
export interface NavigationRefLike {
  addListener?: (event: "state", callback: () => void) => unknown;
  getCurrentRoute?: () => { name?: unknown } | undefined | null;
  isReady?: () => boolean;
  current?: NavigationRefLike | null;
}

function resolve(ref: NavigationRefLike | null | undefined): NavigationRefLike | undefined {
  if (!ref) return undefined;
  if (typeof ref.addListener === "function") return ref;
  return ref.current ?? undefined;
}

function routeName(nav: NavigationRefLike): string | undefined {
  try {
    // getCurrentRoute() before the container is ready logs an error in React Navigation.
    if (typeof nav.isReady === "function" && !nav.isReady()) return undefined;
    const name = nav.getCurrentRoute?.()?.name;
    return typeof name === "string" && name ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records a `navigation` breadcrumb ("Home -> Cart") on every route change.
 * Route names only: params can hold ids, e-mails or tokens and are never
 * read. Returns the unsubscribe. Never throws; a missing ref is a no-op.
 */
export function watchNavigation(
  navigationRef: NavigationRefLike | null | undefined,
  addBreadcrumb: (crumb: BreadcrumbInput) => void,
): () => void {
  const nav = resolve(navigationRef);
  if (!nav || typeof nav.addListener !== "function" || typeof nav.getCurrentRoute !== "function") {
    return () => {};
  }
  let last = routeName(nav);
  let unsubscribe: unknown;
  try {
    unsubscribe = nav.addListener("state", () => {
      const to = routeName(nav);
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
