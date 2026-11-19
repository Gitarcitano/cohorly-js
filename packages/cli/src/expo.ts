// Expo config plugin (`"plugins": ["@cohorly/cli"]`). On `expo prebuild`:
//   iOS: the "Bundle React Native code and images" phase exports SOURCEMAP_FILE,
//        and a new "Upload symbols to Cohorly" phase runs `cohorly react-native xcode`.
//   Android: app/build.gradle applies cohorly.gradle, which runs
//        `cohorly react-native gradle` after every release assemble/bundle.
// The transformations are pure functions so they can be tested on fixtures.

import { createRequire } from "node:module";
import path from "node:path";

export const BUNDLE_PHASE_NAME = "Bundle React Native code and images";
export const UPLOAD_PHASE_NAME = "Upload symbols to Cohorly";

// Declared as inputs (as Crashlytics does) so Xcode schedules the phase after
// ProcessInfoPlistFile and GenerateDSYMFile. A Debug build has no dSYM; a
// missing script input does not fail the build.
export const UPLOAD_PHASE_INPUTS = [
  encodePbxString("$(DWARF_DSYM_FOLDER_PATH)/$(DWARF_DSYM_FILE_NAME)/Contents/Resources/DWARF/$(TARGET_NAME)"),
  encodePbxString("$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"),
];
export const SOURCEMAP_MARKER = "# @cohorly/cli: keep the composed source map for the upload phase";
export const SOURCEMAP_EXPORT = 'export SOURCEMAP_FILE="${SOURCEMAP_FILE:-$DERIVED_FILE_DIR/main.jsbundle.map}"';
export const GRADLE_APPLY =
  'apply from: new File(["node", "--print", "require.resolve(\'@cohorly/cli/package.json\')"].execute(null, rootDir).text.trim(), "../cohorly.gradle")';

export function xcodeUploadScript(): string {
  return [
    "set -e",
    'if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then',
    '  source "$PODS_ROOT/../.xcode.env"',
    "fi",
    'if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then',
    '  source "$PODS_ROOT/../.xcode.env.local"',
    "fi",
    'NODE_BINARY="${NODE_BINARY:-node}"',
    `COHORLY_CLI="$("$NODE_BINARY" --print "require('path').join(require('path').dirname(require.resolve('@cohorly/cli/package.json')), 'dist', 'bin.js')")"`,
    '"$NODE_BINARY" "$COHORLY_CLI" react-native xcode',
    "",
  ].join("\n");
}

