import { onNavigation } from "./navigation.js";

/** Mixpanel-compatible automatic web pageview event name. */
export const PAGEVIEW_EVENT = "$mp_web_page_view";

/**
 * Properties for a `$mp_web_page_view` event, derived from the current
 * location/document. Empty during SSR.
 */
export function getPageviewProperties(): Record<string, unknown> {
  if (typeof window === "undefined" || typeof location === "undefined") {
    return {};
  }
  const props: Record<string, unknown> = {
    $current_url: location.href,
    current_domain: location.hostname,
    current_url_path: location.pathname,
    current_url_search: location.search,
  };
  if (typeof document !== "undefined") {
    props.current_page_title = document.title;
  }
  return props;
}

/**
 * SPA pageview autotracking: `onNavigate` runs after every
 * `history.pushState` / `replaceState` (client-side routers) and `popstate`
 * (back/forward), through the shared navigation observer (navigation.ts).
 * Returns its unsubscribe. No-op during SSR.
 */
export function setupPageviewAutotrack(onNavigate: () => void): () => void {
  if (typeof window === "undefined" || typeof history === "undefined") return () => {};
  return onNavigation(onNavigate);
}
