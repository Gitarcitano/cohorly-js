"use client";

import type { FlagDetails } from "@cohorly/web";
import { useEffect, useState } from "react";
import { useCohorly } from "./CohorlyProvider.js";

/**
 * The current value of a feature flag: its variant key when it has one, else
 * its enabled boolean. `undefined` until flags have loaded, so callers can
 * render a stable placeholder instead of flickering from false to true.
 */
export function useFeatureFlag(key: string): boolean | string | undefined {
  const cohorly = useCohorly();
  const [value, setValue] = useState<boolean | string | undefined>(undefined);

  useEffect(() => {
    // A key change while flags are unloaded must not keep the previous
    // key's value; the immediate fire below repopulates it when loaded.
    setValue(undefined);
    // onFeatureFlags fires immediately when flags are already loaded, and
    // again after every successful reload (identify/reset/manual). An
    // identity clear also emits - keep `undefined` for that unloaded gap
    // rather than publishing getter fallbacks.
    const unsubscribe = cohorly.onFeatureFlags(() => {
      setValue(
        cohorly.areFeatureFlagsLoaded()
          ? cohorly.getFeatureFlag(key)
          : undefined,
      );
    });
    return unsubscribe;
  }, [cohorly, key]);

  return value;
}

/**
 * The full result of a feature flag: value, enabled, payload, and `source`
 * ("network" | "persistence" | "fallback", with `ttlMs` - and `persistedAt`
 * when the cache carries a write timestamp - when served from the persisted
 * cache). `undefined` until flags have loaded.
 * Reading a known flag counts as an exposure, like the other hooks; a
 * fallback result never does.
 */
export function useFeatureFlagDetails(
  key: string,
  fallback?: boolean | string,
): FlagDetails | undefined {
  const cohorly = useCohorly();
  const [details, setDetails] = useState<FlagDetails | undefined>(undefined);

  useEffect(() => {
    // A key change while flags are unloaded must not keep the previous
    // key's details; the immediate fire below repopulates it when loaded.
    setDetails(undefined);
    const unsubscribe = cohorly.onFeatureFlags(() => {
      setDetails(
        cohorly.areFeatureFlagsLoaded()
          ? cohorly.getFeatureFlagDetails(key, fallback)
          : undefined,
      );
    });
    return unsubscribe;
  }, [cohorly, key, fallback]);

  return details;
}

/**
 * The payload of a feature flag's matched variant. `undefined` until flags
 * have loaded; `null` when the flag has no payload (or is unknown).
 */
export function useFeatureFlagPayload(key: string): unknown {
  const cohorly = useCohorly();
  const [payload, setPayload] = useState<unknown>(undefined);

  useEffect(() => {
    // A key change while flags are unloaded must not keep the previous
    // key's payload; the immediate fire below repopulates it when loaded.
    setPayload(undefined);
    const unsubscribe = cohorly.onFeatureFlags(() => {
      setPayload(
        cohorly.areFeatureFlagsLoaded()
          ? cohorly.getFeatureFlagPayload(key)
          : undefined,
      );
    });
    return unsubscribe;
  }, [cohorly, key]);

  return payload;
}
