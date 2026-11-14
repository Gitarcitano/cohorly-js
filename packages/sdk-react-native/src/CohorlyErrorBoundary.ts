import {
  type CohorlyErrorBoundaryProps,
  type CohorlyErrorBoundaryState,
  createErrorBoundary,
} from "@cohorly/core/error-boundary";
import { Component, type ComponentClass } from "react";
import { addBreadcrumb, captureException } from "./index.js";

export type {
  CohorlyErrorBoundaryFallbackProps,
  CohorlyErrorBoundaryProps,
} from "@cohorly/core/error-boundary";

/**
 * Catches render errors below it, captures them through the shared client
 * as `$exception` events (`mechanism.type: "react.errorboundary"`, level
 * `"error"`) and renders `fallback`. The component stack travels as a
 * `react.component_stack` breadcrumb, not as an event property. Without
 * init() the error is still caught, just not captured. Same implementation
 * as `@cohorly/react`'s boundary, without pulling the web SDK into the bundle.
 */
/**
 * The class core builds is typed against core's own `@types/react`; this SDK
 * re-types it with the app's, so JSX accepts it on React 18 and 19 alike.
 */
type CohorlyErrorBoundaryClass = ComponentClass<CohorlyErrorBoundaryProps, CohorlyErrorBoundaryState> &
  (new (
    props: CohorlyErrorBoundaryProps,
  ) => Component<CohorlyErrorBoundaryProps, CohorlyErrorBoundaryState> & { reset(): void });

export const CohorlyErrorBoundary = createErrorBoundary({
  Component,
  // index.js imports this module: resolve its functions at call time.
  captureException: (error, options) => captureException(error, options),
  addBreadcrumb: (crumb) => addBreadcrumb(crumb),
}) as unknown as CohorlyErrorBoundaryClass;
export type CohorlyErrorBoundary = InstanceType<typeof CohorlyErrorBoundary>;
