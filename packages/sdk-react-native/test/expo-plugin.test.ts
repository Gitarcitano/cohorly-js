import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: CommonJS plugin module, untyped.
const plugin: any = require("../app.plugin.cjs");

const fixture = (name: string) => readFileSync(new URL(`./fixtures/expo/${name}`, import.meta.url), "utf8");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const props = { projectToken: "tok_123", apiHost: "https://ingest.example.com/" };

describe("config plugin props", () => {
  it("requires projectToken and apiHost, with no default host", () => {
    expect(() => plugin.validateProps(undefined)).toThrow(/projectToken/);
    expect(() => plugin.validateProps({ apiHost: "https://ingest.example.com" })).toThrow(/projectToken/);
    expect(() => plugin.validateProps({ projectToken: "tok_123" })).toThrow(/apiHost/);
    expect(() => plugin.validateProps({ projectToken: "tok_123", apiHost: "ingest.example.com" })).toThrow(/apiHost/);
    expect(() => plugin({}, { projectToken: "tok_123" })).toThrow(/apiHost/);
  });

  it("trims the trailing slash of the host", () => {
    expect(plugin.validateProps(props)).toEqual({ projectToken: "tok_123", apiHost: "https://ingest.example.com", androidAnrWatchdog: false });
  });
});

describe("Info.plist", () => {
  it("writes the token and the host", () => {
    const plist = plugin.applyInfoPlist({ CFBundleName: "Shop" }, plugin.validateProps(props));
    expect(plist).toEqual({
      CFBundleName: "Shop",
      CohorlyProjectToken: "tok_123",
      CohorlyApiHost: "https://ingest.example.com",
    });
  });
});

describe("AppDelegate.swift (Expo SDK 58)", () => {
  it("imports the pod and starts the reporter first thing in didFinishLaunching", () => {
    const out = plugin.applyAppDelegateSwift(fixture("AppDelegate.swift"));
    expect(out).toContain("import ReactAppDependencyProvider\nimport CohorlyReactNative\n");
    expect(out).toContain(
      ") -> Bool {\n    CohorlyNativeCrashes.start()\n    let delegate = ReactNativeDelegate()",
    );
    // Not in the other application(...) overloads.
    expect(count(out, "CohorlyNativeCrashes.start()")).toBe(1);
  });

  it("is idempotent", () => {
    const once = plugin.applyAppDelegateSwift(fixture("AppDelegate.swift"));
    expect(plugin.applyAppDelegateSwift(once)).toBe(once);
    expect(count(once, "import CohorlyReactNative")).toBe(1);
  });

  it("forwards background URLSession events to the reporter, then to ExpoAppDelegate", () => {
    const out = plugin.applyAppDelegateSwift(fixture("AppDelegate.swift"));
    expect(out).toContain(
      "  public override func application(\n    _ application: UIApplication,\n    handleEventsForBackgroundURLSession identifier: String,\n    completionHandler: @escaping () -> Void\n  ) {\n    if CohorlyNativeCrashes.handleEventsForBackgroundURLSession(identifier, completionHandler: completionHandler) { return }\n    super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler)\n  }\n\n  public override func application(\n    _ application: UIApplication,\n    didFinishLaunchingWithOptions",
    );
    expect(count(out, "handleEventsForBackgroundURLSession(identifier")).toBe(1);
  });

  it("adds the forward to an existing background session handler instead of a second one", () => {
    const existing = fixture("AppDelegate.swift").replace(
      "  // Linking API",
      "  public override func application(_ app: UIApplication, handleEventsForBackgroundURLSession sessionId: String, completionHandler done: @escaping () -> Void) {\n    super.application(app, handleEventsForBackgroundURLSession: sessionId, completionHandler: done)\n  }\n\n  // Linking API",
    );
    const out = plugin.applyAppDelegateSwift(existing);
    expect(out).toContain(
      "completionHandler done: @escaping () -> Void) {\n    if CohorlyNativeCrashes.handleEventsForBackgroundURLSession(sessionId, completionHandler: done) { return }\n    super.application(app,",
    );
    expect(count(out, "handleEventsForBackgroundURLSession sessionId")).toBe(1);
    expect(count(out, "handleEventsForBackgroundURLSession identifier")).toBe(0);
  });

  it("does not call super outside ExpoAppDelegate", () => {
    const plain =
      "import UIKit\n\nclass AppDelegate: UIResponder, UIApplicationDelegate {\n  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {\n    return true\n  }\n}\n";
    const out = plugin.applyAppDelegateSwift(plain);
    expect(out).toContain("  func application(\n    _ application: UIApplication,\n    handleEventsForBackgroundURLSession");
    expect(out).not.toContain("override");
    expect(out).not.toContain("super.application(application, handleEventsForBackgroundURLSession");
    expect(out).toContain("{ return }\n    completionHandler()\n  }");
  });

  it("throws on an AppDelegate it does not recognise", () => {
    expect(() => plugin.applyAppDelegateSwift("import UIKit\nclass AppDelegate {}\n")).toThrow(
      /didFinishLaunchingWithOptions/,
    );
  });
});

