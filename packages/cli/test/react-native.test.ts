import { utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { lookup, parseIndex } from "../src/index-format.js";
import { fakeSymcache, fixtureMap, makeIo, type Responder, startServer, tempDir, writeFiles } from "./helpers.js";

const TOKEN = "chrly_upload_rn_token_value";
const MAP_DEBUG_ID = "7a1f0c2e-3b4d-5e6f-8a9b-0c1d2e3f4a5b";
const SLICE = { debugId: "0b1c2d3e-4f50-3617-8293-a4b5c6d7e8f9", arch: "arm64", bytes: new Uint8Array([0x43, 0x48, 0x4c, 0x59]) };
const PLIST = { CFBundleIdentifier: "com.example.shop", CFBundleShortVersionString: "3.8.0", CFBundleVersion: "412" };
const R8_MAPPING = "# compiler: R8\n# pg_map_id: 9d2a7f1\ncom.example.shop.MainActivity -> com.example.shop.MainActivity:\n";

let servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function server(responder?: Responder) {
  const s = await startServer(responder);
  servers.push(s);
  return s;
}

const mapJson = () => JSON.stringify({ ...fixtureMap(), debugId: MAP_DEBUG_ID });

async function xcodeBuild(apiUrl: string, options: { withMap?: boolean; withDsym?: boolean } = {}) {
  const root = await tempDir();
  const products = path.join(root, "Build/Products/Release-iphoneos");
  const derived = path.join(root, "Build/Intermediates.noindex/Shop.build/Release-iphoneos/Shop.build/DerivedSources");
  const files: Record<string, string> = { "Build/Products/Release-iphoneos/Shop.app/main.jsbundle": "hbc" };
  if (options.withMap !== false) files[path.relative(root, path.join(derived, "main.jsbundle.map"))] = mapJson();
  if (options.withDsym !== false) files["Build/Products/Release-iphoneos/Shop.app.dSYM/Contents/Resources/DWARF/Shop"] = "dwarf";
  await writeFiles(root, files);
  const env: Record<string, string | undefined> = {
    COHORLY_UPLOAD_TOKEN: TOKEN,
    COHORLY_API_URL: apiUrl,
    CONFIGURATION: "Release",
    TARGET_BUILD_DIR: products,
    INFOPLIST_PATH: "Shop.app/Info.plist",
    CONFIGURATION_BUILD_DIR: products,
    UNLOCALIZED_RESOURCES_FOLDER_PATH: "Shop.app",
    DERIVED_FILE_DIR: derived,
    DWARF_DSYM_FOLDER_PATH: products,
  };
  const plistReads: string[] = [];
  const plistValue = async (file: string, key: string) => {
    plistReads.push(`${file}#${key}`);
    return PLIST[key as keyof typeof PLIST];
  };
  return { root, products, derived, env, plistReads, plistValue };
}

describe("react-native xcode", () => {
  it("uploads the bundle's index and every dSYM under the Info.plist release", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url);
    const fake = fakeSymcache({ Shop: [SLICE] });
    const { io } = makeIo(build.env, { platform: "darwin", symcache: fake.builder, plistValue: build.plistValue });

    expect(await main(["react-native", "xcode"], io)).toBe(0);
    expect(build.plistReads).toEqual(
      ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"].map((k) => `${path.join(build.products, "Shop.app/Info.plist")}#${k}`),
    );
    expect(s.requests.map((r) => [r.pathname, r.query])).toEqual([
      ["/api/symbols/sourcemap-index", { release: "com.example.shop@3.8.0+412", file: "~/main.jsbundle", debug_id: MAP_DEBUG_ID }],
      ["/api/symbols/symcache", { release: "com.example.shop@3.8.0+412", debug_id: SLICE.debugId, arch: "arm64" }],
    ]);
    expect(lookup(parseIndex(new Uint8Array(s.requests[0]!.body)), 1, 10)).toEqual({ source: "src/b.ts", line: 4, column: 4, name: null });
    expect(fake.built).toEqual([path.join(build.products, "Shop.app.dSYM/Contents/Resources/DWARF/Shop")]);
  });

  it("prefers COHORLY_RELEASE and SOURCEMAP_FILE from the environment", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url, { withMap: false });
    await writeFiles(build.root, { "custom/app.map": mapJson() });
    const env = { ...build.env, COHORLY_RELEASE: "shop-ios@9.9.9+1", SOURCEMAP_FILE: path.join(build.root, "custom/app.map") };
    const { io } = makeIo(env, { platform: "darwin", symcache: fakeSymcache({ Shop: [SLICE] }).builder, plistValue: build.plistValue });

    expect(await main(["react-native", "xcode"], io)).toBe(0);
    expect(build.plistReads).toEqual([]);
    expect(s.requests.map((r) => r.query.release)).toEqual(["shop-ios@9.9.9+1", "shop-ios@9.9.9+1"]);
  });

  it("skips Debug configurations without a token or a request", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url);
    const { io, out } = makeIo({ ...build.env, CONFIGURATION: "Debug", COHORLY_UPLOAD_TOKEN: undefined }, { platform: "darwin" });
    expect(await main(["react-native", "xcode"], io)).toBe(0);
    expect(out.stdout).toContain("skipped");
    expect(s.requests).toHaveLength(0);
  });

  it("fails the build when the source map is missing, naming SOURCEMAP_FILE", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url, { withMap: false });
    const { io, out } = makeIo(build.env, { platform: "darwin", symcache: fakeSymcache({ Shop: [SLICE] }).builder, plistValue: build.plistValue });
    expect(await main(["react-native", "xcode"], io)).toBe(1);
    expect(out.stderr).toContain("SOURCEMAP_FILE");
    expect(s.requests).toHaveLength(0);
  });

  it("fails the build when there is no dSYM, naming DEBUG_INFORMATION_FORMAT", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url, { withDsym: false });
    const { io, out } = makeIo(build.env, { platform: "darwin", symcache: fakeSymcache({}).builder, plistValue: build.plistValue });
    expect(await main(["react-native", "xcode"], io)).toBe(1);
    expect(out.stderr).toContain("dwarf-with-dsym");
    expect(s.requests).toHaveLength(0);
  });

  it("waits for the app's dSYM that dsymutil is still writing, then uploads it", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url, { withDsym: false });
    const env = { ...build.env, DWARF_DSYM_FILE_NAME: "Shop.app.dSYM" };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 2) await writeFiles(build.products, { "Shop.app.dSYM/Contents/Resources/DWARF/Shop": "dw" });
      if (sleeps.length === 3) await writeFiles(build.products, { "Shop.app.dSYM/Contents/Resources/DWARF/Shop": "dwarf" });
    };
    const fake = fakeSymcache({ Shop: [SLICE] });
    const { io } = makeIo(env, { platform: "darwin", symcache: fake.builder, plistValue: build.plistValue, sleep });

    expect(await main(["react-native", "xcode"], io)).toBe(0);
    // appears after 2 checks, grows on the 3rd, unchanged on the 4th
    expect(sleeps).toEqual([1000, 1000, 1000, 1000]);
    expect(s.requests.map((r) => r.pathname)).toEqual(["/api/symbols/sourcemap-index", "/api/symbols/symcache"]);
  });

  it("does not upload the previous build's dSYM: waits until it is rewritten after the binary", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url);
    await writeFiles(build.products, { "Shop.app/Shop": "binary" });
    const dwarf = path.join(build.products, "Shop.app.dSYM/Contents/Resources/DWARF/Shop");
    const linkedAt = new Date("2026-11-11T12:00:00Z");
    await utimes(path.join(build.products, "Shop.app/Shop"), linkedAt, linkedAt);
    const stale = new Date("2026-11-10T12:00:00Z");
    await utimes(dwarf, stale, stale);
    const env = { ...build.env, DWARF_DSYM_FILE_NAME: "Shop.app.dSYM", EXECUTABLE_PATH: "Shop.app/Shop" };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 2) await writeFile(dwarf, "fresh dwarf");
    };
    const { io } = makeIo(env, { platform: "darwin", symcache: fakeSymcache({ Shop: [SLICE] }).builder, plistValue: build.plistValue, sleep });

    expect(await main(["react-native", "xcode"], io)).toBe(0);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(s.requests.map((r) => r.pathname)).toEqual(["/api/symbols/sourcemap-index", "/api/symbols/symcache"]);
  });

  it("fails the build when the app's dSYM never appears within COHORLY_DSYM_WAIT_SECONDS", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url, { withDsym: false });
    const env = { ...build.env, DWARF_DSYM_FILE_NAME: "Shop.app.dSYM", COHORLY_DSYM_WAIT_SECONDS: "3" };
    const { io, out, sleeps } = makeIo(env, { platform: "darwin", symcache: fakeSymcache({}).builder, plistValue: build.plistValue });

    expect(await main(["react-native", "xcode"], io)).toBe(1);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(out.stderr).toContain("Shop.app.dSYM was not completely written");
    expect(s.requests).toHaveLength(0);
  });

  it("fails the build when an upload is refused", async () => {
    const s = await server((req) => (req.pathname.endsWith("/symcache") ? { status: 403, body: { error: "forbidden" } } : { status: 201 }));
    const build = await xcodeBuild(s.url);
    const { io, out } = makeIo(build.env, { platform: "darwin", symcache: fakeSymcache({ Shop: [SLICE] }).builder, plistValue: build.plistValue });
    expect(await main(["react-native", "xcode"], io)).toBe(1);
    expect(out.stderr).toContain("HTTP 403: forbidden");
  });

  it("fails when the Info.plist release is incomplete", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url);
    const plistValue = async (_file: string, key: string) => (key === "CFBundleVersion" ? undefined : PLIST[key as keyof typeof PLIST]);
    const { io, out } = makeIo(build.env, { platform: "darwin", symcache: fakeSymcache({ Shop: [SLICE] }).builder, plistValue });
    expect(await main(["react-native", "xcode"], io)).toBe(1);
    expect(out.stderr).toContain("CFBundleVersion");
    expect(s.requests).toHaveLength(0);
  });
});

