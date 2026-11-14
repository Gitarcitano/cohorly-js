// Expo config plugin for @cohorly/react-native native crash reporting
// (ADR-0020): `"plugins": [["@cohorly/react-native", { projectToken, apiHost }]]`.
// CommonJS, because Expo loads it with require().
//
// It writes where the native startup hooks read their send target, so a crash
// before the JS bundle loads can still be sent. Turning reporting on or off is
// NOT done here: that is runtime config the JS layer writes for the next launch.
//
// Android: <application> meta-data com.cohorly.PROJECT_TOKEN, com.cohorly.API_HOST
// and, with `androidAnrWatchdog: true`, com.cohorly.ANR_WATCHDOG. The crash
// provider itself is registered by the SDK's own manifest; no step here.
//
// iOS (VEL-1769): writes CohorlyProjectToken / CohorlyApiHost into Info.plist
// and calls `CohorlyNativeCrashes.start()` first thing in the AppDelegate's
// application(_:didFinishLaunchingWithOptions:), so a crash before the JS
// bundle loads is still recorded and the reports of earlier launches are sent
// without JS. Whether the reporter actually installs is decided at runtime by
// the `nativeCrashReporting` option of init(), written on the previous launch.

const ANDROID_TOKEN = "com.cohorly.PROJECT_TOKEN";
const ANDROID_HOST = "com.cohorly.API_HOST";
const ANDROID_ANR_WATCHDOG = "com.cohorly.ANR_WATCHDOG";

/** Throws on invalid props; returns them normalized (no trailing slash on apiHost). */
function validateProps(props) {
  const p = props || {};
  if (typeof p.projectToken !== "string" || p.projectToken.trim() === "") {
    throw new Error("@cohorly/react-native: the `projectToken` plugin prop is required");
  }
  if (typeof p.apiHost !== "string" || !/^https?:\/\/[^/\s]+(\/\S*)?$/.test(p.apiHost)) {
    throw new Error("@cohorly/react-native: the `apiHost` plugin prop must be an http(s) URL, e.g. https://api.example.com");
  }
  if (p.androidAnrWatchdog !== undefined && typeof p.androidAnrWatchdog !== "boolean") {
    throw new Error("@cohorly/react-native: the `androidAnrWatchdog` plugin prop must be a boolean");
  }
  return {
    projectToken: p.projectToken.trim(),
    apiHost: p.apiHost.replace(/\/+$/, ""),
    androidAnrWatchdog: p.androidAnrWatchdog === true,
  };
}

/** Pure: insert or update one meta-data entry, never duplicating it. */
function upsertMetaData(application, name, value) {
  const entries = application["meta-data"] || [];
  application["meta-data"] = entries;
  const matching = entries.filter((m) => m?.$?.["android:name"] === name);
  if (matching.length === 0) {
    entries.push({ $: { "android:name": name, "android:value": value } });
    return;
  }
  matching[0].$["android:value"] = value;
  // Earlier runs (or a hand edit) may have left duplicates: keep one.
  application["meta-data"] = entries.filter((m) => !matching.includes(m) || m === matching[0]);
}

/** Pure: remove a meta-data entry when present. */
function removeMetaData(application, name) {
  if (!application["meta-data"]) return;
  application["meta-data"] = application["meta-data"].filter((m) => m?.$?.["android:name"] !== name);
}

/** Pure: apply the props to an xml2js AndroidManifest (Expo's modResults). */
function applyAndroidManifest(androidManifest, props) {
  const application = androidManifest?.manifest?.application?.[0];
  if (!application) throw new Error("@cohorly/react-native: AndroidManifest.xml has no <application>");
  upsertMetaData(application, ANDROID_TOKEN, props.projectToken);
  upsertMetaData(application, ANDROID_HOST, props.apiHost);
  if (props.androidAnrWatchdog) upsertMetaData(application, ANDROID_ANR_WATCHDOG, "true");
  else removeMetaData(application, ANDROID_ANR_WATCHDOG);
  return androidManifest;
}

function withCohorlyAndroid(config, rawProps) {
  const props = validateProps(rawProps);
  // Lazy, so the pure functions above load without @expo/config-plugins installed.
  const { withAndroidManifest } = require("@expo/config-plugins");
  return withAndroidManifest(config, (c) => {
    applyAndroidManifest(c.modResults, props);
    return c;
  });
}

const { createRequire } = require("node:module");
const path = require("node:path");