describe("AppDelegate.mm (Objective-C)", () => {
  it("imports the Swift header and starts the reporter first thing", () => {
    const out = plugin.applyAppDelegateObjc(fixture("AppDelegate.mm"));
    expect(out).toContain(
      "#import <React/RCTLinkingManager.h>\n#import <CohorlyReactNative/CohorlyReactNative-Swift.h>\n",
    );
    expect(out).toContain('launchOptions\n{\n  [CohorlyNativeCrashes start];\n  self.moduleName = @"main";');
    expect(count(out, "[CohorlyNativeCrashes start];")).toBe(1);
  });

  it("is idempotent", () => {
    const once = plugin.applyAppDelegateObjc(fixture("AppDelegate.mm"));
    expect(plugin.applyAppDelegateObjc(once)).toBe(once);
  });

  it("forwards background URLSession events to the reporter, then to super when it implements them", () => {
    const out = plugin.applyAppDelegateObjc(fixture("AppDelegate.mm"));
    expect(out).toContain(
      "- (void)application:(UIApplication *)application handleEventsForBackgroundURLSession:(NSString *)identifier completionHandler:(void (^)(void))completionHandler\n{\n  if ([CohorlyNativeCrashes handleEventsForBackgroundURLSession:identifier completionHandler:completionHandler]) { return; }\n  if ([[AppDelegate superclass] instancesRespondToSelector:_cmd]) {",
    );
    expect(out.indexOf("handleEventsForBackgroundURLSession:(NSString")).toBeLessThan(out.indexOf("didFinishLaunchingWithOptions"));
  });

  it("adds the forward to an existing background session handler", () => {
    const existing = fixture("AppDelegate.mm").replace(
      "// Linking API",
      "- (void)application:(UIApplication *)app handleEventsForBackgroundURLSession:(NSString *)sid completionHandler:(void (^)(void))done {\n  done();\n}\n\n// Linking API",
    );
    const out = plugin.applyAppDelegateObjc(existing);
    expect(out).toContain(
      "completionHandler:(void (^)(void))done {\n  if ([CohorlyNativeCrashes handleEventsForBackgroundURLSession:sid completionHandler:done]) { return; }\n  done();",
    );
    expect(count(out, "handleEventsForBackgroundURLSession:(NSString")).toBe(1);
  });

  it("throws on an AppDelegate it does not recognise", () => {
    expect(() => plugin.applyAppDelegateObjc('#import "AppDelegate.h"\n@implementation AppDelegate\n@end\n')).toThrow(
      /didFinishLaunchingWithOptions/,
    );
  });
});

describe("applyAppDelegate", () => {
  it("picks the transformation from the language", () => {
    expect(plugin.applyAppDelegate(fixture("AppDelegate.swift"), "swift")).toContain("CohorlyNativeCrashes.start()");
    expect(plugin.applyAppDelegate(fixture("AppDelegate.mm"), "objcpp")).toContain("[CohorlyNativeCrashes start];");
    expect(plugin.applyAppDelegate(fixture("AppDelegate.mm"), "objc")).toContain("[CohorlyNativeCrashes start];");
    expect(() => plugin.applyAppDelegate("", "kotlin")).toThrow(/unsupported/);
  });
});

describe("withCohorly", () => {
  // Stand-in for @expo/config-plugins: runs each mod right away on fixture results.
  function fakePlugins(language: "swift" | "objcpp", contents: string) {
    const results: { plist?: Record<string, unknown>; appDelegate?: string } = {};
    return {
      results,
      api: {
        // biome-ignore lint/suspicious/noExplicitAny: mimics the untyped mod config.
        withInfoPlist(config: any, mod: (cfg: any) => any) {
          results.plist = mod({ ...config, modResults: {} }).modResults;
          return config;
        },
        // biome-ignore lint/suspicious/noExplicitAny: mimics the untyped mod config.
        withAppDelegate(config: any, mod: (cfg: any) => any) {
          results.appDelegate = mod({ ...config, modResults: { contents, language } }).modResults.contents;
          return config;
        },
      },
    };
  }

  it("writes both Info.plist keys and inserts the call once", () => {
    const { api, results } = fakePlugins("swift", fixture("AppDelegate.swift"));
    plugin.withCohorlyIos({ name: "shop" }, plugin.validateProps(props), api);
    expect(results.plist).toEqual({ CohorlyProjectToken: "tok_123", CohorlyApiHost: "https://ingest.example.com" });
    expect(count(results.appDelegate ?? "", "CohorlyNativeCrashes.start()")).toBe(1);
  });

  it("works on an Objective-C++ AppDelegate", () => {
    const { api, results } = fakePlugins("objcpp", fixture("AppDelegate.mm"));
    plugin.withCohorlyIos({ name: "shop" }, plugin.validateProps(props), api);
    expect(count(results.appDelegate ?? "", "[CohorlyNativeCrashes start];")).toBe(1);
  });
});
