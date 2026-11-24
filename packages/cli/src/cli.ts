import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ParseArgsConfig, parseArgs, promisify } from "node:util";
import { injectDebugId, readMapDebugId } from "./debug-id.js";
import { DEFAULT_API_URL } from "./defaults.js";
import { bundleKey, exists, isDirectory, walk } from "./files.js";
import { importMixpanel } from "./import-mixpanel.js";
import { importMixpanelLexicon } from "./import-mixpanel-lexicon.js";
import { importMixpanelProfiles } from "./import-mixpanel-profiles.js";
import { buildIndex, type DecodedMap, serializeIndex } from "./index-format.js";
import { parsePgMapId } from "./r8.js";
import { composeHermes, decodeSourceMap } from "./sourcemap.js";
import { type SymcacheBuilder, type SymcacheSliceResult, xcodeSymcacheBuilder } from "./symcache/macho.js";
import { type SymbolKind, type UploadDeps, type UploadResult, uploadArtifact } from "./upload.js";
import { UsageError } from "./usage-error.js";
import { VERSION } from "./version.js";

export { DEFAULT_API_URL };
export const DSYM_REQUIRES_MACOS =
  "dSYM upload needs macOS with Xcode: the symcache is built with the Xcode toolchain (xcrun dwarfdump). Run this step on the Mac that built the app";
export const XCODE_TOOLS_MISSING =
  "dSYM upload needs the Xcode command line tools (xcrun dwarfdump was not found). Install the Command Line Tools with `xcode-select --install`";

export interface Io extends UploadDeps {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Defaults to process.platform. dSYMs are only processed on "darwin". */
  platform?: NodeJS.Platform;
  /** Defaults to the Xcode toolchain builder. */
  symcache?: SymcacheBuilder;
  /** Reads one key of a property list. Defaults to `plutil -extract <key> raw`. */
  plistValue?: (file: string, key: string) => Promise<string | undefined>;
  /** The public Expo config of the project. Defaults to `npx expo config --json --type public`. */
  expoConfig?: () => Promise<unknown>;
  /** Wall clock in ms, used to pace progress lines. Defaults to Date.now. */
  now?: () => number;
}

const HELP = `Usage: cohorly <command> [options]

Commands:
  sourcemaps inject <dir>       Add a debug id to every bundle that has a sibling .map
  sourcemaps upload <dir>       Build source map indexes and upload them
  debug-files upload <path>     Upload R8 mapping.txt files and dSYMs (as symcaches, macOS only)
  react-native xcode            Xcode build phase: upload the bundle's source map and the dSYMs
  react-native gradle           Gradle task: upload the bundle's source map and the R8 mapping
  expo upload-update [<dist>]   Upload the source maps of an \`eas update\`
  import mixpanel <path>        Import a raw Mixpanel event export into a project
  import mixpanel-lexicon <file> Import Mixpanel Lexicon names, descriptions and tags
  import mixpanel-profiles <path>  Import Mixpanel user profiles into a project

Options:
  -h, --help                    Show help for a command
  -v, --version                 Print the CLI version

Environment:
  COHORLY_UPLOAD_TOKEN          Upload token (or --token)
  COHORLY_IMPORT_TOKEN          Credential of \`import\` commands (or --token)
  COHORLY_API_URL               Cohorly API base URL (or --api-url, default ${DEFAULT_API_URL})
  COHORLY_UPLOAD_DISABLED=1     Makes \`react-native xcode\` and \`react-native gradle\` skip the upload
`;

const INJECT_HELP = `Usage: cohorly sourcemaps inject <dir>

Walks <dir> and, for every .js/.mjs/.cjs file with a sibling <file>.map, writes
"//# debugId=<uuid>" into the bundle and "debugId" into the map. The id is a
UUID v5 of the bundle content and its source map. Files that already carry a debug id are left
as they are, so running it twice changes nothing.
`;

const SOURCEMAPS_UPLOAD_HELP = `Usage: cohorly sourcemaps upload --release <release> [--dist <dist>] <dir>

Builds a compact lookup index from every .map under <dir> and uploads only the
index. sourcesContent never leaves the build machine.

Hermes: a <x>.bundle.map next to a <x>.hbc.map is composed into one index for
<x>.bundle. Use --packager-map and --hermes-map to name the pair explicitly.

Options:
  --release <release>         Must equal $exception_release sent by the SDK (required)
  --dist <dist>               Must equal $exception_dist sent by the SDK
  --token <token>             Upload token (default: COHORLY_UPLOAD_TOKEN)
  --api-url <url>             API base URL (default: COHORLY_API_URL or ${DEFAULT_API_URL})
  --packager-map <file>       Metro/packager source map of a Hermes bundle
  --hermes-map <file>         Hermes compiler source map of the same bundle
  --bundle-file <path>        Bundle path the explicit Hermes pair is stored under
                              (default: the packager map path without .map and .packager)
  -h, --help                  Show this help
`;