describe("react-native gradle", () => {
  async function gradleBuild() {
    const root = await tempDir();
    await writeFiles(root, {
      "app/build/generated/sourcemaps/react/release/index.android.bundle.map": mapJson(),
      "app/build/outputs/mapping/release/mapping.txt": R8_MAPPING,
    });
    return {
      map: path.join(root, "app/build/generated/sourcemaps/react/release/index.android.bundle.map"),
      mapping: path.join(root, "app/build/outputs/mapping/release/mapping.txt"),
    };
  }

  it("uploads the bundle's index and the R8 mapping", async () => {
    const s = await server();
    const { map, mapping } = await gradleBuild();
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    const argv = ["react-native", "gradle", "--release", "com.example.shop@3.8.1+415", "--sourcemap", map, "--mapping", mapping];

    expect(await main(argv, io)).toBe(0);
    expect(s.requests.map((r) => [r.pathname, r.query])).toEqual([
      ["/api/symbols/sourcemap-index", { release: "com.example.shop@3.8.1+415", file: "~/index.android.bundle", debug_id: MAP_DEBUG_ID }],
      ["/api/symbols/r8-mapping", { release: "com.example.shop@3.8.1+415", map_id: "9d2a7f1" }],
    ]);
    expect(s.requests[1]!.body.toString()).toBe(R8_MAPPING);
  });

  it("fails when the source map is missing", async () => {
    const s = await server();
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    const argv = ["react-native", "gradle", "--release", "r1", "--sourcemap", path.join(await tempDir(), "missing.map")];
    expect(await main(argv, io)).toBe(1);
    expect(out.stderr).toContain("no source map");
    expect(s.requests).toHaveLength(0);
  });

  it("fails when an upload is refused", async () => {
    const s = await server(() => ({ status: 400, body: { error: "release required" } }));
    const { map } = await gradleBuild();
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    expect(await main(["react-native", "gradle", "--release", "r1", "--sourcemap", map], io)).toBe(1);
  });
});

