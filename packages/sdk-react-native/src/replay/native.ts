/**
 * The native recorder, `NativeModules.CohorlyReactNativeReplay` (iOS now,
 * Android with VEL-2142, same shape). Pull model: native code never calls JS;
 * JS starts it, asks for checkouts and drains what it captured. Every call
 * goes through a promise, so a method that throws synchronously rejects like
 * one that rejects: the caller has one place to catch it.
 */

declare const __DEV__: boolean | undefined;

export interface NativeReplay {
  /** True when recording started; false when this device cannot record. */
  start(configJson: string): Promise<boolean>;
  /** Stops and discards what is pending natively. Idempotent. */
  stop(): Promise<void>;
  /** The next capture is a Meta + FullSnapshot. */
  checkout(): Promise<void>;
  /** Pending batches in capture order, each a JSON array of rrweb mobile events. */
  drain(): Promise<string[]>;
}

const METHODS = ["replayStart", "replayStop", "replayCheckout", "replayDrain"] as const;

/**
 * The module from `react-native`'s `NativeModules`, or null when it is
 * absent (Expo Go, a build without this version's native code, no
 * react-native) or lacks one of the four methods. Never throws.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped `react-native` module.
export function resolveNativeReplay(rn: any): NativeReplay | null {
  // biome-ignore lint/suspicious/noExplicitAny: untyped native bridge module.
  let mod: any;
  try {
    mod = rn?.NativeModules?.CohorlyReactNativeReplay;
  } catch {
    return null;
  }
  if (!mod || METHODS.some((name) => typeof mod[name] !== "function")) return null;
  const call = <T>(fn: () => T): Promise<T> => Promise.resolve().then(fn);
  return {
    start: (configJson) => call(() => mod.replayStart(configJson)).then((ok) => ok === true),
    stop: () => call(() => mod.replayStop()).then(() => undefined),
    checkout: () => call(() => mod.replayCheckout()).then(() => undefined),
    drain: () =>
      call(() => mod.replayDrain()).then((batches: unknown) =>
        Array.isArray(batches) ? batches.filter((b): b is string => typeof b === "string") : [],
      ),
  };
}

function isDev(): boolean {
  return typeof __DEV__ !== "undefined" && Boolean(__DEV__);
}

/** One warning in development builds; silent in release builds. */
export function warnReplayUnavailable(): void {
  if (!isDev()) return;
  try {
    console.warn(
      "Cohorly: session replay is off because the native module CohorlyReactNativeReplay is missing. " +
        "Rebuild the app with @cohorly/react-native linked (Expo Go cannot record).",
    );
  } catch {
    // no console: nothing to do
  }
}