const PLUGIN = "@cohorly/react-native";
const IOS_TOKEN_KEY = "CohorlyProjectToken";
const IOS_HOST_KEY = "CohorlyApiHost";
const SWIFT_IMPORT = "import CohorlyReactNative";
const SWIFT_CALL = "CohorlyNativeCrashes.start()";
const OBJC_IMPORT = "#import <CohorlyReactNative/CohorlyReactNative-Swift.h>";
const OBJC_CALL = "[CohorlyNativeCrashes start];";
// The reporter sends through a background URLSession with launch events on:
// when nsurlsessiond relaunches the app to deliver completions, the
// AppDelegate must hand the completion handler to the reporter, or the files
// of delivered reports are only cleaned up on the next user launch and the
// system is never told the app finished.
const SWIFT_BG_FORWARD = "CohorlyNativeCrashes.handleEventsForBackgroundURLSession(";
const OBJC_BG_FORWARD = "[CohorlyNativeCrashes handleEventsForBackgroundURLSession:";

/**
 * @param {Record<string, unknown>} plist
 * @param {{ projectToken: string, apiHost: string }} props
 */
function applyInfoPlist(plist, props) {
  plist[IOS_TOKEN_KEY] = props.projectToken;
  plist[IOS_HOST_KEY] = props.apiHost;
  return plist;
}

/** Inserts `line` after the last line matching `importLine`, or at the top. */
function addImport(contents, line, importLine) {
  if (contents.includes(line)) return contents;
  const lines = contents.split("\n");
  let last = -1;
  lines.forEach((l, i) => {
    if (importLine.test(l)) last = i;
  });
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
}

/** Inserts `statement` as the first line of the body opened at `openBrace`. */
function addFirstStatement(contents, openBraceEnd, statement) {
  const rest = contents.slice(openBraceEnd);
  const indent = (/^\n([ \t]+)\S/.exec(rest) || [])[1] || "  ";
  return `${contents.slice(0, openBraceEnd)}\n${indent}${statement}${rest}`;
}

/** Start index of the line holding `index`. */
function lineStart(contents, index) {
  return contents.lastIndexOf("\n", index - 1) + 1;
}

/**
 * Forwards background URLSession events to the reporter: as the first
 * statement of an existing handler, or as a new handler placed right before
 * didFinishLaunching (calling super when the class extends ExpoAppDelegate,
 * which implements it).
 */
