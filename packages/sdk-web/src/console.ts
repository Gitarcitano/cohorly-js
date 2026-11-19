/**
 * The one place the web SDK wraps `console.log|info|warn|error`. Exception
 * breadcrumbs (`console.error`, VEL-1789) and session replay `$console` lines
 * (VEL-2144) both subscribe here, so each console method is wrapped once,
 * whatever is enabled. A method is wrapped with the first observer of its
 * level and restored with the last one. Only raw `(level, args)` are
 * dispatched: formatting, scrubbing and limits belong to each observer (the
 * replay's live in its lazy chunk, `replay/console-record.ts`).
 *
 * The wrapper calls the page's original with the same `this` and arguments
 * and returns its result. Observers run first, each inside `safely`, so a
 * breadcrumb or a replay line is already recorded if the original itself
 * reports an exception. A console call made while observers run (the SDK's
 * own logging) is passed to the original but never dispatched again.
 */
import { patchMethod, safely } from "./network.js";

export type ConsoleLevel = "log" | "info" | "warn" | "error";

export const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["log", "info", "warn", "error"];

export interface ConsoleObserver {
  /** The methods this observer wants; read once, when it subscribes. */
  levels: readonly ConsoleLevel[];
  /** Called before the original, with the arguments as the page passed them (never mutate them). */
  call(level: ConsoleLevel, args: readonly unknown[]): void;
}

const observers: Record<ConsoleLevel, Set<ConsoleObserver>> = {
  log: new Set(),
  info: new Set(),
  warn: new Set(),
  error: new Set(),
};
const installed: Partial<Record<ConsoleLevel, () => void>> = {};
let dispatching = false;

function isLevel(value: unknown): value is ConsoleLevel {
  return (CONSOLE_LEVELS as readonly unknown[]).includes(value);
}

function dispatch(level: ConsoleLevel, args: readonly unknown[]): void {
  dispatching = true;
  try {
    for (const observer of [...observers[level]]) {
      // One that unsubscribed while an earlier one ran is skipped.
      if (observers[level].has(observer)) safely(() => observer.call(level, args));
    }
  } finally {
    dispatching = false;
  }
}

/** Null when the method cannot be replaced (a frozen or read-only console): that level is not observed. */
function install(level: ConsoleLevel): (() => void) | null {
  let active = true;
  let restore: () => void;
  try {
    restore = patchMethod(console, level, (original) =>
      function patchedConsole(this: unknown, ...args: unknown[]) {
        if (active && !dispatching) dispatch(level, args);
        return original.apply(this, args);
      },
    );
  } catch {
    return null;
  }
  return () => {
    active = false;
    restore();
  };
}

/**
 * Subscribes an observer to its levels and returns its unsubscribe. No-op
 * during SSR (the server's console is never wrapped).
 */
export function observeConsole(observer: ConsoleObserver): () => void {
  if (typeof window === "undefined" || typeof console === "undefined") return () => {};
  const levels = [...new Set(observer.levels)].filter(isLevel);
  for (const level of levels) {
    observers[level].add(observer);
    if (!installed[level]) {
      const uninstall = install(level);
      if (uninstall) installed[level] = uninstall;
    }
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    for (const level of levels) {
      observers[level].delete(observer);
      const uninstall = installed[level];
      if (observers[level].size === 0 && uninstall) {
        delete installed[level];
        safely(uninstall);
      }
    }
  };
}
