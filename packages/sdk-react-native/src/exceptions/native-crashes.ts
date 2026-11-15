/**
 * The config the native crash reporter reads at the NEXT launch (ADR-0020),
 * written by JS on every launch and on every identify/reset/opt-out. iOS keeps
 * it in UserDefaults `cohorly.crash.config`; Android (VEL-1770) reads the same
 * JSON. The shape is a cross-platform contract: do not add fields lightly.
 */
export interface NativeCrashConfig {
  /** KSCrash (in-process signal handlers), iOS; the native reporter on Android. */
  enabled: boolean;
  /**
   * MetricKit diagnostics (iOS only, Android ignores it), independent of
   * `enabled`: `enabled: false, metricKit: true` sends MetricKit without
   * installing any handler. Always written; native code reads a config
   * without it (written by 1.4.0) as `metricKit == enabled`.
   */
  metricKit: boolean;
  /** `<bundleId>@<version>+<build>`, from the same resolveRelease() as JS errors. */
  release: string | null;
  /** OTA update id; native code only uses it while the binary's release still equals `release`. */
  dist: string | null;
  distinctId: string;
  deviceId: string;
  /**
   * Build number of the launch that wrote the config (iOS CFBundleVersion,
   * Android versionCode). Native code drops `dist` when the running build
   * differs; Android stamps its own versionCode over it on write.
   */
  build: string | null;
}

export interface NativeCrashInputs {
  nativeCrashReporting?: boolean;
  /** Omitted: follows `nativeCrashReporting`. */
  metricKitDiagnostics?: boolean;
  /** CohorlyClient.isExceptionCaptureEnabled(): hydrated, not opted out, `captureExceptions` not `false`. */
  captureEnabled: boolean;
  release: string | undefined;
  dist: string | undefined;
  distinctId: string;
  deviceId: string;
  build: string | undefined;
}

/**
 * Each part is on only when asked for and while exception capture is enabled
 * (no opt-out, no `captureExceptions: false`). MetricKit defaults to the
 * `nativeCrashReporting` choice.
 */
export function buildNativeCrashConfig(input: NativeCrashInputs): NativeCrashConfig {
  const metricKit = input.metricKitDiagnostics ?? input.nativeCrashReporting === true;
  return {
    enabled: input.nativeCrashReporting === true && input.captureEnabled,
    metricKit: metricKit === true && input.captureEnabled,
    release: input.release ?? null,
    dist: input.dist ?? null,
    distinctId: input.distinctId,
    deviceId: input.deviceId,
    build: input.build ?? null,
  };
}

/**
 * Hands the config to the native module's `configureNativeCrashes(json)`.
 * Without the method (Android before VEL-1770, web, Expo Go, an app not
 * rebuilt with the module) it does nothing. Never throws.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped native bridge module.
export function writeNativeCrashConfig(nativeModule: any, config: NativeCrashConfig): void {
  try {
    if (typeof nativeModule?.configureNativeCrashes !== "function") return;
    const result = nativeModule.configureNativeCrashes(JSON.stringify(config));
    // A promise-returning bridge must not surface an unhandled rejection.
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Native crash reporting is best effort; analytics never breaks on it.
  }
}
