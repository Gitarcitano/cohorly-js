import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDebugIdComment } from "../src/debug-id.js";
import { exists } from "../src/files.js";
import { withCohorly } from "../src/next.js";
import { cohorlyVitePlugin } from "../src/vite.js";
import { fixtureMap, type Responder, startServer, tempDir, writeFiles } from "./helpers.js";

const TOKEN = "chrly_upload_plugin_token_value";

let servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  vi.unstubAllEnvs();
});

async function server(responder?: Responder) {
  const s = await startServer(responder);
  servers.push(s);
  return s;
}

async function output(prefix: string) {
  const root = await tempDir();
  await writeFiles(root, {
    [`${prefix}/app.js`]: "x()\n//# sourceMappingURL=app.js.map\n",
    [`${prefix}/app.js.map`]: JSON.stringify(fixtureMap()),
  });
  return { root, bundle: path.join(root, prefix, "app.js"), map: path.join(root, prefix, "app.js.map") };
}

async function viteBuild(options: Parameters<typeof cohorlyVitePlugin>[0], userSourcemap?: boolean) {
  const out = await output("dist/assets");
  const plugin = cohorlyVitePlugin(options);
  const added = plugin.config({ build: userSourcemap === undefined ? {} : { sourcemap: userSourcemap } }, { isSsrBuild: false });
  plugin.configResolved({ root: out.root, build: { outDir: "dist" } });
  return { ...out, plugin, added };
}

describe("cohorlyVitePlugin", () => {
  it("injects a debug id and uploads the index on closeBundle, then deletes the maps it turned on", async () => {
    const s = await server();
    const { plugin, added, bundle, map } = await viteBuild({ release: "web@2026.11.3", dist: "b71e04", token: TOKEN, apiUrl: s.url });
    expect(plugin.apply).toBe("build");
    expect(plugin.enforce).toBe("post");
    expect(added).toEqual({ build: { sourcemap: "hidden" } });

    await plugin.closeBundle();
    const debugId = readDebugIdComment(await readFile(bundle, "utf8"));
    expect(debugId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.requests.map((r) => [r.pathname, r.headers.authorization, r.query])).toEqual([
      ["/api/symbols/sourcemap-index", `Bearer ${TOKEN}`, { release: "web@2026.11.3", dist: "b71e04", file: "~/assets/app.js", debug_id: debugId }],
    ]);
    expect(await exists(map)).toBe(false);
  });

  it("keeps the maps when the build already produced them", async () => {
    const s = await server();
    const { plugin, added, map } = await viteBuild({ release: "r1", token: TOKEN, apiUrl: s.url }, true);
    expect(added).toBeUndefined();
    await plugin.closeBundle();
    expect(s.requests).toHaveLength(1);
    expect(await exists(map)).toBe(true);
  });

  it("rejects, failing the build, when the server refuses or fails", async () => {
    for (const status of [403, 500]) {
      const s = await server(() => ({ status, body: { error: "nope" } }));
      const { plugin } = await viteBuild({ release: "r1", token: TOKEN, apiUrl: s.url });
      await expect(plugin.closeBundle()).rejects.toThrow("source map upload failed");
    }
  });

  it("rejects without a token", async () => {
    vi.stubEnv("COHORLY_UPLOAD_TOKEN", "");
    const s = await server();
    const { plugin } = await viteBuild({ release: "r1", apiUrl: s.url });
    await expect(plugin.closeBundle()).rejects.toThrow();
    expect(s.requests).toHaveLength(0);
  });

  it("does nothing when disabled, for SSR builds, or after a failed build", async () => {
    const s = await server();
    const disabled = await viteBuild({ release: "r1", token: TOKEN, apiUrl: s.url, disabled: true });
    expect(disabled.added).toBeUndefined();
    await disabled.plugin.closeBundle();

    const ssr = await viteBuild({ release: "r1", token: TOKEN, apiUrl: s.url });
    ssr.plugin.configResolved({ root: ssr.root, build: { outDir: "dist", ssr: true } });
    await ssr.plugin.closeBundle();

    const broken = await viteBuild({ release: "r1", token: TOKEN, apiUrl: s.url });
    broken.plugin.buildEnd(new Error("syntax error"));
    await broken.plugin.closeBundle();

    expect(s.requests).toHaveLength(0);
    expect(await exists(disabled.map)).toBe(true);
  });

  it("refuses inline source maps, which leave no .map file to upload", () => {
    const plugin = cohorlyVitePlugin({ release: "web@1" });
    expect(() => plugin.config({ build: { sourcemap: "inline" } }, { isSsrBuild: false })).toThrow('"inline"');
  });

  it("requires a release unless disabled", () => {
    expect(() => cohorlyVitePlugin({ release: "" })).toThrow("release");
    expect(() => cohorlyVitePlugin({ release: "", disabled: true })).not.toThrow();
  });
});

