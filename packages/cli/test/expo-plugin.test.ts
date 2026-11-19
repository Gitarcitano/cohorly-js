import { spawnSync } from "node:child_process";
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyCohorlyGradle,
  applyCohorlyXcode,
  BUNDLE_PHASE_NAME,
  decodePbxString,
  GRADLE_APPLY,
  SOURCEMAP_EXPORT,
  SOURCEMAP_MARKER,
  UPLOAD_PHASE_NAME,
  type XcodeProjectLike,
  xcodeUploadScript,
} from "../src/expo.js";
import { tempDir, writeFiles } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/expo/", import.meta.url));
const CLI_ROOT = fileURLToPath(new URL("../", import.meta.url));

// `xcode` is what @expo/config-plugins parses project.pbxproj with.
const requireFromPlugins = createRequire(createRequire(import.meta.url).resolve("@expo/config-plugins"));
const xcode = requireFromPlugins("xcode") as {
  project(file: string): XcodeProjectLike & { parseSync(): XcodeProjectLike; writeSync(): string };
};

async function parsedFixture() {
  const dir = await tempDir();
  const file = path.join(dir, "project.pbxproj");
  await copyFile(path.join(FIXTURES, "project.pbxproj"), file);
  const project = xcode.project(file);
  project.parseSync();
  return { dir, file, project };
}

type Phase = Record<string, unknown>;

function shellPhases(project: XcodeProjectLike): Array<[string, Phase]> {
  return Object.entries(project.hash.project.objects.PBXShellScriptBuildPhase ?? {}).filter(
    (e): e is [string, Phase] => !e[0].endsWith("_comment") && typeof e[1] === "object",
  );
}

function targetPhaseNames(project: XcodeProjectLike): string[] {
  const target = Object.entries(project.hash.project.objects.PBXNativeTarget ?? {}).find(([k]) => !k.endsWith("_comment"))![1] as Phase;
  return (target.buildPhases as Array<{ comment: string }>).map((p) => p.comment);
}

