import path from "node:path";
import { assertUploadOptions, type CohorlyUploadOptions, deleteSourceMaps, injectAndUpload } from "./build-plugin.js";

export type { CohorlyUploadOptions } from "./build-plugin.js";

type SourcemapOption = boolean | "inline" | "hidden";

/** The subset of Vite's plugin API this plugin uses, so it does not depend on `vite`. */
export interface CohorlyVitePlugin {
  name: string;
  apply: "build";
  enforce: "post";
  config(config: { build?: { sourcemap?: SourcemapOption; ssr?: unknown } }, env?: { isSsrBuild?: boolean }): { build: { sourcemap: "hidden" } } | undefined;
  configResolved(config: { root: string; build: { outDir: string; ssr?: unknown } }): void;
  buildEnd(error?: Error): void;
  closeBundle(): Promise<void>;
}

/**
 * Injects debug ids into the client build output and uploads its source map
 * indexes when the build closes. Turns source maps on as "hidden" when they
 * are off (and then deletes them after the upload). A failed upload fails the
 * build; `disabled: true` is the only way to skip it.
 */
export function cohorlyVitePlugin(options: CohorlyUploadOptions): CohorlyVitePlugin {
  assertUploadOptions(options);
  let enabledByPlugin = false;
  let outDir: string | null = null;
  let skip = options.disabled === true;
  return {
    name: "cohorly",
    apply: "build",
    enforce: "post",
    config(config, env) {
      if (skip || env?.isSsrBuild || config.build?.ssr) return undefined;
      if (config.build?.sourcemap === "inline") {
        throw new Error('cohorly: build.sourcemap "inline" writes no .map file to upload; use true or "hidden"');
      }
      if (config.build?.sourcemap) return undefined;
      enabledByPlugin = true;
      return { build: { sourcemap: "hidden" } };
    },
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      if (config.build.ssr) skip = true;
    },
    buildEnd(error) {
      if (error) skip = true;
    },
    async closeBundle() {
      if (skip) return;
      if (outDir === null) throw new Error("cohorly: the Vite output directory is unknown (configResolved did not run)");
      await injectAndUpload(outDir, options);
      if (options.deleteSourceMapsAfterUpload ?? enabledByPlugin) await deleteSourceMaps(outDir);
    },
  };
}

export default cohorlyVitePlugin;
