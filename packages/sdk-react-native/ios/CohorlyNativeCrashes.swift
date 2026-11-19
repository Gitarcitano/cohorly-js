import Foundation

/// Native crash reporting for React Native apps (ADR-0020). The core under
/// ios/CohorlyCrash/ is a copy of sdks/ios/Sources/CohorlyCrash/Core.
///
/// `start()` runs first thing in `application(_:didFinishLaunchingWithOptions:)`
/// (inserted by the `@cohorly/react-native` config plugin), before JS exists.
/// It installs KSCrash only when the config the JS layer wrote on the
/// previous launch (`cohorly.crash.config`) says `enabled: true`; with
/// `enabled: false, metricKit: true` it only sends pending reports and
/// subscribes to MetricKit (no handler installed); with both off it deletes
/// pending reports. Token and host come from the Info.plist keys
/// `CohorlyProjectToken` / `CohorlyApiHost`.
@objc(CohorlyNativeCrashes)
public final class CohorlyNativeCrashes: NSObject {
    /// `$lib_version` of crash events; mirrors package.json (scripts/sync-versions.mjs).
    static let libVersion = "1.5.1"
    static let lib = CrashLibInfo(lib: "react-native", version: libVersion)

    @objc public static func start() {
        CrashReporter.shared.startFromStoredConfig(lib: lib)
    }

    /// Forward `application(_:handleEventsForBackgroundURLSession:completionHandler:)`
    /// here; false means the session is not the reporter's.
    @objc public static func handleEventsForBackgroundURLSession(
        _ identifier: String,
        completionHandler: @escaping () -> Void
    ) -> Bool {
        CrashReporter.shared.handleEventsForBackgroundURLSession(identifier, completionHandler: completionHandler)
    }

    /// Stores the JS-written config for the next launch and, when KSCrash
    /// runs in this process, applies its identity and dist right away so a
    /// crash later in this launch carries them. Never installs or removes
    /// anything: a MetricKit-only process that receives `enabled: true`
    /// installs KSCrash on the next launch, not in this one.
    static func configure(json: String, defaults: UserDefaults = .standard, bundle: Bundle = .main) {
        defaults.set(json, forKey: CrashConfig.defaultsKey)
        guard CrashReporter.shared.isInstalled, let config = CrashConfig.parse(json) else { return }
        let info = bundle.infoDictionary ?? [:]
        let release = CrashRelease.fromInfoDictionary(info)
        let build = info["CFBundleVersion"] as? String
        CrashReporter.shared.updateUserInfo(config.userInfo(binaryRelease: release, binaryBuild: build))
    }
}
