import Foundation

// Core of the native crash reporter (ADR-0020). Files under Core/ import only
// Foundation, KSCrash and MetricKit, never `Cohorly`: they are copied byte for
// byte into packages/sdk-react-native/ios/CohorlyCrash/ (`pnpm --filter
// @cohorly/react-native sync:crash`), and a vitest test fails when the copies
// diverge. Edit them here, then run the sync.

/// Crash-time values written into KSCrash's user info before any crash, so a
/// report carries the release and identity of the launch that crashed, never
/// those of the launch that sends it.
struct CrashUserInfo: Equatable {
    static let releaseKey = "release"
    static let distKey = "dist"
    static let distinctIdKey = "distinct_id"
    static let deviceIdKey = "device_id"
    static let userIdKey = "user_id"

    var release: String?
    var dist: String?
    var distinctId: String?
    var deviceId: String?
    var userId: String?

    /// Key/value pairs as written to KSCrash. A nil value removes the key.
    var entries: [(key: String, value: String?)] {
        [
            (Self.releaseKey, release),
            (Self.distKey, dist),
            (Self.distinctIdKey, distinctId),
            (Self.deviceIdKey, deviceId),
            (Self.userIdKey, userId)
        ]
    }
}

/// Where reports are sent: `POST <host>/track` with `X-Cohorly-Token`.
struct CrashEndpoint: Equatable {
    var token: String
    /// Base URL without a trailing slash.
    var host: URL

    init?(token: String?, host: String?) {
        guard let token, !token.isEmpty,
              let raw = host?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty
        else { return nil }
        var trimmed = raw
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host != nil
        else { return nil }
        self.token = token
        self.host = url
    }

    var trackURL: URL { host.appendingPathComponent("track") }
}

/// `$lib` / `$lib_version` stamped on every crash event: the SDK that installed
/// the reporter (`ios` for the Swift SDK, `react-native` for the RN pod).
struct CrashLibInfo: Equatable {
    var lib: String
    var version: String
}

/// The value the React Native layer writes on every launch (and on identify,
/// reset and opt-out) under UserDefaults `cohorly.crash.config`, read by native
/// code on the NEXT launch. Android writes the same JSON shape (VEL-1770):
///
///     { "enabled": bool, "release": string|null, "dist": string|null,
///       "distinctId": string, "deviceId": string, "build": string|null }
///
/// `build` is the build number (CFBundleVersion, Android versionCode) of the
/// launch that wrote the config; Android also accepts it as a number.
///
/// Parsing is tolerant: anything that is not a JSON object with
/// `enabled: true` means "off".
struct CrashConfig: Equatable {
    static let defaultsKey = "cohorly.crash.config"

    var enabled: Bool
    var release: String?
    var dist: String?
    var distinctId: String?
    var deviceId: String?
    var build: String?

    /// nil when `raw` is absent or not a JSON object. Wrong-typed fields are
    /// dropped; a non-boolean `enabled` is `false`.
    static func parse(_ raw: String?) -> CrashConfig? {
        guard let raw, let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any]
        else { return nil }
        func string(_ key: String) -> String? {
            guard let value = dict[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        // JSONSerialization decodes JSON booleans as NSNumber; only a real
        // boolean `true` turns the reporter on (never 1 or "true").
        // `build` is a string from JS and a number when Android stamps it.
        var build = string("build")
        if build == nil, let number = dict["build"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            build = number.stringValue
        }
        let enabled = (dict["enabled"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
        return CrashConfig(
            enabled: enabled,
            release: string("release"),
            dist: string("dist"),
            distinctId: string("distinctId"),
            deviceId: string("deviceId"),
            build: build
        )
    }

    /// Serialized form, used by tests and by native callers that write the key.
    func jsonString() -> String {
        var dict: [String: Any] = ["enabled": enabled]
        dict["release"] = release ?? NSNull()
        dict["dist"] = dist ?? NSNull()
        if let distinctId { dict["distinctId"] = distinctId }
        if let deviceId { dict["deviceId"] = deviceId }
        if let build { dict["build"] = build }
        let data = (try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    /// User info for a launch running the binary whose release is
    /// `binaryRelease` and whose build number is `binaryBuild`. The stored
    /// `dist` (an OTA update id) is only valid for the binary it was recorded
    /// on: when the app was updated since the JS layer wrote it, the stored
    /// release or build differs and the dist is dropped.
    func userInfo(binaryRelease: String?, binaryBuild: String? = nil) -> CrashUserInfo {
        let sameBuild = build == nil || build == binaryBuild
        let distValid = dist != nil && release != nil && release == binaryRelease && sameBuild
        return CrashUserInfo(
            release: binaryRelease,
            dist: distValid ? dist : nil,
            distinctId: distinctId,
            deviceId: deviceId,
            userId: Self.userId(distinctId: distinctId, deviceId: deviceId)
        )
    }

    /// The contract carries no `userId`. In every client SDK an anonymous
    /// identity has distinct id == device id (fresh install and reset() both
    /// mint one uuid for the two), so a distinct id that differs from the
    /// device id is an identified user.
    static func userId(distinctId: String?, deviceId: String?) -> String? {
        guard let distinctId, let deviceId, distinctId != deviceId else { return nil }
        return distinctId
    }
}

/// `<CFBundleIdentifier>@<CFBundleShortVersionString>+<CFBundleVersion>`, the
/// same value `@cohorly/react-native` computes in `src/exceptions/release.ts`
/// and `cohorly debug-files upload --release` must be given. Without a bundle
/// id the prefix is `ios`; without a build there is no `+` part; without a
/// version there is no release (never guessed).
enum CrashRelease {
    static let unknown = "ios@unknown"

    static func fromInfoDictionary(_ info: [String: Any]) -> String? {
        func value(_ key: String) -> String? {
            guard let value = info[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        guard let version = value("CFBundleShortVersionString") else { return nil }
        let base = "\(value("CFBundleIdentifier") ?? "ios")@\(version)"
        guard let build = value("CFBundleVersion") else { return base }
        return "\(base)+\(build)"
    }
}

/// What a launch does with the reporter, decided from the config written by
/// the previous launch and the app's Info.plist. Pure, so it is tested
/// without KSCrash.
enum CrashLaunchDecision: Equatable {
    /// Install KSCrash, send pending reports and subscribe to MetricKit.
    case install(endpoint: CrashEndpoint, userInfo: CrashUserInfo)
    /// Reporting is off: delete pending reports, send nothing, no MetricKit.
    case disable
    /// Reporting is on but the Info.plist lacks `CohorlyProjectToken` or
    /// `CohorlyApiHost`: nothing is installed and pending reports are kept.
    case misconfigured

    static let tokenKey = "CohorlyProjectToken"
    static let hostKey = "CohorlyApiHost"

    static func decide(storedConfig: String?, infoDictionary: [String: Any]) -> CrashLaunchDecision {
        guard let config = CrashConfig.parse(storedConfig), config.enabled else { return .disable }
        guard let endpoint = CrashEndpoint(
            token: infoDictionary[tokenKey] as? String,
            host: infoDictionary[hostKey] as? String
        ) else { return .misconfigured }
        let release = CrashRelease.fromInfoDictionary(infoDictionary)
        let build = infoDictionary["CFBundleVersion"] as? String
        return .install(endpoint: endpoint, userInfo: config.userInfo(binaryRelease: release, binaryBuild: build))
    }
}
