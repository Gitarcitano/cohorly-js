import type { PlatformInfo } from "./types.js";

// Metro/Hermes expose a global `require` even though this package is
// authored and compiled as ESM; plain Node/browser environments won't have
// it, so every use below is guarded by try/catch. Each call must pass a
// string literal: Metro's transformer rejects dynamic `require(id)` calls
// ("Invalid call"), and the lexical try/catch around each one marks it as an
// optional dependency so bundling never fails when the module isn't
// installed in the host app. Typed as always-present so the literal calls
// typecheck; when it's genuinely absent at runtime the ReferenceError is
// swallowed by the same try/catch.
// biome-ignore lint/suspicious/noExplicitAny: bridges the untyped Metro/Hermes `require`.
declare const require: (id: string) => any;

/** Unwraps Metro's `{ default }` ESM interop. */
// biome-ignore lint/suspicious/noExplicitAny: untyped required module.
function unwrap(mod: any): any {
  return mod?.default ?? mod;
}

/** Optional native/device modules this package best-effort integrates with,
 * none of which are hard dependencies. Each is independently optional - any
 * subset (or none) may be present. */
export interface NativeModuleBag {
  // biome-ignore lint/suspicious/noExplicitAny: untyped `react-native` module.
  rn?: any;
  // biome-ignore lint/suspicious/noExplicitAny: untyped `react-native-device-info` module.
  rnDeviceInfo?: any;
  // biome-ignore lint/suspicious/noExplicitAny: untyped `@react-native-community/netinfo` module.
  netInfo?: any;
  // biome-ignore lint/suspicious/noExplicitAny: untyped `expo-application` module.
  expoApplication?: any;
  // biome-ignore lint/suspicious/noExplicitAny: untyped `expo-device` module.
  expoDevice?: any;
  // biome-ignore lint/suspicious/noExplicitAny: untyped `expo-updates` module.
  expoUpdates?: any;
}

/** Loads every optional module this package knows how to use, each guarded
 * independently so a missing/broken one never affects the others. Requires
 * are inlined string literals (not a shared helper) because Metro only
 * accepts literal `require` calls and only treats them as optional when the
 * try/catch lexically encloses the call. */
export function loadNativeModules(): NativeModuleBag {
  const bag: NativeModuleBag = {};
  try {
    bag.rn = unwrap(require("react-native"));
  } catch {
    // Optional module absent - field stays undefined.
  }
  try {
    bag.rnDeviceInfo = unwrap(require("react-native-device-info"));
  } catch {
    // Optional module absent - field stays undefined.
  }
  try {
    bag.netInfo = unwrap(require("@react-native-community/netinfo"));
  } catch {
    // Optional module absent - field stays undefined.
  }
  try {
    bag.expoApplication = unwrap(require("expo-application"));
  } catch {
    // Optional module absent - field stays undefined.
  }
  try {
    bag.expoDevice = unwrap(require("expo-device"));
  } catch {
    // Optional module absent - field stays undefined.
  }
  try {
    bag.expoUpdates = unwrap(require("expo-updates"));
  } catch {
    // Optional module absent - field stays undefined.
  }
  return bag;
}

/** Calls `fn()`, swallowing any throw (some device-info bridge methods throw
 * or warn on certain arch/permission configs) and returning `undefined`. */
function safe<T>(fn: () => T | undefined): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function nonEmpty(s: string | undefined | null): string | undefined {
  return s != null && s !== "" ? s : undefined;
}

/** Derives device/app default properties from whichever optional modules are
 * present, in tier order: `react-native-device-info` > `expo-application`/
 * `expo-device` > `react-native` core (`Platform`/`Dimensions`). Every field is
 * independently optional and simply omitted when it can't be derived - this
 * never throws. */
export function deriveDeviceInfo(mods: NativeModuleBag): {
  platformInfo: PlatformInfo;
  appVersion?: string;
  appBuild?: string;
  /** Application id / bundle identifier, the prefix of the default release. */
  bundleId?: string;
} {
  const { rn, rnDeviceInfo, expoApplication, expoDevice } = mods;
  const Platform = rn?.Platform;
  const Dimensions = rn?.Dimensions;
  const rawOs = Platform?.OS;
  const os = rawOs === "ios" ? "iOS" : rawOs === "android" ? "Android" : rawOs;
  const screen = safe(() => Dimensions?.get?.("screen"));

  const appVersion =
    nonEmpty(safe(() => rnDeviceInfo?.getVersion?.())) ??
    nonEmpty(safe(() => expoApplication?.nativeApplicationVersion));
  const appBuild =
    nonEmpty(safe(() => String(rnDeviceInfo?.getBuildNumber?.() ?? ""))) ??
    nonEmpty(safe(() => String(expoApplication?.nativeBuildVersion ?? "")));

  const model =
    (rawOs === "ios"
      ? nonEmpty(safe(() => rnDeviceInfo?.getDeviceId?.()))
      : nonEmpty(safe(() => rnDeviceInfo?.getModel?.()))) ??
    nonEmpty(safe(() => (rawOs === "ios" ? expoDevice?.modelId : expoDevice?.modelName)));

  const manufacturer =
    (rawOs === "ios" ? "Apple" : nonEmpty(safe(() => rnDeviceInfo?.getManufacturerSync?.()))) ??
    nonEmpty(safe(() => expoDevice?.manufacturer));

  const brand =
    nonEmpty(safe(() => rnDeviceInfo?.getBrand?.())) ?? nonEmpty(safe(() => expoDevice?.brand));

  const carrier = nonEmpty(safe(() => rnDeviceInfo?.getCarrierSync?.()));

  const platformInfo: PlatformInfo = {
    os,
    osVersion: Platform?.Version,
    screenHeight: screen?.height,
    screenWidth: screen?.width,
    model,
    manufacturer,
    brand,
    carrier,
  };

  const bundleId =
    nonEmpty(safe(() => expoApplication?.applicationId)) ??
    nonEmpty(safe(() => rnDeviceInfo?.getBundleId?.()));

  return { platformInfo, appVersion, appBuild, ...(bundleId !== undefined ? { bundleId } : {}) };
}

