import { CohorlyNode } from "./client.js";
import type { CohorlyConfig } from "./types.js";

export { CohorlyNode, SERVER_MAX_BATCH } from "./client.js";
export { FlagDefinitionsPoller } from "./definitions.js";
export {
  evaluateFlagLocally,
  flagBucket,
  flagVariantHash,
} from "./local-eval.js";
export {
  fetchDefinitionsFetcher,
  fetchJsonFetcher,
  fetchTransport,
  parseRetryAfterMs,
  TransportError,
} from "./transport.js";
export type {
  Breadcrumb,
  BreadcrumbInput,
  ExceptionLevel,
  ExceptionListEntry,
  ExceptionMechanism,
  ExceptionStackFrame,
  ExceptionStacktrace,
} from "@cohorly/core";
export type {
  BatchEventInput,
  Callback,
  CaptureExceptionOptions,
  CohorlyConfig,
  CohorlyFetcher,
  CohorlyFlags,
  CohorlyGetFetcher,
  CohorlyPeople,
  CohorlyTransport,
  EngagePayload,
  FlagCallOptions,
  FlagDefinition,
  FlagResult,
  FlagRule,
  FlagsCallback,
  FlagVariant,
  FlushExceptionsOptions,
  Properties,
  TrackEvent,
  WithCohorlyOptions,
} from "./types.js";
export { LIB_VERSION } from "./version.js";

/**
 * Create a Cohorly client, mirroring mixpanel-node's `Mixpanel.init`:
 *
 * ```ts
 * import Cohorly from "@cohorly/node";
 * const cohorly = Cohorly.init("<project token>", { host: "https://cohorly-service.velloalabs.com" });
 * cohorly.track("signup", { distinct_id: "user-1" });
 * ```
 */
export function init(token: string, config: CohorlyConfig = {}): CohorlyNode {
  return new CohorlyNode(token, config);
}

const Cohorly = { init };
export default Cohorly;
