import type { Properties } from "../types.js";

export interface ReleaseParts {
  /** `release` passed to init(): used exactly as given. */
  explicit?: string;
  bundleId?: string;
  version?: string;
  build?: string;
  /** "Android" / "iOS": the prefix when there is no bundle id. */
  os?: string;
}

/**
 * `<bundleId>@<version>+<build>`, the value `cohorly sourcemaps upload
 * --release` must be given. Without a bundle id the lowercase platform is
 * the prefix (`android@3.8.1+415`); without a build there is no `+` part.
 * Without a version there is no release at all: guessing one would file the
 * crash under a release no upload can match.
 */
export function resolveRelease(parts: ReleaseParts): string | undefined {
  if (parts.explicit !== undefined) return parts.explicit;
  if (!parts.version) return undefined;
  const prefix = parts.bundleId ?? parts.os?.toLowerCase();
  const base = prefix ? `${prefix}@${parts.version}` : parts.version;
  return parts.build ? `${base}+${parts.build}` : base;
}

export interface ExpoUpdatesInfo {
  /** `expo_*` properties stamped on every exception (only the ones that exist). */
  properties: Properties;
  /** The running update id, only for a downloaded (non-embedded) update. */
  dist?: string;
}

function read<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * What `expo-updates` says about the running JS bundle. A launch of the
 * bundle embedded in the binary has no dist: the binary's release already
 * names it. A downloaded update is the dist, so one release can carry the
 * maps of several OTA updates. Never throws; no module, no properties.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped `expo-updates` module.
export function readExpoUpdates(updates: any): ExpoUpdatesInfo {
  const info: ExpoUpdatesInfo = { properties: {} };
  if (!updates || (typeof updates !== "object" && typeof updates !== "function")) {
    return info;
  }
  const updateId = read(() => updates.updateId);
  const channel = read(() => updates.channel);
  const runtimeVersion = read(() => updates.runtimeVersion);
  const isEmbeddedLaunch = read(() => updates.isEmbeddedLaunch);
  const props = info.properties;
  if (typeof updateId === "string" && updateId) props.expo_update_id = updateId;
  if (typeof channel === "string" && channel) props.expo_channel = channel;
  if (typeof runtimeVersion === "string" && runtimeVersion) {
    props.expo_runtime_version = runtimeVersion;
  }
  if (typeof isEmbeddedLaunch === "boolean") props.expo_is_embedded_launch = isEmbeddedLaunch;
  if (isEmbeddedLaunch === false && typeof updateId === "string" && updateId) {
    info.dist = updateId;
  }
  return info;
}
