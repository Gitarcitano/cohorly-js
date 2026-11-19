import path from "node:path";
import { assertUploadOptions, type CohorlyUploadOptions, deleteSourceMaps, injectAndUpload } from "./build-plugin.js";

export type { CohorlyUploadOptions } from "./build-plugin.js";

export interface ProductionCompileMetadata {
  distDir: string;
  projectDir: string;
}

/** The subset of `NextConfig` this wrapper touches, so it does not depend on `next`. */
export interface NextConfigLike {
  productionBrowserSourceMaps?: boolean;
  compiler?: {
    runAfterProductionCompile?: (metadata: ProductionCompileMetadata) => unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function wrap<C extends NextConfigLike>(config: C, options: CohorlyUploadOptions): C {
  if (options.disabled) return config;
  const enabledByPlugin = config.productionBrowserSourceMaps !== true;
  const userHook = config.compiler?.runAfterProductionCompile;
  return {
    ...config,
    productionBrowserSourceMaps: true,
    compiler: {
      ...config.compiler,
      runAfterProductionCompile: async (metadata: ProductionCompileMetadata) => {
        if (userHook) await userHook(metadata);
        const staticDir = path.join(path.resolve(metadata.projectDir, metadata.distDir), "static");
        await injectAndUpload(staticDir, options);
        if (options.deleteSourceMapsAfterUpload ?? enabledByPlugin) await deleteSourceMaps(staticDir);
      },
    },
  };
}

/**
 * Turns on browser source maps, then after `next build` compiles (Next 15.4+,
 * `compiler.runAfterProductionCompile`) injects debug ids into
 * `<distDir>/static` and uploads its source map indexes (keys `~/chunks/...`).
 * A failed upload fails the build; `disabled: true` is the only way to skip it.
 */
export function withCohorly<C extends NextConfigLike>(nextConfig: C, options: CohorlyUploadOptions): C & NextConfigLike;
export function withCohorly<C extends NextConfigLike, A extends unknown[]>(
  nextConfig: (...args: A) => C | Promise<C>,
  options: CohorlyUploadOptions,
): (...args: A) => Promise<C & NextConfigLike>;
export function withCohorly(nextConfig: unknown, options: CohorlyUploadOptions): unknown {
  assertUploadOptions(options);
  if (typeof nextConfig === "function") {
    const factory = nextConfig as (...args: unknown[]) => NextConfigLike | Promise<NextConfigLike>;
    return async (...args: unknown[]) => wrap(await factory(...args), options);
  }
  return wrap(nextConfig as NextConfigLike, options);
}

export default withCohorly;