/** Decodes a pbxproj string value as the `xcode` package keeps it (quoted, escapes raw). */
export function decodePbxString(value: unknown): string {
  if (typeof value !== "string") return "";
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  return value.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

export function encodePbxString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

type PbxObject = Record<string, unknown>;
type PbxSection = Record<string, PbxObject | string>;

/** The part of the `xcode` package's PBXProject the plugin touches. */
export interface XcodeProjectLike {
  hash: { project: { objects: Record<string, PbxSection | undefined> } };
  generateUuid(): string;
}

function entries(section: PbxSection | undefined): Array<[string, PbxObject]> {
  if (!section) return [];
  return Object.entries(section).filter((e): e is [string, PbxObject] => !e[0].endsWith("_comment") && typeof e[1] === "object");
}

/**
 * Adds the SOURCEMAP_FILE export to every "Bundle React Native code and
 * images" phase and an "Upload symbols to Cohorly" phase right after it in
 * each target that runs it. Idempotent. Throws when there is no bundle phase.
 */
export function applyCohorlyXcode<P extends XcodeProjectLike>(project: P): P {
  const objects = project.hash.project.objects;
  objects.PBXShellScriptBuildPhase ??= {};
  const phases = objects.PBXShellScriptBuildPhase;
  const bundlePhases = entries(phases).filter(([, phase]) => decodePbxString(phase.name) === BUNDLE_PHASE_NAME);
  if (bundlePhases.length === 0) {
    throw new Error(`cohorly: the Xcode project has no "${BUNDLE_PHASE_NAME}" build phase; is this a React Native app?`);
  }
  for (const [bundleId, phase] of bundlePhases) {
    const script = decodePbxString(phase.shellScript);
    if (!script.includes(SOURCEMAP_MARKER)) {
      phase.shellScript = encodePbxString(`${SOURCEMAP_MARKER}\n${SOURCEMAP_EXPORT}\n${script}`);
    }
    for (const [, target] of entries(objects.PBXNativeTarget)) {
      const buildPhases = target.buildPhases as Array<{ value: string; comment?: string }> | undefined;
      if (!Array.isArray(buildPhases)) continue;
      const at = buildPhases.findIndex((p) => p.value === bundleId);
      if (at < 0) continue;
      const existing = buildPhases
        .map((p) => phases[p.value])
        .find((other): other is PbxObject => typeof other === "object" && decodePbxString(other.name) === UPLOAD_PHASE_NAME);
      if (existing) {
        existing.inputPaths = [...UPLOAD_PHASE_INPUTS];
        existing.shellScript = encodePbxString(xcodeUploadScript());
        continue;
      }
      const uuid = project.generateUuid();
      phases[uuid] = {
        isa: "PBXShellScriptBuildPhase",
        buildActionMask: 2147483647,
        files: [],
        inputFileListPaths: [],
        inputPaths: [...UPLOAD_PHASE_INPUTS],
        name: encodePbxString(UPLOAD_PHASE_NAME),
        outputFileListPaths: [],
        outputPaths: [],
        runOnlyForDeploymentPostprocessing: 0,
        shellPath: "/bin/sh",
        shellScript: encodePbxString(xcodeUploadScript()),
      };
      phases[`${uuid}_comment`] = UPLOAD_PHASE_NAME;
      buildPhases.splice(at + 1, 0, { value: uuid, comment: UPLOAD_PHASE_NAME });
    }
  }
  return project;
}

/** Appends the `apply from:` line for cohorly.gradle to android/app/build.gradle. Idempotent. */
export function applyCohorlyGradle(contents: string): string {
  if (contents.includes("@cohorly/cli/package.json")) return contents;
  return `${contents.replace(/\s*$/, "")}\n\n// @cohorly/cli: upload the JS source map and R8 mapping of release variants\n${GRADLE_APPLY}\n`;
}

interface ModConfig<T> {
  modResults: T;
  [key: string]: unknown;
}

type Mod<T> = (config: ModConfig<T>) => ModConfig<T> | Promise<ModConfig<T>>;

interface ConfigPluginsApi {
  withXcodeProject<C>(config: C, action: Mod<XcodeProjectLike>): C;
  withAppBuildGradle<C>(config: C, action: Mod<{ contents: string; language: string }>): C;
}

function loadConfigPlugins(): ConfigPluginsApi {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  for (const name of ["expo/config-plugins", "@expo/config-plugins"]) {
    let resolved: string | null;
    try {
      resolved = req.resolve(name);
    } catch {
      resolved = null;
    }
    if (resolved) return req(resolved) as ConfigPluginsApi;
  }
  throw new Error("cohorly: @expo/config-plugins was not found; this plugin runs inside `npx expo prebuild`");
}

export default function withCohorly<C>(config: C): C {
  const plugins = loadConfigPlugins();
  const withIos = plugins.withXcodeProject(config, (cfg) => {
    applyCohorlyXcode(cfg.modResults);
    return cfg;
  });
  return plugins.withAppBuildGradle(withIos, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("cohorly: android/app/build.gradle.kts is not supported; apply @cohorly/cli/cohorly.gradle from a Groovy build.gradle");
    }
    cfg.modResults.contents = applyCohorlyGradle(cfg.modResults.contents);
    return cfg;
  });
}
