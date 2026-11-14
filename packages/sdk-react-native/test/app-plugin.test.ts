import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("../app.plugin.cjs");

type MetaData = { $: Record<string, string> };
type Manifest = { manifest: { application?: Array<{ "meta-data"?: MetaData[] }> } };

const manifest = (metaData?: MetaData[]): Manifest => ({
  manifest: { application: [metaData ? { "meta-data": metaData } : {}] },
});

const metaOf = (m: Manifest) =>
  Object.fromEntries((m.manifest.application?.[0]["meta-data"] ?? []).map((e) => [e.$["android:name"], e.$["android:value"]]));

const props = { projectToken: "tok", apiHost: "https://api.example.com" };

describe("validateProps", () => {
  it("normalizes the host and defaults the watchdog off", () => {
    expect(plugin.validateProps({ projectToken: "tok", apiHost: "https://api.example.com//" })).toEqual({
      projectToken: "tok",
      apiHost: "https://api.example.com",
      androidAnrWatchdog: false,
    });
    expect(plugin.validateProps({ ...props, apiHost: "http://10.0.2.2:4000" }).apiHost).toBe("http://10.0.2.2:4000");
  });

  it("requires a project token", () => {
    expect(() => plugin.validateProps({ apiHost: props.apiHost })).toThrow(/projectToken/);
    expect(() => plugin.validateProps({ ...props, projectToken: " " })).toThrow(/projectToken/);
    expect(() => plugin.validateProps(undefined)).toThrow(/projectToken/);
  });

  it("requires an http(s) api host", () => {
    expect(() => plugin.validateProps({ projectToken: "tok" })).toThrow(/apiHost/);
    expect(() => plugin.validateProps({ ...props, apiHost: "api.example.com" })).toThrow(/apiHost/);
    expect(() => plugin.validateProps({ ...props, apiHost: "ftp://api.example.com" })).toThrow(/apiHost/);
  });

  it("rejects a non-boolean watchdog flag", () => {
    expect(() => plugin.validateProps({ ...props, androidAnrWatchdog: "true" })).toThrow(/androidAnrWatchdog/);
  });
});

describe("applyAndroidManifest", () => {
  it("adds the token and host meta-data", () => {
    const m = plugin.applyAndroidManifest(manifest(), plugin.validateProps(props));

    expect(metaOf(m)).toEqual({ "com.cohorly.PROJECT_TOKEN": "tok", "com.cohorly.API_HOST": "https://api.example.com" });
  });

  it("updates in place and never duplicates, keeping unrelated entries", () => {
    const m = manifest([
      { $: { "android:name": "expo.modules.updates.ENABLED", "android:value": "true" } },
      { $: { "android:name": "com.cohorly.PROJECT_TOKEN", "android:value": "old" } },
      { $: { "android:name": "com.cohorly.PROJECT_TOKEN", "android:value": "older" } },
    ]);

    plugin.applyAndroidManifest(m, plugin.validateProps(props));
    plugin.applyAndroidManifest(m, plugin.validateProps({ ...props, projectToken: "new" }));

    const entries = m.manifest.application?.[0]["meta-data"] ?? [];
    expect(entries.filter((e) => e.$["android:name"] === "com.cohorly.PROJECT_TOKEN")).toHaveLength(1);
    expect(entries.filter((e) => e.$["android:name"] === "com.cohorly.API_HOST")).toHaveLength(1);
    expect(metaOf(m)).toEqual({
      "expo.modules.updates.ENABLED": "true",
      "com.cohorly.PROJECT_TOKEN": "new",
      "com.cohorly.API_HOST": "https://api.example.com",
    });
  });

  it("writes the watchdog flag only when on, and removes it when turned off", () => {
    const m = manifest();

    plugin.applyAndroidManifest(m, plugin.validateProps({ ...props, androidAnrWatchdog: true }));
    expect(metaOf(m)["com.cohorly.ANR_WATCHDOG"]).toBe("true");

    plugin.applyAndroidManifest(m, plugin.validateProps(props));
    expect(metaOf(m)).not.toHaveProperty("com.cohorly.ANR_WATCHDOG");
  });

  it("fails loudly without an <application>", () => {
    expect(() => plugin.applyAndroidManifest({ manifest: {} }, plugin.validateProps(props))).toThrow(/application/);
  });
});

describe("package wiring", () => {
  it("exports the plugin the way Expo resolves it", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    expect(pkg.exports["./app.plugin"]).toBe("./app.plugin.cjs");
    expect(pkg.exports["./app.plugin.js"]).toBe("./app.plugin.cjs");
    expect(pkg.exports["./app.plugin.cjs"]).toBe("./app.plugin.cjs");
    expect(pkg.files).toContain("app.plugin.cjs");
    expect(typeof plugin).toBe("function");
    expect(typeof plugin.withCohorlyAndroid).toBe("function");
  });

  it("validates props before loading @expo/config-plugins", () => {
    expect(() => plugin({}, { apiHost: props.apiHost })).toThrow(/projectToken/);
  });
});