describe("Expo plugin entry", () => {
  it("loads with require() where Node cannot require ESM (Node 20, Node 22 before 22.12)", async () => {
    const pkg = JSON.parse(await readFile(path.join(CLI_ROOT, "package.json"), "utf8")) as { exports: Record<string, unknown>; files: string[] };
    expect(pkg.exports["./app.plugin"]).toBe("./app.plugin.cjs");
    expect(pkg.exports["./app.plugin.js"]).toBe("./app.plugin.cjs");
    expect(pkg.exports["./app.plugin.cjs"]).toBe("./app.plugin.cjs");
    expect(pkg.files).toContain("app.plugin.cjs");

    const dir = await tempDir();
    const tsc = spawnSync(path.join(CLI_ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.cjs.json", "--outDir", path.join(dir, "dist/cjs")], {
      cwd: CLI_ROOT,
      encoding: "utf8",
    });
    expect(tsc.stdout + tsc.stderr).toBe("");
    await writeFile(path.join(dir, "dist/cjs/package.json"), '{"type":"commonjs"}\n');
    await copyFile(path.join(CLI_ROOT, "app.plugin.cjs"), path.join(dir, "app.plugin.cjs"));
    const probe = `const p = require(${JSON.stringify(path.join(dir, "app.plugin.cjs"))});
if (typeof p !== "function" || typeof p.applyCohorlyXcode !== "function") process.exit(2);`;
    const run = spawnSync(process.execPath, ["--no-experimental-require-module", "-e", probe], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  }, 60_000);
});

describe("Expo plugin, iOS", () => {
  it("adds the upload phase after the existing phases and the SOURCEMAP_FILE export, once", async () => {
    const { dir, file, project } = await parsedFixture();
    applyCohorlyXcode(project);
    applyCohorlyXcode(project);
    await writeFile(file, project.writeSync());

    const reparsed = xcode.project(file);
    reparsed.parseSync();
    applyCohorlyXcode(reparsed);
    await writeFile(path.join(dir, "again.pbxproj"), reparsed.writeSync());
    expect(await readFile(path.join(dir, "again.pbxproj"), "utf8")).toBe(await readFile(file, "utf8"));

    expect(targetPhaseNames(reparsed)).toEqual([
      "[CP] Check Pods Manifest.lock",
      "Sources",
      BUNDLE_PHASE_NAME,
      "[CP] Copy Pods Resources",
      UPLOAD_PHASE_NAME,
    ]);
    const phases = shellPhases(reparsed);
    const uploads = phases.filter(([, p]) => decodePbxString(p.name) === UPLOAD_PHASE_NAME);
    expect(uploads).toHaveLength(1);
    const upload = uploads[0]![1];
    expect(upload.inputPaths.map(decodePbxString)).toEqual([
      "$(DWARF_DSYM_FOLDER_PATH)/$(DWARF_DSYM_FILE_NAME)/Contents/Resources/DWARF/$(TARGET_NAME)",
      "$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)",
    ]);
    expect(await readFile(path.join(dir, "again.pbxproj"), "utf8")).toContain('"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)",');
    expect(upload.alwaysOutOfDate).toBe(1);
    const script = decodePbxString(upload.shellScript);
    expect(script).toBe(xcodeUploadScript());
    expect(script.startsWith("set -e\n")).toBe(true);
    expect(script).toContain(".xcode.env");
    expect(script).toContain("require.resolve('@cohorly/cli/package.json')");
    expect(script).toContain("react-native xcode");

    const bundle = decodePbxString(phases.find(([, p]) => decodePbxString(p.name) === BUNDLE_PHASE_NAME)![1].shellScript);
    expect(bundle.startsWith(`${SOURCEMAP_MARKER}\n${SOURCEMAP_EXPORT}\nif [[ -f "$PODS_ROOT/../.xcode.env" ]]`)).toBe(true);
    expect(bundle.split(SOURCEMAP_MARKER)).toHaveLength(2);
    expect(bundle).toContain("react-native-xcode.sh");
  });

  // The upload phase reads the dSYM and Info.plist; placed before a phase that
  // still writes into the app bundle, `xcodebuild archive` reports a cycle.
  // Phases `pod install` appends afterwards may follow it, so the contract is
  // "after every phase present when the plugin runs", not "last".
  it("places the upload phase after every phase present when the plugin runs, new or prebuilt by 0.1.1", async () => {
    const fresh = (await parsedFixture()).project;
    const before = targetPhaseNames(fresh);
    expect(before).not.toContain(UPLOAD_PHASE_NAME);
    applyCohorlyXcode(fresh);
    expect(targetPhaseNames(fresh)).toEqual([...before, UPLOAD_PHASE_NAME]);

    // 0.1.1 layout: upload right after the bundle phase, with phases after it
    // that write into the bundle.
    const { project } = await parsedFixture();
    applyCohorlyXcode(project);
    const target = Object.entries(project.hash.project.objects.PBXNativeTarget ?? {}).find(([k]) => !k.endsWith("_comment"))![1] as Phase;
    const buildPhases = target.buildPhases as Array<{ value: string; comment: string }>;
    const upload = buildPhases.splice(buildPhases.findIndex((p) => p.comment === UPLOAD_PHASE_NAME), 1)[0]!;
    buildPhases.splice(buildPhases.findIndex((p) => p.comment === BUNDLE_PHASE_NAME) + 1, 0, upload);
    buildPhases.push({ value: "0000000000000000000000EE", comment: "Embed Watch Content" });
    expect(targetPhaseNames(project)).toEqual([
      "[CP] Check Pods Manifest.lock",
      "Sources",
      BUNDLE_PHASE_NAME,
      UPLOAD_PHASE_NAME,
      "[CP] Copy Pods Resources",
      "Embed Watch Content",
    ]);

    applyCohorlyXcode(project);

    expect(targetPhaseNames(project)).toEqual([
      "[CP] Check Pods Manifest.lock",
      "Sources",
      BUNDLE_PHASE_NAME,
      "[CP] Copy Pods Resources",
      "Embed Watch Content",
      UPLOAD_PHASE_NAME,
    ]);
    const uploads = shellPhases(project).filter(([, p]) => decodePbxString(p.name) === UPLOAD_PHASE_NAME);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]![1].inputPaths.map(decodePbxString)).toEqual([
      "$(DWARF_DSYM_FOLDER_PATH)/$(DWARF_DSYM_FILE_NAME)/Contents/Resources/DWARF/$(TARGET_NAME)",
      "$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)",
    ]);
  });

  it("rewrites an upload phase prebuilt without input files, so it runs after the Info.plist and the dSYM", async () => {
    const { project } = await parsedFixture();
    applyCohorlyXcode(project);
    const [, upload] = shellPhases(project).find(([, p]) => decodePbxString(p.name) === UPLOAD_PHASE_NAME)!;
    upload.inputPaths = [];
    upload.shellScript = '"echo stale"';

    applyCohorlyXcode(project);

    const uploads = shellPhases(project).filter(([, p]) => decodePbxString(p.name) === UPLOAD_PHASE_NAME);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]![1].inputPaths.map(decodePbxString)).toEqual([
      "$(DWARF_DSYM_FOLDER_PATH)/$(DWARF_DSYM_FILE_NAME)/Contents/Resources/DWARF/$(TARGET_NAME)",
      "$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)",
    ]);
    expect(decodePbxString(uploads[0]![1].shellScript)).toBe(xcodeUploadScript());
  });

  it("refuses a project without the React Native bundle phase", async () => {
    const { project } = await parsedFixture();
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase!;
    for (const [key, phase] of Object.entries(phases)) {
      if (typeof phase === "object" && decodePbxString(phase.name) === BUNDLE_PHASE_NAME) delete phases[key];
    }
    expect(() => applyCohorlyXcode(project)).toThrow(BUNDLE_PHASE_NAME);
  });

  async function runPhase(fakeExit: number) {
    const dir = await tempDir();
    const fakeNode = path.join(dir, "fake-node");
    const argsLog = path.join(dir, "args.log");
    await writeFiles(dir, {
      "fake-node": [
        "#!/bin/bash",
        'if [ "$1" = "--print" ]; then echo "/fake/@cohorly/cli/dist/bin.js"; exit 0; fi',
        'printf "%s\\n" "$@" > "$ARGS_LOG"',
        'exit "$FAKE_EXIT"',
        "",
      ].join("\n"),
      ".xcode.env": `export NODE_BINARY="${fakeNode}"\n`,
      "Pods/Manifest.lock": "",
      "phase.sh": xcodeUploadScript(),
    });
    await chmod(fakeNode, 0o755);
    const r = spawnSync("bash", [path.join(dir, "phase.sh")], {
      env: { PATH: process.env.PATH, PODS_ROOT: path.join(dir, "Pods"), ARGS_LOG: argsLog, FAKE_EXIT: String(fakeExit) },
    });
    const args = await readFile(argsLog, "utf8").catch(() => "");
    return { status: r.status, args: args.trim().split("\n") };
  }

  it("fails the Xcode build when the upload fails", async () => {
    const failed = await runPhase(1);
    expect(failed.status).not.toBe(0);
    expect(failed.args).toEqual(["/fake/@cohorly/cli/dist/bin.js", "react-native", "xcode"]);

    const ok = await runPhase(0);
    expect(ok.status).toBe(0);
    expect(ok.args).toEqual(["/fake/@cohorly/cli/dist/bin.js", "react-native", "xcode"]);
  });
});

