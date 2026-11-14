"use client";

import {
  type CohorlyErrorBoundaryProps,
  type CohorlyErrorBoundaryState,
  createErrorBoundary,
} from "@cohorly/core/error-boundary";
import { cohorly } from "@cohorly/web";
import { Component, type ComponentClass } from "react";

export type {
  CohorlyErrorBoundaryFallbackProps,
  CohorlyErrorBoundaryProps,
} from "@cohorly/core/error-boundary";

/**
 * Catches render errors below it, captures them as `$exception` events
 * (`mechanism.type: "react.errorboundary"`, level `"error"`) and renders
 * `fallback`. The React component stack travels as a breadcrumb
 * (`react.component_stack`), not as an event property, so the stored event
 * stays thin. Needs `init()` (or a `<CohorlyProvider>`) somewhere above it;
 * without one the error is still caught, just not captured.
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
  // Through the singleton at call time: it throws before init(), which the
  // boundary swallows.
  captureException: (error, options) => cohorly.captureException(error, options),
  addBreadcrumb: (crumb) => cohorly.addBreadcrumb(crumb),
}) as unknown as CohorlyErrorBoundaryClass;
export type CohorlyErrorBoundary = InstanceType<typeof CohorlyErrorBoundary>;