/** Field-level merge: any explicitly-injected field wins over the derived
 * value; an injected field left `undefined` falls back to the derived one
 * (host-supplied values always take precedence, never clobbered). */
export function mergePlatformInfo(derived: PlatformInfo, injected: PlatformInfo | undefined): PlatformInfo {
  if (!injected) return derived;
  return {
    os: injected.os ?? derived.os,
    osVersion: injected.osVersion ?? derived.osVersion,
    screenHeight: injected.screenHeight ?? derived.screenHeight,
    screenWidth: injected.screenWidth ?? derived.screenWidth,
    model: injected.model ?? derived.model,
    manufacturer: injected.manufacturer ?? derived.manufacturer,
    brand: injected.brand ?? derived.brand,
    carrier: injected.carrier ?? derived.carrier,
    wifi: injected.wifi ?? derived.wifi,
  };
}

/** Reads device info from this package's own bundled/autolinked native module
 * (`CohorlyReactNative`, ios/ + android/ in this package) when it's linked -
 * the same fields `sdks/ios`/`sdks/android` derive natively, exposed here with
 * zero extra host-app installs (just an autolinked rebuild). Falls back to `{}`
 * when unlinked (Expo Go, web, plain Node/vitest) or on any native error -
 * never throws, never rejects. This is the highest-precedence auto-derived
 * tier; `react-native-device-info`/`expo-*` remain the fallback for hosts that
 * haven't rebuilt with this module linked yet. */
export async function fetchNativeDeviceInfo(rn: NativeModuleBag["rn"]): Promise<{
  appVersion?: string;
  appBuild?: string;
  /** Only when the linked native module reports one (current versions do not). */
  bundleId?: string;
  platformInfo: PlatformInfo;
}> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: untyped native bridge module.
    const native: any = rn?.NativeModules?.CohorlyReactNative;
    if (typeof native?.getDeviceInfo !== "function") return { platformInfo: {} };
    // biome-ignore lint/suspicious/noExplicitAny: untyped native bridge result.
    const info: any = await native.getDeviceInfo();
    const bundleId = nonEmpty(info?.bundleId);
    return {
      appVersion: nonEmpty(info?.appVersion),
      appBuild: nonEmpty(info?.appBuild),
      ...(bundleId !== undefined ? { bundleId } : {}),
      platformInfo: {
        model: nonEmpty(info?.model),
        manufacturer: nonEmpty(info?.manufacturer),
        brand: nonEmpty(info?.brand),
        carrier: nonEmpty(info?.carrier),
      },
    };
  } catch {
    return { platformInfo: {} };
  }
}

/** Resolves an `AppState`-like object: the caller-supplied `appState` (mainly
 * for tests), or the lazily-required `react-native`'s `AppState`. Returns
 * undefined when neither is available (e.g. plain Node, react-native not
 * installed) - lifecycle features are then simply inert. */
export function resolveAppState<T>(injected: T | undefined, rn: NativeModuleBag["rn"]): T | undefined {
  if (injected) return injected;
  return rn?.AppState;
}

/** Best-effort wifi-connectivity watcher via `@react-native-community/netinfo`,
 * when installed. Fires `onChange` once with the initial state and again on
 * every change; fully guarded, never throws, no-ops silently if `netInfo` is
 * absent or misbehaves. */
export function watchWifi(netInfo: NativeModuleBag["netInfo"], onChange: (wifi: boolean) => void): void {
  if (!netInfo) return;
  try {
    netInfo.fetch?.()?.then?.((state: { type?: string }) => {
      if (state?.type !== undefined) onChange(state.type === "wifi");
    });
    netInfo.addEventListener?.((state: { type?: string }) => {
      if (state?.type !== undefined) onChange(state.type === "wifi");
    });
  } catch {
    // Broken/incompatible NetInfo implementation - no-op, fully optional.
  }
}