describe("withCohorly (Next.js)", () => {
  async function nextBuild() {
    const out = await output(".next/static/chunks");
    return { ...out, metadata: { distDir: path.join(out.root, ".next"), projectDir: out.root } };
  }

  it("turns on browser source maps, runs the user's hook first, then uploads <distDir>/static", async () => {
    const s = await server();
    const { metadata, bundle, map } = await nextBuild();
    const calls: string[] = [];
    const config = withCohorly(
      {
        reactStrictMode: true,
        compiler: {
          removeConsole: true,
          runAfterProductionCompile: async () => {
            calls.push(`user:${s.requests.length}`);
          },
        },
      },
      { release: "web@2026.11.3", token: TOKEN, apiUrl: s.url },
    );
    expect(config.productionBrowserSourceMaps).toBe(true);
    expect(config.reactStrictMode).toBe(true);
    expect(config.compiler?.removeConsole).toBe(true);

    await config.compiler!.runAfterProductionCompile!(metadata);
    expect(calls).toEqual(["user:0"]);
    const debugId = readDebugIdComment(await readFile(bundle, "utf8"));
    expect(s.requests.map((r) => r.query)).toEqual([{ release: "web@2026.11.3", file: "~/chunks/app.js", debug_id: debugId }]);
    expect(await exists(map)).toBe(false);
  });

  it("keeps the maps when productionBrowserSourceMaps was already on, and accepts a relative distDir", async () => {
    const s = await server();
    const { root, map } = await nextBuild();
    const config = withCohorly({ productionBrowserSourceMaps: true }, { release: "r1", token: TOKEN, apiUrl: s.url });
    await config.compiler!.runAfterProductionCompile!({ distDir: ".next", projectDir: root });
    expect(s.requests).toHaveLength(1);
    expect(await exists(map)).toBe(true);
  });

  it("wraps a config function", async () => {
    const s = await server();
    const { metadata } = await nextBuild();
    const factory = withCohorly(async (phase: string) => ({ env: { phase } }), { release: "r1", token: TOKEN, apiUrl: s.url });
    const config = await factory("phase-production-build");
    expect(config.env).toEqual({ phase: "phase-production-build" });
    await config.compiler!.runAfterProductionCompile!(metadata);
    expect(s.requests).toHaveLength(1);
  });

  it("rejects, failing next build, when the upload fails", async () => {
    const s = await server(() => ({ status: 401, body: { error: "invalid token" } }));
    const { metadata } = await nextBuild();
    const config = withCohorly({}, { release: "r1", token: TOKEN, apiUrl: s.url });
    await expect(config.compiler!.runAfterProductionCompile!(metadata)).rejects.toThrow("source map upload failed");
  });

  it("returns the config untouched when disabled", () => {
    const original = { productionBrowserSourceMaps: false };
    expect(withCohorly(original, { release: "r1", disabled: true })).toBe(original);
  });
});
