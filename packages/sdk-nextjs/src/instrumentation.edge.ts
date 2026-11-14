import { buildExceptionList, uuid } from "@cohorly/core";
import {
  type CohorlyExceptionEvent,
  type CohorlyRequestErrorOptions,
  DEFAULT_SERVER_DISTINCT_ID,
  debugLog,
  type OnRequestError,
  type OnRequestErrorContext,
  type OnRequestErrorRequest,
  REQUEST_ERROR_MECHANISM,
  type ResolvedRequestErrorConfig,
  requestErrorTags,
  resolveRequestErrorConfig,
  withoutReservedKeys,
} from "./request-error.js";
import { LIB_VERSION } from "./version.js";

export type {
  CohorlyExceptionEvent,
  CohorlyRequestErrorOptions,
  OnRequestError,
  OnRequestErrorContext,
  OnRequestErrorRequest,
} from "./request-error.js";

/** The same `$exception` event `@cohorly/node` builds, without Node APIs. */
function buildEdgeException(
  error: unknown,
  request: OnRequestErrorRequest,
  context: OnRequestErrorContext,
  config: ResolvedRequestErrorConfig,
): CohorlyExceptionEvent | null {
  const built: CohorlyExceptionEvent = {
    event: "$exception",
    properties: {
      ...withoutReservedKeys(requestErrorTags(error, request, context)),
      ...(config.serverName !== undefined ? { server_name: config.serverName } : {}),
      runtime: "edge",
      distinct_id: config.serverName ?? DEFAULT_SERVER_DISTINCT_ID,
      time: Date.now(),
      $insert_id: uuid(),
      $lib: "nextjs-edge",
      $lib_version: LIB_VERSION,
      ...(config.release !== undefined ? { $app_version_string: config.release } : {}),
      $exception_list: buildExceptionList(error, REQUEST_ERROR_MECHANISM),
      $exception_level: "error",
      ...(config.release !== undefined ? { $exception_release: config.release } : {}),
      ...(config.dist !== undefined ? { $exception_dist: config.dist } : {}),
    },
  };
  if (!config.beforeSendException) return built;
  let evt: CohorlyExceptionEvent | null;
  try {
    evt = config.beforeSendException(built);
  } catch (err) {
    debugLog(config.debug, "beforeSendException threw, dropping the exception", err);
    return null;
  }
  if (!evt || typeof evt !== "object" || !evt.properties) {
    debugLog(config.debug, "beforeSendException dropped the exception");
    return null;
  }
  return evt;
}

/** POSTs one event to `/track`, giving up (and aborting the request) after `timeoutMs`. */
async function sendWithTimeout(
  event: CohorlyExceptionEvent,
  config: ResolvedRequestErrorConfig,
): Promise<void> {
  const body = JSON.stringify([event]);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("cohorly: flush timed out"));
      debugLog(config.debug, "exception send timed out");
      resolve();
    }, config.flushTimeoutMs);
  });
  const send = fetch(`${config.host}/track`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Cohorly-Token": config.token },
    body,
    signal: controller.signal,
  }).then(
    (res) => {
      if (!res.ok) debugLog(config.debug, "exception send failed with status", res.status);
    },
    (err) => debugLog(config.debug, "exception send failed", err),
  );
  try {
    await Promise.race([send, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds a Next.js `onRequestError` hook for the Edge runtime: builds the
 * `$exception` event and POSTs it straight to `/track`, waiting at most
 * `flushTimeoutMs`. Never rejects, never touches the error.
 */
export function createOnRequestError(
  options: CohorlyRequestErrorOptions = {},
): OnRequestError {
  return async function onRequestError(
    error: unknown,
    request: OnRequestErrorRequest,
    context: OnRequestErrorContext,
  ): Promise<void> {
    try {
      const config = resolveRequestErrorConfig(options);
      if (!config) return;
      const event = buildEdgeException(error, request, context, config);
      if (!event) return;
      await sendWithTimeout(event, config);
    } catch (err) {
      debugLog(options.debug, "onRequestError failed", err);
    }
  };
}

/** `onRequestError` configured from env vars (`COHORLY_TOKEN`, `COHORLY_API_HOST`, `VERCEL_GIT_COMMIT_SHA`). */
export const onRequestError: OnRequestError = createOnRequestError();
