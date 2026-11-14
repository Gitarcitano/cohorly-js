import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Child-process tests run the SDK from source, transpiled here, never from
 * `dist`: a stale build would test old code, and the coordinator does not
 * build before testing. `@cohorly/core` is transpiled from its source too and
 * the import rewritten to it, so nothing depends on core's `dist` either.
 * Everything lands under packages/sdk-node/.tmp-test/ (gitignored).
 */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_SRC = path.resolve(PACKAGE_DIR, "../sdk-core/src");
const TMP_ROOT = path.join(PACKAGE_DIR, ".tmp-test");

const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
};

function transpileDir(
  srcDir: string,
  outDir: string,
  rewrite: (code: string) => string = (code) => code,
): void {
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      transpileDir(src, path.join(outDir, entry.name), rewrite);
      continue;
    }
    if (
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".d.ts")
    ) {
      continue;
    }
    const { outputText } = ts.transpileModule(readFileSync(src, "utf8"), {
      compilerOptions: COMPILER_OPTIONS,
      fileName: src,
    });
    writeFileSync(
      path.join(outDir, entry.name.replace(/\.ts$/, ".js")),
      rewrite(outputText),
    );
  }
}

/**
 * Transpiles the SDK into a fresh directory and returns it. The SDK entry is
 * `<dir>/sdk/index.js`; put child scripts at `<dir>/` and import `./sdk/index.js`.
 */
export function buildSdk(name: string): string {
  const dir = path.join(TMP_ROOT, `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  transpileDir(CORE_SRC, path.join(dir, "core"));
  transpileDir(path.join(PACKAGE_DIR, "src"), path.join(dir, "sdk"), (code) =>
    code.replaceAll('"@cohorly/core"', '"../core/index.js"'),
  );
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  return dir;
}

/** Removes a directory from buildSdk(), and .tmp-test itself once empty. */
export function removeSdk(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  try {
    rmdirSync(TMP_ROOT);
  } catch {
    // another test file still uses it
  }
}

/** Transpiles one TypeScript source to JavaScript with an inline source map. */
export function transpileWithSourceMap(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { ...COMPILER_OPTIONS, inlineSourceMap: true },
    fileName,
  }).outputText;
}