describe("Expo plugin, Android", () => {
  it("applies cohorly.gradle from app/build.gradle once", async () => {
    const original = await readFile(path.join(FIXTURES, "build.gradle"), "utf8");
    const once = applyCohorlyGradle(original);
    expect(once.startsWith(original.trimEnd())).toBe(true);
    expect(once.split(GRADLE_APPLY)).toHaveLength(2);
    expect(applyCohorlyGradle(once)).toBe(once);
    expect(GRADLE_APPLY).toContain("require.resolve('@cohorly/cli/package.json')");
    expect(GRADLE_APPLY).toContain('"../cohorly.gradle"');
  });

  it("registers an upload task per release variant that fails the build on a failed upload", async () => {
    const gradle = await readFile(path.join(CLI_ROOT, "cohorly.gradle"), "utf8");
    expect(gradle).toContain("variant.buildType.debuggable");
    expect(gradle).toContain('tasks.register("uploadCohorlySymbols${suffix}", Exec)');
    expect(gradle).toContain('[cohorlyNode, cohorlyCliBin, "react-native", "gradle", "--sourcemap", sourcemap.absolutePath]');
    expect(gradle).toContain('"${variant.applicationId}@${variant.versionName}+${variant.versionCode}"');
    expect(gradle).toContain('command += ["--release", release]');
    expect(gradle).toContain('"generated/sourcemaps/react/${variantName}/index.android.bundle.map"');
    expect(gradle).toContain('"outputs/mapping/${variantName}/mapping.txt"');
    expect(gradle).toContain('command += ["--mapping", mapping.absolutePath]');
    expect(gradle).toContain('"createBundle${suffix}JsAndAssets"');
    expect(gradle).toContain('"minify${suffix}WithR8"');
    expect(gradle).toContain('"assemble${suffix}"');
    expect(gradle).toContain('"bundle${suffix}"');
    expect(gradle).toContain("finalizedBy(upload)");
    expect(gradle).not.toContain("ignoreExitValue");
  });
});