const DEBUG_FILES_UPLOAD_HELP = `Usage: cohorly debug-files upload --release <release> [--dist <dist>] <path>

<path> is a file or a directory:
  - R8/ProGuard mapping.txt files are uploaded as they are.
  - dSYMs (a .dSYM, a DWARF file inside X.dSYM/Contents/Resources/DWARF/, or a
    directory that contains .dSYMs) are turned into one symcache per arch
    slice and only the symcache is uploaded, keyed by the slice's LC_UUID.
    The raw dSYM never leaves the build machine. This needs macOS with the
    Xcode command line tools (xcrun dwarfdump); anywhere else a path with a
    dSYM fails before any upload. A slice whose LC_UUID the server already
    holds (an unchanged framework rebuilt under another path) is reported
    "already uploaded" and is not a failure.

Options:
  --release <release>         Must equal $exception_release sent by the SDK (required)
  --dist <dist>               Must equal $exception_dist sent by the SDK
  --token <token>             Upload token (default: COHORLY_UPLOAD_TOKEN)
  --api-url <url>             API base URL (default: COHORLY_API_URL or ${DEFAULT_API_URL})
  -h, --help                  Show this help
`;

const REACT_NATIVE_XCODE_HELP = `Usage: cohorly react-native xcode

Run from an Xcode build phase of a React Native app (the @cohorly/cli Expo
plugin adds it). Reads the Xcode build environment:

  - CONFIGURATION containing "Debug": prints that it skipped, exits 0.
  - Release: <CFBundleIdentifier>@<CFBundleShortVersionString>+<CFBundleVersion>
    from the processed Info.plist ($TARGET_BUILD_DIR/$INFOPLIST_PATH), or
    COHORLY_RELEASE when set.
  - Uploads the index of $SOURCEMAP_FILE (default
    $DERIVED_FILE_DIR/main.jsbundle.map) as ~/main.jsbundle, and every .dSYM in
    $DWARF_DSYM_FOLDER_PATH as symcaches. No dist: an embedded bundle has none.
  - Waits up to COHORLY_DSYM_WAIT_SECONDS (default 30) for the app's dSYM
    ($DWARF_DSYM_FILE_NAME) while Xcode is still writing it.

A missing map or dSYM, or any failed upload, exits 1 and fails the build. A
dSYM slice the server already holds (same LC_UUID) is "already uploaded", not
a failure. COHORLY_UPLOAD_DISABLED=1 is the only way to skip the upload.
`;

const REACT_NATIVE_GRADLE_HELP = `Usage: cohorly react-native gradle --release <release> --sourcemap <map> [--mapping <mapping.txt>]

Run from the Gradle task the @cohorly/cli Expo plugin registers for every
release variant. Uploads the index of <map> as ~/index.android.bundle and, with
--mapping, the R8 mapping.txt. No dist: an embedded bundle has none.

A missing file or any failed upload exits 1 and fails the build.
COHORLY_UPLOAD_DISABLED=1 is the only way to skip the upload.

Options:
  --release <release>         <applicationId>@<versionName>+<versionCode> (required)
  --sourcemap <map>           Composed source map of index.android.bundle (required)
  --mapping <mapping.txt>     R8 mapping of the same variant
  --token <token>             Upload token (default: COHORLY_UPLOAD_TOKEN)
  --api-url <url>             API base URL (default: COHORLY_API_URL or ${DEFAULT_API_URL})
  -h, --help                  Show this help
`;

const EXPO_UPLOAD_UPDATE_HELP = `Usage: cohorly expo upload-update --update-json <file> [--release-ios <r>] [--release-android <r>] [<distDir>]

Uploads the source maps of an EAS Update. Export with source maps, publish with
--json, then run this command:

  eas update --json --non-interactive > update.json   (with expo export --source-maps,
                                                       or eas update --source-maps)
  cohorly expo upload-update --update-json update.json dist

For each platform in update.json, finds the one bundle (.hbc or .js) with its
.map in <distDir>/_expo/static/js/<platform>/ and uploads its index as
~/main.jsbundle (ios) or ~/index.android.bundle (android), dist = that
platform's update id. The release comes from the flags, or else from
\`npx expo config --json --type public\`: <bundleIdentifier|package>@<version>+<buildNumber|versionCode>.
Anything missing exits 1; nothing is guessed.

Options:
  --update-json <file>        Output of \`eas update --json\` (required)
  --release-ios <release>     Release of the iOS binaries the update targets
  --release-android <release> Release of the Android binaries the update targets
  --token <token>             Upload token (default: COHORLY_UPLOAD_TOKEN)
  --api-url <url>             API base URL (default: COHORLY_API_URL or ${DEFAULT_API_URL})
  -h, --help                  Show this help
`;

