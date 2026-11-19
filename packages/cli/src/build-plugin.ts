import { unlink } from "node:fs/promises";
import { type Io, main } from "./cli.js";
import { walk } from "./files.js";

export interface CohorlyUploadOptions {
  /** Must equal the `release` the SDK sends with every error. */
  release: string;
  /** Must equal the `dist` the SDK sends, when it sends one. */
  dist?: string;
  /** Upload token. Default: COHORLY_UPLOAD_TOKEN. */
  token?: string;
  /** Cohorly API base URL. Default: COHORLY_API_URL, else the hosted API. */
  apiUrl?: string;
  /** The only way to build without uploading. */
  disabled?: boolean;
  /**
   * Delete every .map of the output after the upload. Default: true when the
   * plugin turned source maps on, false when the build already produced them.
   */
  deleteSourceMapsAfterUpload?: boolean;
}

export function assertUploadOptions(options: CohorlyUploadOptions): void {
  if (options.disabled) return;
  if (typeof options.release !== "string" || options.release.trim() === "") {
    throw new Error("cohorly: `release` is required (the same value the SDK sends), or pass `disabled: true`");
  }
}

function prefixed(write: (text: string) => void): (text: string) => void {
  return (text) => write(text.replace(/^(?=.)/gm, "[cohorly] "));
}

function pluginIo(options: CohorlyUploadOptions): Io {
  const env: Io["env"] = { ...process.env };
  if (options.token) env.COHORLY_UPLOAD_TOKEN = options.token;
  if (options.apiUrl) env.COHORLY_API_URL = options.apiUrl;
  return {
    env,
    stdout: prefixed((t) => process.stdout.write(t)),
    stderr: prefixed((t) => process.stderr.write(t)),
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** `cohorly sourcemaps inject <dir>` then `cohorly sourcemaps upload`, in process. Throws on any failure. */
export async function injectAndUpload(dir: string, options: CohorlyUploadOptions): Promise<void> {
  const io = pluginIo(options);
  if ((await main(["sourcemaps", "inject", dir], io)) !== 0) {
    throw new Error(`cohorly: debug id injection failed in ${dir}`);
  }
  const args = ["sourcemaps", "upload", "--release", options.release];
  if (options.dist) args.push("--dist", options.dist);
  args.push(dir);
  if ((await main(args, io)) !== 0) {
    throw new Error(
      `cohorly: source map upload failed for release ${options.release} (see the errors above); errors from this build could not be symbolicated. Pass \`disabled: true\` to build without uploading`,
    );
  }
}

export async function deleteSourceMaps(dir: string): Promise<number> {
  let deleted = 0;
  for (const file of await walk(dir)) {
    if (!file.endsWith(".map")) continue;
    await unlink(file);
    deleted++;
  }
  return deleted;
}