describe("COHORLY_UPLOAD_DISABLED", () => {
  it("is the only opt-out: it skips both build steps with a warning, a missing token fails them", async () => {
    const s = await server();
    const build = await xcodeBuild(s.url);
    const map = path.join(build.derived, "main.jsbundle.map");
    const runs = [
      ["react-native", "xcode"],
      ["react-native", "gradle", "--release", "r1", "--sourcemap", map],
    ];
    for (const argv of runs) {
      const disabled = makeIo({ ...build.env, COHORLY_UPLOAD_DISABLED: "1" }, { platform: "darwin", plistValue: build.plistValue });
      expect(await main(argv, disabled.io)).toBe(0);
      expect(disabled.out.stderr).toContain("COHORLY_UPLOAD_DISABLED");

      const noToken = makeIo({ ...build.env, COHORLY_UPLOAD_TOKEN: undefined }, { platform: "darwin", plistValue: build.plistValue });
      expect(await main(argv, noToken.io)).toBe(1);
      expect(noToken.out.stderr).toContain("missing upload token");
    }
    expect(s.requests).toHaveLength(0);
  });
});

describe("expo upload-update", () => {
  const IOS_UPDATE = "0f3b8c2a-6d1e-4f7a-9b2c-3d4e5f6a7b8c";
  const ANDROID_UPDATE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const updateJson = (platforms = ["ios", "android"]) =>
    JSON.stringify(
      platforms.map((platform) => ({
        id: platform === "ios" ? IOS_UPDATE : ANDROID_UPDATE,
        createdAt: "2026-11-10T12:00:00.000Z",
        group: "6a1c9e0d-2b3f-4c5d-8e9f-a0b1c2d3e4f5",
        branch: "production",
        message: "Fix checkout total",
        runtimeVersion: "3.8.0",
        platform,
        manifestPermalink: `https://u.expo.dev/update/${platform === "ios" ? IOS_UPDATE : ANDROID_UPDATE}`,
        isRollBackToEmbedded: false,
        gitCommitHash: "b71e04c9d2",
      })),
    );

  async function exported(platforms = ["ios", "android"]) {
    const root = await tempDir();
    const files: Record<string, string> = { "update.json": updateJson() };
    for (const platform of platforms) {
      files[`dist/_expo/static/js/${platform}/entry-9f2c4e71.hbc`] = "hbc";
      files[`dist/_expo/static/js/${platform}/entry-9f2c4e71.hbc.map`] = mapJson();
    }
    files[`dist/_expo/static/js/web/entry-1.js`] = "ignored";
    await writeFiles(root, files);
    return { root, json: path.join(root, "update.json"), dist: path.join(root, "dist") };
  }

  const EXPO_CONFIG = {
    name: "Shop",
    version: "3.8.0",
    ios: { bundleIdentifier: "com.example.shop", buildNumber: "412" },
    android: { package: "com.example.shop", versionCode: 415 },
  };

  it("uploads one index per platform with the update id as dist and the release from the Expo config", async () => {
    const s = await server();
    const { json, dist } = await exported();
    let configReads = 0;
    const expoConfig = async () => {
      configReads++;
      return EXPO_CONFIG;
    };
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { expoConfig });

    expect(await main(["expo", "upload-update", "--update-json", json, dist], io)).toBe(0);
    expect(configReads).toBe(1);
    expect(s.requests.map((r) => [r.pathname, r.query])).toEqual([
      ["/api/symbols/sourcemap-index", { release: "com.example.shop@3.8.0+412", dist: IOS_UPDATE, file: "~/main.jsbundle", debug_id: MAP_DEBUG_ID }],
      ["/api/symbols/sourcemap-index", { release: "com.example.shop@3.8.0+415", dist: ANDROID_UPDATE, file: "~/index.android.bundle", debug_id: MAP_DEBUG_ID }],
    ]);
  });

  it("uses the release flags without reading the Expo config", async () => {
    const s = await server();
    const { json, dist } = await exported();
    const expoConfig = async () => {
      throw new Error("must not be read");
    };
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { expoConfig });
    const argv = ["expo", "upload-update", "--update-json", json, "--release-ios", "ios-r", "--release-android", "android-r", dist];
    expect(await main(argv, io)).toBe(0);
    expect(s.requests.map((r) => r.query.release)).toEqual(["ios-r", "android-r"]);
  });

  it("fails without a request when a platform's bundle is missing", async () => {
    const s = await server();
    const { json, dist } = await exported(["ios"]);
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { expoConfig: async () => EXPO_CONFIG });
    expect(await main(["expo", "upload-update", "--update-json", json, dist], io)).toBe(1);
    expect(out.stderr).toContain(path.join("_expo", "static", "js", "android"));
    expect(s.requests).toHaveLength(0);
  });

  it("fails without a request when the release cannot be computed", async () => {
    const s = await server();
    const { json, dist } = await exported();
    const incomplete = { ...EXPO_CONFIG, ios: { bundleIdentifier: "com.example.shop" } };
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { expoConfig: async () => incomplete });
    expect(await main(["expo", "upload-update", "--update-json", json, dist], io)).toBe(1);
    expect(out.stderr).toContain("ios.buildNumber");
    expect(out.stderr).toContain("--release-ios");
    expect(s.requests).toHaveLength(0);
  });

  it("fails when the JSON has no ios or android update", async () => {
    const s = await server();
    const { root, dist } = await exported();
    await writeFiles(root, { "web.json": JSON.stringify([{ id: "x", platform: "web" }]) });
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { expoConfig: async () => EXPO_CONFIG });
    expect(await main(["expo", "upload-update", "--update-json", path.join(root, "web.json"), dist], io)).toBe(1);
    expect(out.stderr).toContain("no ios or android update");
    expect(s.requests).toHaveLength(0);
  });

  it("fails when an upload fails", async () => {
    const s = await server(() => ({ status: 500, body: { error: "boom" } }));
    const { json, dist } = await exported();
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { expoConfig: async () => EXPO_CONFIG });
    expect(await main(["expo", "upload-update", "--update-json", json, dist], io)).toBe(1);
  });
});
