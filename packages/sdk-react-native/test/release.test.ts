import { describe, expect, it } from "vitest";
import { deriveDeviceInfo, fetchNativeDeviceInfo } from "../src/deviceInfo.js";
import { readExpoUpdates, resolveRelease } from "../src/exceptions/release.js";

describe("resolveRelease", () => {
  it("builds <bundleId>@<version>+<build>", () => {
    expect(
      resolveRelease({ bundleId: "com.example.shop", version: "3.8.1", build: "415", os: "Android" }),
    ).toBe("com.example.shop@3.8.1+415");
  });

  it("falls back to the lowercase platform without a bundle id", () => {
    expect(resolveRelease({ version: "3.8.1", build: "415", os: "Android" })).toBe("android@3.8.1+415");
    expect(resolveRelease({ version: "3.8.1", build: "415", os: "iOS" })).toBe("ios@3.8.1+415");
  });

  it("has no + part without a build", () => {
    expect(resolveRelease({ bundleId: "com.example.shop", version: "3.8.1", os: "iOS" })).toBe(
      "com.example.shop@3.8.1",
    );
  });

  it("is omitted without a version, never guessed", () => {
    expect(resolveRelease({ bundleId: "com.example.shop", build: "415", os: "iOS" })).toBeUndefined();
  });

  it("uses an explicit release exactly as given", () => {
    expect(
      resolveRelease({ explicit: "shop-rt-7", bundleId: "com.example.shop", version: "3.8.1", build: "415" }),
    ).toBe("shop-rt-7");
  });
});

describe("bundle id sources", () => {
  it("prefers expo-application's applicationId over react-native-device-info", () => {
    const info = deriveDeviceInfo({
      expoApplication: { applicationId: "com.example.expo" },
      rnDeviceInfo: { getBundleId: () => "com.example.rndi" },
    });
    expect(info.bundleId).toBe("com.example.expo");
  });

  it("falls back to react-native-device-info's getBundleId()", () => {
    expect(deriveDeviceInfo({ rnDeviceInfo: { getBundleId: () => "com.example.rndi" } }).bundleId).toBe(
      "com.example.rndi",
    );
  });

  it("reads bundleId from the native module only when it reports one", async () => {
    const rn = (info: unknown) => ({
      NativeModules: { CohorlyReactNative: { getDeviceInfo: async () => info } },
    });
    await expect(fetchNativeDeviceInfo(rn({ bundleId: "com.example.native" }))).resolves.toMatchObject({
      bundleId: "com.example.native",
    });
    expect(await fetchNativeDeviceInfo(rn({ appVersion: "1.0.0" }))).not.toHaveProperty("bundleId");
  });
});

describe("readExpoUpdates", () => {
  it("uses the update id as dist for a downloaded update, with every expo_* property", () => {
    expect(
      readExpoUpdates({
        updateId: "0c5e7a1b-4d2f-4b8e-9a61-2f3e4d5c6b7a",
        channel: "production",
        runtimeVersion: "1.4.0",
        isEmbeddedLaunch: false,
      }),
    ).toEqual({
      dist: "0c5e7a1b-4d2f-4b8e-9a61-2f3e4d5c6b7a",
      properties: {
        expo_update_id: "0c5e7a1b-4d2f-4b8e-9a61-2f3e4d5c6b7a",
        expo_channel: "production",
        expo_runtime_version: "1.4.0",
        expo_is_embedded_launch: false,
      },
    });
  });

  it("has no dist for the embedded bundle", () => {
    const info = readExpoUpdates({ updateId: "emb-1", runtimeVersion: "1.4.0", isEmbeddedLaunch: true });
    expect(info.dist).toBeUndefined();
    expect(info.properties.expo_is_embedded_launch).toBe(true);
  });

  it("does not call a bundle an OTA update when expo-updates cannot say whether it is embedded", () => {
    const info = readExpoUpdates({ updateId: "unknown-1", runtimeVersion: "1.4.0" });
    expect(info.dist).toBeUndefined();
    expect(info.properties).not.toHaveProperty("expo_is_embedded_launch");
  });

  it("omits fields that are null, and everything when the module is absent or throws", () => {
    expect(readExpoUpdates({ updateId: null, channel: null, isEmbeddedLaunch: true }).properties).toEqual({
      expo_is_embedded_launch: true,
    });
    expect(readExpoUpdates(undefined)).toEqual({ properties: {} });
    const throwing = {
      get updateId(): string {
        throw new Error("native module missing");
      },
      get isEmbeddedLaunch(): boolean {
        throw new Error("native module missing");
      },
    };
    expect(readExpoUpdates(throwing)).toEqual({ properties: {} });
  });
});
