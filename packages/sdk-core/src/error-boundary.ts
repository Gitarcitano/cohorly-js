/**
 * The React error boundary shared by `@cohorly/react` and
 * `@cohorly/react-native`. A subpath of its own (`@cohorly/core/error-boundary`)
 * so the main entry stays free of React, and React itself is passed in rather
 * than imported: each SDK hands over its own `Component`, so a workspace or an
 * app with two React copies never mixes them.
 */
import type { ErrorInfo, Component as ReactComponent, ReactNode } from "react";
import type { BreadcrumbInput, CaptureExceptionOptions } from "./types.js";

export interface CohorlyErrorBoundaryFallbackProps {
  error: unknown;
  /** Clears the error and renders the children again. */
  reset: () => void;
}

export interface CohorlyErrorBoundaryProps {
  children?: ReactNode;
  /** Rendered instead of the children after a render error. Defaults to nothing. */
  fallback?: ReactNode | ((props: CohorlyErrorBoundaryFallbackProps) => ReactNode);
  /** Called after the error was captured. */
  onError?: (error: unknown, componentStack: string | undefined) => void;
}

export interface CohorlyErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

export interface ErrorBoundaryHooks {
  /**
   * `Component` from the app's `react`. Typed loosely on purpose: the SDK
   * building the boundary may compile against another major of `@types/react`.
   */
  Component: abstract new (...args: never[]) => object;
  /** May throw (e.g. before init()); the boundary still renders its fallback. */
  captureException(error: unknown, options: CaptureExceptionOptions): void;
  addBreadcrumb(crumb: BreadcrumbInput): void;
}

/**
 * Builds `CohorlyErrorBoundary`: catches render errors below it, captures them
 * as `$exception` events (`mechanism.type: "react.errorboundary"`, level
 * `"error"`) and renders `fallback`. The component stack travels as a
 * `react.component_stack` breadcrumb, not as an event property, so the stored
 * event stays thin.
 */
export function createErrorBoundary(hooks: ErrorBoundaryHooks) {
  const Base = hooks.Component as typeof ReactComponent;
  return class CohorlyErrorBoundary extends Base<
    CohorlyErrorBoundaryProps,
    CohorlyErrorBoundaryState
  > {
    state: CohorlyErrorBoundaryState = { hasError: false, error: null };

    static getDerivedStateFromError(error: unknown): CohorlyErrorBoundaryState {
      return { hasError: true, error };
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
      const componentStack = info?.componentStack ?? undefined;
      try {
        if (componentStack) {
          hooks.addBreadcrumb({
            category: "react.component_stack",
            message: componentStack,
            level: "error",
          });
        }
        hooks.captureException(error, {
          level: "error",
          mechanism: { type: "react.errorboundary", handled: true },
        });
      } catch {
        // Not initialized: the boundary still renders its fallback.
      }
      this.props.onError?.(error, componentStack);
    }

    reset = (): void => {
      this.setState({ hasError: false, error: null });
    };

    render(): ReactNode {
      if (!this.state.hasError) return this.props.children;
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return fallback({ error: this.state.error, reset: this.reset });
      }
      return fallback ?? null;
    }
  };
}