const IMPORT_HELP = `Usage: cohorly import <source> [options]

Sources:
  mixpanel <path>               Import a raw Mixpanel event export (one JSON event per line)
  mixpanel-lexicon <file>       Import Mixpanel Lexicon names, descriptions and tags
  mixpanel-profiles <path>      Import Mixpanel user profiles (export page or one profile per line)

Run \`cohorly import <source> --help\` for its options.
`;

const TARGET_OPTIONS = {
  token: { type: "string" },
  "api-url": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

const UPLOAD_OPTIONS = {
  ...TARGET_OPTIONS,
  release: { type: "string" },
  dist: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function single(positionals: string[], what: string): string {
  if (positionals.length !== 1) throw new UsageError(`expected exactly one ${what}`);
  return positionals[0]!;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new UsageError(`missing required option --${flag}`);
  return value;
}

interface Target {
  apiUrl: string;
  token: string;
}

function resolveTarget(values: { token?: string; "api-url"?: string }, env: Io["env"]): Target {
  const token = values.token ?? env.COHORLY_UPLOAD_TOKEN;
  if (!token) throw new UsageError("missing upload token: set COHORLY_UPLOAD_TOKEN or pass --token");
  const apiUrl = values["api-url"] ?? env.COHORLY_API_URL ?? DEFAULT_API_URL;
  if (!/^https?:\/\//.test(apiUrl)) throw new UsageError(`invalid API URL: ${apiUrl}`);
  return { apiUrl, token };
}

function tokensIn(argv: string[], env: Io["env"]): string[] {
  const tokens = [env.COHORLY_UPLOAD_TOKEN, env.COHORLY_IMPORT_TOKEN];
  argv.forEach((arg, i) => {
    if (arg === "--token") tokens.push(argv[i + 1]);
    else if (arg.startsWith("--token=")) tokens.push(arg.slice("--token=".length));
  });
  return tokens.filter((t): t is string => typeof t === "string" && t.length > 0);
}

function redactingIo(io: Io, secrets: string[]): Io {
  const redact = (text: string) => secrets.reduce((out, s) => out.split(s).join("[redacted]"), text);
  return { ...io, stdout: (t) => io.stdout(redact(t)), stderr: (t) => io.stderr(redact(t)) };
}

export async function main(argv: string[], rawIo: Io): Promise<number> {
  const io = redactingIo(rawIo, tokensIn(argv, rawIo.env));
  try {
    return await run(argv, io);
  } catch (err) {
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const GROUPS = new Set(["sourcemaps", "debug-files", "react-native", "expo"]);

async function run(argv: string[], io: Io): Promise<number> {
  const [command, sub, ...rest] = argv;
  if (command === "-v" || command === "--version") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    io.stdout(HELP);
    return command === undefined ? 1 : 0;
  }
  if (command === "sourcemaps" && sub === "inject") return inject(rest, io);
  if (command === "sourcemaps" && sub === "upload") return uploadSourcemaps(rest, io);
  if (command === "debug-files" && sub === "upload") return uploadDebugFiles(rest, io);
  if (command === "react-native" && sub === "xcode") return reactNativeXcode(rest, io);
  if (command === "react-native" && sub === "gradle") return reactNativeGradle(rest, io);
  if (command === "expo" && sub === "upload-update") return expoUploadUpdate(rest, io);
  if (command === "import" && sub === "mixpanel") return importMixpanel(rest, io);
  if (command === "import" && sub === "mixpanel-lexicon") return importMixpanelLexicon(rest, io);
  if (command === "import" && sub === "mixpanel-profiles") return importMixpanelProfiles(rest, io);
  if (command === "import" && (sub === undefined || sub === "-h" || sub === "--help")) {
    io.stdout(IMPORT_HELP);
    return sub === undefined ? 1 : 0;
  }
  if (GROUPS.has(command) && (sub === undefined || sub === "-h" || sub === "--help")) {
    io.stdout(HELP);
    return sub === undefined ? 1 : 0;
  }
  throw new UsageError(`unknown command: ${[command, sub].filter(Boolean).join(" ")} (see cohorly --help)`);
}

const BUNDLE_EXTENSIONS = [".js", ".mjs", ".cjs"];

async function inject(args: string[], io: Io): Promise<number> {
  const { values, positionals } = guard(() =>
    parseArgs({ args, options: { help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true }),
  );
  if (values.help) {
    io.stdout(INJECT_HELP);
    return 0;
  }
  const dir = single(positionals, "directory");
  if (!(await isDirectory(dir))) throw new UsageError(`not a directory: ${dir}`);
  let injected = 0;
  let unchanged = 0;
  let failed = 0;
  for (const file of await walk(dir)) {
    if (!BUNDLE_EXTENSIONS.includes(path.extname(file))) continue;
    const mapPath = `${file}.map`;
    if (!(await exists(mapPath))) continue;
    const key = bundleKey(dir, file);
    try {
      const result = injectDebugId(await readFile(file, "utf8"), await readFile(mapPath, "utf8"));
      if (result.source !== null) await writeFile(file, result.source);
      if (result.map !== null) await writeFile(mapPath, result.map);
      if (result.source === null && result.map === null) {
        unchanged++;
      } else {
        injected++;
        io.stdout(`injected ${result.debugId} ${key}\n`);
      }
    } catch (err) {
      failed++;
      io.stderr(`failed ${key}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  io.stdout(`${injected} injected, ${unchanged} already had a debug id, ${failed} failed\n`);
  return failed > 0 ? 1 : 0;
}

interface Job {
  label: string;
  kind: SymbolKind;
  query: Record<string, string | undefined>;
  body: () => Promise<Uint8Array>;
  /** Set on a slice that is skipped by design: logged as a warning, never uploaded, never a failure. */
  skip?: string;
}

// The server's 409 for a debug id it already holds with other bytes. For a
// symcache that is the same binary (same LC_UUID) built under another path
// (DerivedData moves between builds), so the copy on the server serves it.
// A source map index's debug id hashes its content, so there it stays a failure.
function alreadyUploaded(job: Job, result: UploadResult): boolean {
  return job.kind === "symcache" && !result.ok && result.status === 409 && result.error.includes("debug_id already uploaded");
}

async function runJobs(jobs: Iterable<Job> | AsyncIterable<Job>, target: Target, io: Io): Promise<number> {
  let uploaded = 0;
  let present = 0;
  let failed = 0;
  let skipped = 0;
  for await (const job of jobs) {
    if (job.skip !== undefined) {
      skipped++;
      io.stderr(`warning: skipped ${job.label}: ${job.skip}\n`);
      continue;
    }
    let body: Uint8Array;
    try {
      body = await job.body();
    } catch (err) {
      failed++;
      io.stderr(`failed ${job.label}: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
    const result = await uploadArtifact({ ...target, kind: job.kind, body, query: job.query }, io);
    if (result.ok) {
      uploaded++;
      io.stdout(`uploaded ${job.label}${result.id ? ` (${result.id})` : ""}\n`);
    } else if (alreadyUploaded(job, result)) {
      present++;
      io.stdout(`already uploaded ${job.label}\n`);
    } else {
      failed++;
      io.stderr(`failed ${job.label}: ${result.error}\n`);
    }
  }
  io.stdout(`${uploaded} uploaded, ${failed} failed${present > 0 ? `, ${present} already uploaded` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
  return failed > 0 ? 1 : 0;
}

async function* chain(...parts: Array<Iterable<Job> | AsyncIterable<Job>>): AsyncGenerator<Job> {
  for (const part of parts) yield* part;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

function indexJob(
  label: string,
  file: string,
  query: Record<string, string | undefined>,
  build: () => Promise<{ map: DecodedMap; debugId: string | null }>,
): Job {
  const job: Job = {
    label,
    kind: "sourcemap-index",
    query: { ...query, file },
    body: async () => {
      const built = await build();
      if (built.debugId) job.query.debug_id = built.debugId;
      return serializeIndex(buildIndex(built.map));
    },
  };
  return job;
}

function mapIndexJob(mapFile: string, file: string, query: Record<string, string | undefined>): Job {
  return indexJob(`${file} (${mapFile})`, file, query, async () => {
    const json = await readJson(mapFile);
    return { map: decodeSourceMap(json), debugId: readMapDebugId(json) };
  });
}

function r8Job(file: string, query: Record<string, string | undefined>): Job {
  const job: Job = {
    label: file,
    kind: "r8-mapping",
    query: { ...query },
    body: async () => {
      const bytes = await readFile(file);
      if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${file} is not a text R8 mapping file`);
      const mapId = parsePgMapId(bytes.subarray(0, 64 * 1024).toString("utf8"));
      if (mapId) job.query.map_id = mapId;
      return bytes;
    },
  };
  return job;
}

function failedJob(label: string, kind: SymbolKind, error: string): Job {
  return {
    label,
    kind,
    query: {},
    body: async () => {
      throw new Error(error);
    },
  };
}

// One symcache per slice. Files are built one at a time, so at most one
// file's symcaches are held in memory.
async function* symcacheJobs(
  dwarfFiles: string[],
  query: Record<string, string | undefined>,
  builder: SymcacheBuilder,
): AsyncGenerator<Job> {
  for (const file of dwarfFiles) {
    let results: SymcacheSliceResult[];
    try {
      results = await builder.build(file);
    } catch (err) {
      yield failedJob(file, "symcache", err instanceof Error ? err.message : String(err));
      continue;
    }
    if (results.length === 0) yield failedJob(file, "symcache", "no Mach-O slice");
    for (const r of results) {
      if ("error" in r) {
        if (r.unsupported) {
          yield { label: `${file} (${r.arch})`, kind: "symcache", query: {}, body: async () => new Uint8Array(), skip: r.error };
          continue;
        }
        yield failedJob(`${file} (${r.arch})`, "symcache", r.error);
        continue;
      }
      const bytes = r.bytes;
      yield {
        label: `${file} (${r.arch} ${r.debugId})`,
        kind: "symcache",
        query: { ...query, debug_id: r.debugId, arch: r.arch },
        body: async () => bytes,
      };
    }
  }
}

async function requireSymcacheTools(io: Io): Promise<SymcacheBuilder> {
  if ((io.platform ?? process.platform) !== "darwin") throw new UsageError(DSYM_REQUIRES_MACOS);
  const builder = io.symcache ?? xcodeSymcacheBuilder;
  if (!(await builder.available())) throw new UsageError(XCODE_TOOLS_MISSING);
  return builder;
}

function stripSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

async function uploadSourcemaps(args: string[], io: Io): Promise<number> {
  const { values, positionals } = guard(() =>
    parseArgs({
      args,
      options: {
        ...UPLOAD_OPTIONS,
        "packager-map": { type: "string" },
        "hermes-map": { type: "string" },
        "bundle-file": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (values.help) {
    io.stdout(SOURCEMAPS_UPLOAD_HELP);
    return 0;
  }
  const release = required(values.release, "release");
  const dir = single(positionals, "directory");
  if ((values["packager-map"] === undefined) !== (values["hermes-map"] === undefined)) {
    throw new UsageError("--packager-map and --hermes-map must be passed together");
  }
  if (values["bundle-file"] !== undefined && values["packager-map"] === undefined) {
    throw new UsageError("--bundle-file only applies with --packager-map and --hermes-map");
  }
  if (!(await isDirectory(dir))) throw new UsageError(`not a directory: ${dir}`);
  const target = resolveTarget(values, io.env);
  const base = { release, dist: values.dist };

  const maps = (await walk(dir)).filter((f) => f.endsWith(".map") && !f.endsWith(".css.map"));
  const claimed = new Set<string>();
  const jobs: Job[] = [];

  const root = path.resolve(dir);
  const hermesJob = (packagerMap: string, hermesMap: string, bundlePath: string) => {
    const rel = path.relative(root, bundlePath);
    const file = rel.startsWith("..") || path.isAbsolute(rel) ? `~/${path.basename(bundlePath)}` : bundleKey(root, bundlePath);
    return indexJob(`${file} (hermes)`, file, base, async () => {
      const packager = await readJson(packagerMap);
      const hermes = await readJson(hermesMap);
      return { map: composeHermes(packager, hermes), debugId: readMapDebugId(hermes) ?? readMapDebugId(packager) };
    });
  };

  if (values["packager-map"] !== undefined && values["hermes-map"] !== undefined) {
    const packagerMap = path.resolve(values["packager-map"]);
    const hermesMap = path.resolve(values["hermes-map"]);
    claimed.add(packagerMap).add(hermesMap);
    const bundle =
      values["bundle-file"] !== undefined
        ? path.resolve(root, values["bundle-file"])
        : stripSuffix(stripSuffix(packagerMap, ".map"), ".packager");
    jobs.push(hermesJob(packagerMap, hermesMap, bundle));
  }

  for (const hbcMap of maps) {
    if (!hbcMap.endsWith(".hbc.map")) continue;
    const prefix = hbcMap.slice(0, -".hbc.map".length);
    const packagerMap = `${prefix}.bundle.map`;
    if (!maps.includes(packagerMap) || claimed.has(path.resolve(hbcMap)) || claimed.has(path.resolve(packagerMap))) continue;
    claimed.add(path.resolve(hbcMap)).add(path.resolve(packagerMap));
    jobs.push(hermesJob(packagerMap, hbcMap, path.resolve(`${prefix}.bundle`)));
  }

  for (const map of maps) {
    if (claimed.has(path.resolve(map))) continue;
    const file = bundleKey(dir, map.endsWith(".hbc.map") ? `${stripSuffix(map, ".hbc.map")}.bundle` : stripSuffix(map, ".map"));
    jobs.push(
      indexJob(file, file, base, async () => {
        const json = await readJson(map);
        return { map: decodeSourceMap(json), debugId: readMapDebugId(json) };
      }),
    );
  }

  if (jobs.length === 0) throw new UsageError(`no source maps found in ${dir}`);
  return runJobs(jobs, target, io);
}

const DWARF_IN_DSYM = /\.dsym\/Contents\/Resources\/DWARF\/[^/]+$/i;
const DSYM_DIR = /\.dsym$/i;

function posix(p: string): string {
  return path.resolve(p).split(path.sep).join("/");
}

function isDwarfFile(p: string): boolean {
  return DWARF_IN_DSYM.test(posix(p)) && !path.basename(p).startsWith(".");
}

async function findDebugFiles(target: string): Promise<{ mappings: string[]; dwarf: string[]; emptyDsyms: string[] }> {
  if (!(await isDirectory(target))) {
    return isDwarfFile(target)
      ? { mappings: [], dwarf: [target], emptyDsyms: [] }
      : { mappings: [target], dwarf: [], emptyDsyms: [] };
  }
  const entries = await walk(target, { includeDirs: true });
  const dsyms = entries.filter((f) => DSYM_DIR.test(f));
  if (DSYM_DIR.test(posix(target))) dsyms.unshift(target);
  const dwarf = entries.filter(isDwarfFile);
  // A symlinked .dSYM is walked once, under one of its paths: compare real paths.
  const realDwarf = await Promise.all(dwarf.map((file) => realpath(file)));
  const emptyDsyms: string[] = [];
  const seen = new Set<string>();
  for (const dsym of dsyms) {
    const real = await realpath(dsym);
    if (seen.has(real)) continue;
    seen.add(real);
    if (!realDwarf.some((file) => file.startsWith(`${real}${path.sep}`))) emptyDsyms.push(dsym);
  }
  return {
    mappings: entries.filter((f) => path.basename(f) === "mapping.txt" && !/\.dsym\//i.test(posix(f))),
    dwarf,
    emptyDsyms,
  };
}

async function uploadDebugFiles(args: string[], io: Io): Promise<number> {
  const { values, positionals } = guard(() =>
    parseArgs({ args, options: UPLOAD_OPTIONS, allowPositionals: true, strict: true }),
  );
  if (values.help) {
    io.stdout(DEBUG_FILES_UPLOAD_HELP);
    return 0;
  }
  const release = required(values.release, "release");
  const target = single(positionals, "path");
  if (!(await exists(target))) throw new UsageError(`no such file or directory: ${target}`);
  const found = await findDebugFiles(target);
  if (found.emptyDsyms.length > 0) {
    throw new UsageError(`no DWARF file in ${found.emptyDsyms.map((dsym) => `${dsym}/Contents/Resources/DWARF`).join(", ")}`);
  }
  const builder = found.dwarf.length > 0 ? await requireSymcacheTools(io) : null;
  const resolved = resolveTarget(values, io.env);
  if (found.mappings.length === 0 && found.dwarf.length === 0) {
    throw new UsageError(`no mapping.txt or .dSYM found in ${target}`);
  }
  const query = { release, dist: values.dist };
  const jobs = chain(
    found.mappings.map((file) => r8Job(file, query)),
    builder ? symcacheJobs(found.dwarf, query, builder) : [],
  );
  return runJobs(jobs, resolved, io);
}

function uploadDisabled(env: Io["env"]): boolean {
  const v = env.COHORLY_UPLOAD_DISABLED?.trim().toLowerCase();
  return v === "1" || v === "true";
}

const execFileAsync = promisify(execFile);

async function plutilValue(file: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("plutil", ["-extract", key, "raw", "-o", "-", file]);
    const value = stdout.trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

async function npxExpoConfig(): Promise<unknown> {
  const { stdout } = await execFileAsync("npx", ["expo", "config", "--json", "--type", "public"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}

function envPath(env: Io["env"], name: string): string {
  const value = env[name];
  if (!value) throw new UsageError(`${name} is not set: run this command from an Xcode build phase`);
  return value;
}

async function xcodeRelease(env: Io["env"], io: Io): Promise<string> {
  const explicit = env.COHORLY_RELEASE?.trim();
  if (explicit) return explicit;
  const plist = path.join(envPath(env, "TARGET_BUILD_DIR"), envPath(env, "INFOPLIST_PATH"));
  const read = io.plistValue ?? plutilValue;
  const parts: string[] = [];
  for (const key of ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"]) {
    const value = await read(plist, key);
    if (!value) throw new UsageError(`could not read ${key} from ${plist}; set COHORLY_RELEASE to the release the SDK sends`);
    parts.push(value);
  }
  return `${parts[0]}@${parts[1]}+${parts[2]}`;
}

async function topLevelDsyms(dir: string): Promise<string[]> {
  if (!(await isDirectory(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && DSYM_DIR.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

async function dwarfFilesOf(dsym: string): Promise<string[]> {
  const dir = path.join(dsym, "Contents", "Resources", "DWARF");
  if (!(await isDirectory(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name))
    .sort();
}

export const DSYM_WAIT_SECONDS = 30;

async function dwarfSnapshot(dir: string): Promise<string | null> {
  if (!(await isDirectory(dir))) return null;
  const parts: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile()) continue;
    const info = await stat(path.join(dir, entry.name));
    if (info.size === 0) return null;
    parts.push(`${entry.name}:${info.size}:${info.mtimeMs}`);
  }
  return parts.length > 0 ? parts.join("|") : null;
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

// The phase declares the dSYM as an input, but a project prebuilt with an
// older plugin does not, and Xcode can then start it while dsymutil is still
// writing the app's dSYM in place. Ready means: no older than the
// linked binary, and unchanged between two checks one second apart.
async function waitForAppDsym(env: Io["env"], dsymFolder: string, io: Io): Promise<void> {
  const name = env.DWARF_DSYM_FILE_NAME;
  if (!name) return;
  const raw = env.COHORLY_DSYM_WAIT_SECONDS;
  const seconds = raw === undefined || raw.trim() === "" ? DSYM_WAIT_SECONDS : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError(`invalid COHORLY_DSYM_WAIT_SECONDS: ${raw}`);
  const dwarfDir = path.join(dsymFolder, name, "Contents", "Resources", "DWARF");
  const binary =
    env.TARGET_BUILD_DIR && env.EXECUTABLE_PATH ? await mtimeOf(path.join(env.TARGET_BUILD_DIR, env.EXECUTABLE_PATH)) : null;
  let previous: string | null = null;
  for (let waited = 0; ; waited++) {
    const snapshot = await dwarfSnapshot(dwarfDir);
    const fresh = snapshot !== null && (binary === null || (await dwarfNewest(dwarfDir)) >= binary);
    if (fresh && snapshot === previous) return;
    previous = fresh ? snapshot : null;
    if (waited >= seconds) {
      throw new UsageError(
        `${name} was not completely written to ${dsymFolder} within ${seconds}s: set DEBUG_INFORMATION_FORMAT to dwarf-with-dsym, or raise COHORLY_DSYM_WAIT_SECONDS`,
      );
    }
    await io.sleep(1000);
  }
}

async function dwarfNewest(dir: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile()) newest = Math.max(newest, (await stat(path.join(dir, entry.name))).mtimeMs);
  }
  return newest;
}

async function reactNativeXcode(args: string[], io: Io): Promise<number> {
  const { values } = guard(() =>
    parseArgs({ args, options: { help: { type: "boolean", short: "h" } }, allowPositionals: false, strict: true }),
  );
  if (values.help) {
    io.stdout(REACT_NATIVE_XCODE_HELP);
    return 0;
  }
  const env = io.env;
  if (uploadDisabled(env)) {
    io.stderr("warning: COHORLY_UPLOAD_DISABLED is set, Cohorly symbols were NOT uploaded: errors from this build will not be symbolicated\n");
    return 0;
  }
  const configuration = env.CONFIGURATION ?? "";
  if (configuration.includes("Debug")) {
    io.stdout(`cohorly: skipped symbol upload for the ${configuration} configuration\n`);
    return 0;
  }
  const target = resolveTarget({}, env);
  const release = await xcodeRelease(env, io);

  const bundle = path.join(envPath(env, "CONFIGURATION_BUILD_DIR"), envPath(env, "UNLOCALIZED_RESOURCES_FOLDER_PATH"), "main.jsbundle");
  if (!(await exists(bundle))) {
    throw new UsageError(`no JS bundle at ${bundle}: the "Bundle React Native code and images" phase did not produce it (is SKIP_BUNDLING set?)`);
  }
  const map = env.SOURCEMAP_FILE || path.join(envPath(env, "DERIVED_FILE_DIR"), "main.jsbundle.map");
  if (!(await exists(map))) {
    throw new UsageError(
      `no source map at ${map}: the "Bundle React Native code and images" phase must export SOURCEMAP_FILE (the @cohorly/cli Expo plugin adds it; run \`npx expo prebuild\` again)`,
    );
  }
  const dsymFolder = envPath(env, "DWARF_DSYM_FOLDER_PATH");
  await waitForAppDsym(env, dsymFolder, io);
  const dsyms = await topLevelDsyms(dsymFolder);
  if (dsyms.length === 0) {
    throw new UsageError(
      `no .dSYM in ${dsymFolder}: set DEBUG_INFORMATION_FORMAT to dwarf-with-dsym for the ${configuration || "release"} configuration`,
    );
  }
  const dwarf: string[] = [];
  for (const dsym of dsyms) {
    const files = await dwarfFilesOf(dsym);
    if (files.length === 0) throw new UsageError(`no DWARF file in ${dsym}/Contents/Resources/DWARF`);
    dwarf.push(...files);
  }
  const builder = await requireSymcacheTools(io);
  io.stdout(`cohorly: uploading symbols for ${release}\n`);
  const query = { release };
  return runJobs(chain([mapIndexJob(map, "~/main.jsbundle", query)], symcacheJobs(dwarf, query, builder)), target, io);
}

async function reactNativeGradle(args: string[], io: Io): Promise<number> {
  const { values } = guard(() =>
    parseArgs({
      args,
      options: {
        ...TARGET_OPTIONS,
        release: { type: "string" },
        sourcemap: { type: "string" },
        mapping: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    }),
  );
  if (values.help) {
    io.stdout(REACT_NATIVE_GRADLE_HELP);
    return 0;
  }
  if (uploadDisabled(io.env)) {
    io.stderr("warning: COHORLY_UPLOAD_DISABLED is set, Cohorly symbols were NOT uploaded: errors from this build will not be symbolicated\n");
    return 0;
  }
  const release = required(values.release, "release");
  const map = required(values.sourcemap, "sourcemap");
  if (!(await exists(map))) {
    throw new UsageError(`no source map at ${map}: the React Native Gradle plugin writes it when it bundles a release variant`);
  }
  if (values.mapping !== undefined && !(await exists(values.mapping))) {
    throw new UsageError(`no R8 mapping at ${values.mapping}`);
  }
  const target = resolveTarget(values, io.env);
  const query = { release };
  const jobs = [mapIndexJob(map, "~/index.android.bundle", query)];
  if (values.mapping !== undefined) jobs.push(r8Job(values.mapping, query));
  return runJobs(jobs, target, io);
}

const EXPO_BUNDLE_KEYS: Record<string, string> = { ios: "~/main.jsbundle", android: "~/index.android.bundle" };

function readUpdates(json: unknown, file: string): Map<string, string> {
  if (!Array.isArray(json)) throw new UsageError(`${file} is not the output of \`eas update --json\` (expected an array of updates)`);
  const ids = new Map<string, string>();
  for (const entry of json as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const { platform, id } = entry as { platform?: unknown; id?: unknown };
    if (typeof platform !== "string" || !(platform in EXPO_BUNDLE_KEYS)) continue;
    if (typeof id !== "string" || id === "") throw new UsageError(`${file}: the ${platform} update has no id`);
    const previous = ids.get(platform);
    if (previous !== undefined && previous !== id) {
      throw new UsageError(`${file} has more than one ${platform} update (${previous}, ${id}); upload one update group at a time`);
    }
    ids.set(platform, id);
  }
  if (ids.size === 0) throw new UsageError(`${file} has no ios or android update`);
  return ids;
}

async function findExportedBundle(distDir: string, platform: string): Promise<{ bundle: string; map: string }> {
  const dir = path.join(distDir, "_expo", "static", "js", platform);
  if (!(await isDirectory(dir))) {
    throw new UsageError(`no ${dir}: point <distDir> at the folder \`expo export\` / \`eas update\` wrote`);
  }
  const names = (await readdir(dir)).filter((n) => n.endsWith(".hbc") || n.endsWith(".js")).sort();
  if (names.length !== 1) {
    throw new UsageError(`expected exactly one .hbc or .js bundle in ${dir}, found ${names.length === 0 ? "none" : names.join(", ")}`);
  }
  const bundle = path.join(dir, names[0]!);
  const map = `${bundle}.map`;
  if (!(await exists(map))) {
    throw new UsageError(`no source map at ${map}: export with source maps (\`eas update --source-maps\` or \`expo export --source-maps\`)`);
  }
  return { bundle, map };
}

function field(obj: unknown, ...keys: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  return typeof cur === "string" && cur.trim() !== "" ? cur.trim() : undefined;
}

function releaseFromExpoConfig(config: unknown, platform: string): string {
  const [idKey, buildKey] = platform === "ios" ? ["bundleIdentifier", "buildNumber"] : ["package", "versionCode"];
  const id = field(config, platform, idKey!);
  const version = field(config, "version");
  const build = field(config, platform, buildKey!);
  const missing = [
    id ? null : `${platform}.${idKey}`,
    version ? null : "version",
    build ? null : `${platform}.${buildKey}`,
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    throw new UsageError(
      `cannot compute the ${platform} release: the Expo config has no ${missing.join(", ")}; pass --release-${platform} with the release the SDK sends`,
    );
  }
  return `${id}@${version}+${build}`;
}

async function expoUploadUpdate(args: string[], io: Io): Promise<number> {
  const { values, positionals } = guard(() =>
    parseArgs({
      args,
      options: {
        ...TARGET_OPTIONS,
        "update-json": { type: "string" },
        "release-ios": { type: "string" },
        "release-android": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }),
  );
  if (values.help) {
    io.stdout(EXPO_UPLOAD_UPDATE_HELP);
    return 0;
  }
  const updateJson = required(values["update-json"], "update-json");
  if (positionals.length > 1) throw new UsageError("expected at most one dist directory");
  const distDir = positionals[0] ?? "dist";
  const target = resolveTarget(values, io.env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(updateJson, "utf8"));
  } catch (err) {
    throw new UsageError(`cannot read ${updateJson}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const updates = readUpdates(parsed, updateJson);

  const flags: Record<string, string | undefined> = { ios: values["release-ios"], android: values["release-android"] };
  let config: unknown;
  const jobs: Job[] = [];
  for (const [platform, updateId] of updates) {
    const { map } = await findExportedBundle(distDir, platform);
    let release = flags[platform]?.trim();
    if (!release) {
      config ??= await (io.expoConfig ?? npxExpoConfig)();
      release = releaseFromExpoConfig(config, platform);
    }
    jobs.push(mapIndexJob(map, EXPO_BUNDLE_KEYS[platform]!, { release, dist: updateId }));
  }
  return runJobs(jobs, target, io);
}
