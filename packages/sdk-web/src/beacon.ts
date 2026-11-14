import type { CohorlyTransport } from "@cohorly/core";
import { fetchTransport } from "@cohorly/core";

/**
 * Best-effort transport used when the page is being unloaded/hidden. Prefers
 * navigator.sendBeacon (survives navigation/tab close) and falls back to the
 * regular fetch transport when sendBeacon is unavailable (SSR, old browsers).
 */
export const beaconTransport: CohorlyTransport = (url, body) => {
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    // text/plain, not application/json: sendBeacon sends credentials, so a
    // JSON body to a cross-origin apiHost needs a preflight answered with
    // Access-Control-Allow-Credentials, and a page that is closing never gets
    // to retry. text/plain is CORS-safelisted (no preflight) and the server
    // parses the body as JSON whatever the content type.
    const blob = new Blob([JSON.stringify(body)], { type: "text/plain;charset=UTF-8" });
    const accepted = navigator.sendBeacon(url, blob);
    return accepted
      ? Promise.resolve()
      : Promise.reject(new Error("cohorly: sendBeacon was rejected by the browser"));
  }
  return fetchTransport(url, body);
};
