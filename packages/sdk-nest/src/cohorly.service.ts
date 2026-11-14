import type {
  BatchEventInput,
  BreadcrumbInput,
  Callback,
  CaptureExceptionOptions,
  CohorlyFlags,
  CohorlyPeople,
  FlagCallOptions,
  FlagResult,
  Properties,
  TrackEvent,
  WithCohorlyOptions,
} from "@cohorly/node";
import { CohorlyNode } from "@cohorly/node";
import type { OnApplicationShutdown } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import { COHORLY_MODULE_OPTIONS } from "./cohorly.constants.js";
import type { CohorlyModuleOptions } from "./interfaces.js";

/**
 * Injectable wrapper around a {@link CohorlyNode} client. Delegates the
 * mixpanel-node-style API (track / people / alias / flush) and performs a
 * final flush on application shutdown (stops the auto-flush timer and the
 * flag-definitions poller too).
 */
@Injectable()
export class CohorlyService implements OnApplicationShutdown {
  /** The underlying @cohorly/node client, for full API access. */
  readonly client: CohorlyNode;

  constructor(
    @Inject(COHORLY_MODULE_OPTIONS)
    options: CohorlyModuleOptions,
  ) {
    const {
      token,
      isGlobal: _isGlobal,
      captureExceptions: _captureExceptions,
      distinctId: _distinctId,
      ...config
    } = options;
    this.client = new CohorlyNode(token, config);
  }

  /** Profile operations (people.set / set_once / increment / unset / delete_user). */
  get people(): CohorlyPeople {
    return this.client.people;
  }

  /** Feature-flag evaluation (isFeatureEnabled / getFeatureFlag / ...). */
  get flags(): CohorlyFlags {
    return this.client.flags;
  }

  /** Whether the flag is enabled for this distinct id. False for unknown flags. */
  isFeatureEnabled(
    key: string,
    distinctId: string,
    options?: FlagCallOptions,
  ): Promise<boolean> {
    return this.client.flags.isFeatureEnabled(key, distinctId, options);
  }

  /** The flag's variant key when it has one, else its enabled boolean. */
  getFeatureFlag(
    key: string,
    distinctId: string,
    options?: FlagCallOptions,
  ): Promise<boolean | string> {
    return this.client.flags.getFeatureFlag(key, distinctId, options);
  }

  /** The matched variant's payload, or null when the flag has none / is unknown. */
  getFeatureFlagPayload(
    key: string,
    distinctId: string,
    options?: FlagCallOptions,
  ): Promise<unknown> {
    return this.client.flags.getFeatureFlagPayload(key, distinctId, options);
  }

  /** All flag results for this distinct id, keyed by flag key. */
  getAllFlags(distinctId: string): Promise<Record<string, FlagResult>> {
    return this.client.flags.getAllFlags(distinctId);
  }

  track(
    event: string,
    properties: Properties & { distinct_id: string },
    callback?: Callback,
  ): Promise<void> {
    return this.client.track(event, properties, callback);
  }

  trackBatch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.client.trackBatch(events, callback);
  }

  /** Track a historical event with an explicit timestamp. */
  import(
    event: string,
    time: Date | number,
    properties: Properties & { distinct_id: string },
    callback?: Callback,
  ): Promise<void> {
    return this.client.import(event, time, properties, callback);
  }

  importBatch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.client.importBatch(events, callback);
  }

  alias(distinctId: string, alias: string, callback?: Callback): Promise<void> {
    return this.client.alias(distinctId, alias, callback);
  }

  flush(callback?: Callback): Promise<void> {
    return this.client.flush(callback);
  }

  /** Queue a `$exception` event; never throws. See @cohorly/node captureException(). */
  captureException(
    error: unknown,
    options?: CaptureExceptionOptions,
  ): TrackEvent | null {
    return this.client.captureException(error, options);
  }

  /** Record a breadcrumb sent with the next exceptions. */
  addBreadcrumb(crumb: BreadcrumbInput): void {
    this.client.addBreadcrumb(crumb);
  }

  /** Wrap a handler: capture, flush with a timeout and rethrow on failure. */
  withCohorly<A extends unknown[], R>(
    handler: (...args: A) => R,
    options?: WithCohorlyOptions<A>,
  ): (...args: A) => Promise<Awaited<R>> {
    return this.client.withCohorly(handler, options);
  }

  /** Force-flush exceptions and events; false on timeout or failure, never rejects. */
  flushWithTimeout(timeoutMs?: number): Promise<boolean> {
    return this.client.flushWithTimeout(timeoutMs);
  }

  /**
   * Final flush when the Nest application shuts down. `shutdown()` also stops
   * the auto-flush timer and the flag-definitions poller, so nothing keeps
   * polling after the app is down.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.client.shutdown();
  }
}
