import { type CohorlyNode, init } from "@cohorly/node";
import {
  type CohorlyRequestErrorOptions,
  debugLog,
  type OnRequestError,
  type OnRequestErrorContext,
  type OnRequestErrorRequest,
  REQUEST_ERROR_MECHANISM,
  type ResolvedRequestErrorConfig,
  requestErrorTags,
  resolveRequestErrorConfig,
} from "./request-error.js";

export type {
  CohorlyExceptionEvent,
  CohorlyRequestErrorOptions,
  OnRequestError,
  OnRequestErrorContext,
  OnRequestErrorRequest,
} from "./request-error.js";

const CLIENT_KEY = Symbol.for("cohorly.nextjs.node-client");

type ClientHolder = { [CLIENT_KEY]?: CohorlyNode };

/**
 * One client per process, kept on `globalThis` so Next.js loading this module
 * more than once (dev reloads, several bundles) never creates a second one.
 * The first call's config wins.
 */
function sharedClient(config: ResolvedRequestErrorConfig): CohorlyNode {
  const holder = globalThis as ClientHolder;
  const existing = holder[CLIENT_KEY];
  if (existing) return existing;
  const client = init(config.token, {
    host: config.host,
    release: config.release,
    dist: config.dist,
    serverName: config.serverName,
    flushTimeoutMs: config.flushTimeoutMs,
    beforeSendException: config.beforeSendException,
    debug: config.debug,
    // Every capture flushes itself; an interval would only retry into a frozen instance.
    flushIntervalMs: 0,
  });
  holder[CLIENT_KEY] = client;
  return client;
}

/**
 * Builds a Next.js `onRequestError` hook (Node.js runtime) that captures the
 * error as a `$exception` event and waits for it to be sent, at most
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
      const client = sharedClient(config);
      const captured = client.captureException(error, {
        level: "error",
        mechanism: REQUEST_ERROR_MECHANISM,
        tags: requestErrorTags(error, request, context),
      });
      if (!captured) return;
      await client.flushWithTimeout(config.flushTimeoutMs);
    } catch (err) {
      debugLog(options.debug, "onRequestError failed", err);
    }
  };
}

/** `onRequestError` configured from env vars (`COHORLY_TOKEN`, `COHORLY_API_HOST`, `VERCEL_GIT_COMMIT_SHA`). */
export const onRequestError: OnRequestError = createOnRequestError();