function addSwiftBackgroundForward(contents, launchIndex) {
  if (contents.includes(SWIFT_BG_FORWARD)) return contents;
  const existing =
    /func\s+application\s*\(\s*_\s+\w+\s*:\s*UIApplication\s*,\s*handleEventsForBackgroundURLSession\s+(\w+)\s*:\s*String\s*,\s*completionHandler\s+(?:(\w+)\s*)?:[^{]*\{/.exec(
      contents,
    );
  if (existing) {
    const id = existing[1];
    const done = existing[2] || "completionHandler";
    return addFirstStatement(
      contents,
      existing.index + existing[0].length,
      `if ${SWIFT_BG_FORWARD}${id}, completionHandler: ${done}) { return }`,
    );
  }
  const at = lineStart(contents, launchIndex);
  const indent = (/^[ \t]*/.exec(contents.slice(at)) || [""])[0];
  const expo = /class\s+\w+\s*:\s*ExpoAppDelegate\b/.test(contents);
  const i2 = indent + "  ";
  const method = [
    `${indent}${expo ? "public override " : ""}func application(`,
    `${i2}_ application: UIApplication,`,
    `${i2}handleEventsForBackgroundURLSession identifier: String,`,
    `${i2}completionHandler: @escaping () -> Void`,
    `${indent}) {`,
    `${i2}if ${SWIFT_BG_FORWARD}identifier, completionHandler: completionHandler) { return }`,
    expo
      ? `${i2}super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler)`
      : `${i2}completionHandler()`,
    `${indent}}`,
    "",
    "",
  ].join("\n");
  return contents.slice(0, at) + method + contents.slice(at);
}

/** Objective-C counterpart of addSwiftBackgroundForward. */
function addObjcBackgroundForward(contents, launchIndex) {
  if (contents.includes(OBJC_BG_FORWARD)) return contents;
  const existing =
    /-\s*\(void\)\s*application:\s*\(UIApplication\s*\*\s*\)\s*\w+\s+handleEventsForBackgroundURLSession:\s*\(NSString\s*\*\s*\)\s*(\w+)\s+completionHandler:\s*\(void\s*\(\^\)\s*\(void\)\)\s*(\w+)\s*\{/.exec(
      contents,
    );
  if (existing) {
    return addFirstStatement(
      contents,
      existing.index + existing[0].length,
      `if (${OBJC_BG_FORWARD}${existing[1]} completionHandler:${existing[2]}]) { return; }`,
    );
  }
  const cls = (/@implementation\s+(\w+)/.exec(contents) || [])[1] || "AppDelegate";
  const at = lineStart(contents, launchIndex);
  const method = [
    "- (void)application:(UIApplication *)application handleEventsForBackgroundURLSession:(NSString *)identifier completionHandler:(void (^)(void))completionHandler",
    "{",
    `  if (${OBJC_BG_FORWARD}identifier completionHandler:completionHandler]) { return; }`,
    `  if ([[${cls} superclass] instancesRespondToSelector:_cmd]) {`,
    "    [super application:application handleEventsForBackgroundURLSession:identifier completionHandler:completionHandler];",
    "  } else {",
    "    completionHandler();",
    "  }",
    "}",
    "",
    "",
  ].join("\n");
  return contents.slice(0, at) + method + contents.slice(at);
}

/**
 * AppDelegate.swift (Expo SDK 53+ template, `ExpoAppDelegate`).
 * @param {string} contents
 */
const SWIFT_LAUNCH =
  /func\s+application\s*\(\s*_\s+\w+\s*:\s*UIApplication\s*,\s*didFinishLaunchingWithOptions\b[^{]*\{/;
const OBJC_LAUNCH =
  /-\s*\(BOOL\)\s*application:\s*\(UIApplication\s*\*\s*\)\s*\w+\s+didFinishLaunchingWithOptions:\s*\(NSDictionary[^)]*\)\s*\w+\s*\{/;

function applyAppDelegateSwift(contents) {
  let out = contents;
  if (!out.includes(SWIFT_CALL)) {
    const match = SWIFT_LAUNCH.exec(out);
    if (!match) {
      throw new Error(
        `${PLUGIN}: could not find application(_:didFinishLaunchingWithOptions:) in AppDelegate.swift. Add \`${SWIFT_IMPORT}\` and call \`${SWIFT_CALL}\` as its first line by hand, or remove the plugin.`,
      );
    }
    out = addFirstStatement(out, match.index + match[0].length, SWIFT_CALL);
  }
  const launch = SWIFT_LAUNCH.exec(out);
  if (launch) out = addSwiftBackgroundForward(out, launch.index);
  return addImport(out, SWIFT_IMPORT, /^\s*(?:(?:public|internal|package|private|fileprivate|@\w+)\s+)*import\s+\w+/);
}

/**
 * AppDelegate.m / AppDelegate.mm (pre-SDK 53 template, `EXAppDelegateWrapper`).
 * @param {string} contents
 */
function applyAppDelegateObjc(contents) {
  let out = contents;
  if (!out.includes(OBJC_CALL)) {
    const match = OBJC_LAUNCH.exec(out);
    if (!match) {
      throw new Error(
        `${PLUGIN}: could not find application:didFinishLaunchingWithOptions: in the AppDelegate. Add \`${OBJC_IMPORT}\` and call \`${OBJC_CALL}\` as its first line by hand, or remove the plugin.`,
      );
    }
    out = addFirstStatement(out, match.index + match[0].length, OBJC_CALL);
  }
  const launch = OBJC_LAUNCH.exec(out);
  if (launch) out = addObjcBackgroundForward(out, launch.index);
  return addImport(out, OBJC_IMPORT, /^\s*#import\s+/);
}

/**
 * @param {string} contents
 * @param {string} language `withAppDelegate`'s `modResults.language`
 */
function applyAppDelegate(contents, language) {
  if (language === "swift") return applyAppDelegateSwift(contents);
  if (language === "objc" || language === "objcpp") return applyAppDelegateObjc(contents);
  throw new Error(`${PLUGIN}: unsupported AppDelegate language "${language}"`);
}

function loadConfigPlugins() {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  for (const name of ["expo/config-plugins", "@expo/config-plugins"]) {
    let resolved = null;
    try {
      resolved = req.resolve(name);
    } catch {
      resolved = null;
    }
    if (resolved) return req(resolved);
  }
  throw new Error(`${PLUGIN}: @expo/config-plugins was not found; this plugin runs inside \`npx expo prebuild\``);
}

function withCohorlyIos(config, props, plugins = loadConfigPlugins()) {
  const withPlist = plugins.withInfoPlist(config, (cfg) => {
    applyInfoPlist(cfg.modResults, props);
    return cfg;
  });
  return plugins.withAppDelegate(withPlist, (cfg) => {
    cfg.modResults.contents = applyAppDelegate(cfg.modResults.contents, cfg.modResults.language);
    return cfg;
  });
}

function withCohorly(config, rawProps) {
  const props = validateProps(rawProps);
  return withCohorlyIos(withCohorlyAndroid(config, props), props);
}

module.exports = withCohorly;
module.exports.default = withCohorly;
module.exports.withCohorlyAndroid = withCohorlyAndroid;
module.exports.withCohorlyIos = withCohorlyIos;
module.exports.applyAndroidManifest = applyAndroidManifest;
module.exports.upsertMetaData = upsertMetaData;
module.exports.validateProps = validateProps;
module.exports.applyInfoPlist = applyInfoPlist;
module.exports.applyAppDelegate = applyAppDelegate;
module.exports.applyAppDelegateSwift = applyAppDelegateSwift;
module.exports.applyAppDelegateObjc = applyAppDelegateObjc;
module.exports.IOS_TOKEN_KEY = IOS_TOKEN_KEY;
module.exports.IOS_HOST_KEY = IOS_HOST_KEY;
