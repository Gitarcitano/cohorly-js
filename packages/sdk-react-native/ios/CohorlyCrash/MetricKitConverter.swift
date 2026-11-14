import Foundation

/// The kinds of MetricKit diagnostic the reporter forwards. None is ever
/// `fatal`: KSCrash already reports the crashes it catches as fatal, and
/// MetricKit's copies (plus watchdog kills and OOMs KSCrash cannot see) stay
/// out of crash-free users.
enum MetricKitDiagnosticKind: String, Equatable {
    case crash
    case hang
    case cpuException

    var level: String {
        switch self {
        case .crash: return "error"
        case .hang, .cpuException: return "warning"
        }
    }
}

/// What the converter needs to know about the running process.
struct MetricKitEnvironment: Equatable {
    var lib: CrashLibInfo
    /// Current bundle id, for diagnostics older than iOS 17 that do not carry one.
    var bundleId: String?
    /// Current device id: MetricKit keeps no identity, so this is the best the
    /// SDK knows. Never a user id.
    var deviceId: String?
    var appVersionString: String?
    var appBuildNumber: String?
    /// LC_UUIDs (lowercase, hyphenated) of the images loaded from inside the
    /// app bundle in this process.
    var inAppImageUUIDs: Set<String>
    /// The main executable's name, the fallback in-app test when a UUID is not
    /// in `inAppImageUUIDs` (e.g. the diagnostic is from an older build).
    var mainExecutableName: String?
}

/// Converts the dictionary of `MXDiagnostic.jsonRepresentation()` into a
/// `$exception` `/track` body. Pure: tested on fixture payloads, without
/// MetricKit.
enum MetricKitConverter {
    static func convert(
        diagnostic: [String: Any],
        kind: MetricKitDiagnosticKind,
        timeMs: Int64,
        environment: MetricKitEnvironment
    ) -> [String: Any]? {
        let meta = diagnostic["diagnosticMetaData"] as? [String: Any]
            ?? diagnostic["metaData"] as? [String: Any] ?? [:]
        let tree = diagnostic["callStackTree"] as? [String: Any] ?? [:]
        let callStacks = tree["callStacks"] as? [[String: Any]] ?? []

        func string(_ keys: String...) -> String? {
            for key in keys {
                if let value = meta[key] as? String, !value.isEmpty { return value }
            }
            return nil
        }

        // The attributed stack is the thread that crashed (or hung); the rest
        // go to `$exception_threads`, keyed by their position in the tree.
        let stacks: [CallStack] = callStacks.enumerated().map { index, stack in
            let roots = stack["callStackRootFrames"] as? [[String: Any]] ?? []
            return CallStack(id: index, attributed: (stack["threadAttributed"] as? Bool) == true,
                             frames: frames(roots: roots, environment: environment))
        }
        let crashed = stacks.first { $0.attributed } ?? stacks.first
        let crashedFrames = crashed?.frames ?? []
        let threads: [[String: Any]] = stacks.filter { $0.id != crashed?.id }.prefix(CrashPayload.maxThreads).map { stack in
            ["id": stack.id, "stacktrace": CrashPayload.stacktrace(stack.frames)]
        }

        let (type, value) = describe(kind: kind, meta: meta)
        var props: [String: Any] = [
            "time": timeMs,
            // Same diagnostic delivered twice -> same id -> deduped by /track.
            "$insert_id": CrashPayload.stableUUID(CrashPayload.canonicalJSON(diagnostic)),
            "$lib": environment.lib.lib,
            "$lib_version": environment.lib.version,
            "$os": "iOS",
            "$exception_list": [[
                "type": type,
                "value": value,
                "mechanism": ["handled": false, "type": "metrickit", "synthetic": false],
                "stacktrace": CrashPayload.stacktrace(crashedFrames)
            ]],
            "$exception_level": kind.level,
            "$exception_threads": threads
        ]
        if let version = string("appVersion", "applicationVersion") {
            let bundleId = string("bundleIdentifier") ?? environment.bundleId ?? "ios"
            var release = "\(bundleId)@\(version)"
            if let build = string("appBuildVersion", "applicationBuildVersion") { release += "+\(build)" }
            props["$exception_release"] = release
        } else {
            props["$exception_release"] = CrashRelease.unknown
        }
        if let deviceId = environment.deviceId {
            props["distinct_id"] = deviceId
            props["$device_id"] = deviceId
        }
        if let os = string("osVersion"), let version = osVersionNumber(os) { props["$os_version"] = version }
        if let model = string("deviceType") { props["$model"] = model }
        if let version = environment.appVersionString { props["$app_version_string"] = version }
        if let build = environment.appBuildNumber { props["$app_build_number"] = build }
        return CrashPayload.event(properties: props)
    }

    /// MetricKit trees list the innermost frame as the root and its callers as
    /// `subFrames`. A crash stack is a single chain; a sampled hang or CPU
    /// tree may branch, and the heaviest branch (highest `sampleCount`) wins.
    /// The chain is reversed into oldest-call-first order.
    static func frames(roots: [[String: Any]], environment: MetricKitEnvironment) -> [[String: Any]] {
        var chain: [[String: Any]] = []
        var level = roots
        while let next = heaviest(level) {
            chain.append(next)
            level = next["subFrames"] as? [[String: Any]] ?? []
        }
        return chain.reversed().compactMap { frame in
            guard let address = CrashPayload.uint(frame["address"]) else { return nil }
            let offset = CrashPayload.uint(frame["offsetIntoBinaryTextSegment"]) ?? 0
            let uuid = CrashPayload.debugId(frame["binaryUUID"] as? String)
            let name = frame["binaryName"] as? String ?? ""
            let inApp = environment.inAppImageUUIDs.contains(uuid)
                || (!name.isEmpty && name == environment.mainExecutableName)
            return CrashPayload.frame(
                module: name,
                instructionAddr: address,
                imageAddr: address >= offset ? address - offset : 0,
                debugId: uuid,
                inApp: inApp,
                function: nil
            )
        }
    }

    private static func heaviest(_ frames: [[String: Any]]) -> [String: Any]? {
        frames.max { lhs, rhs in
            (CrashPayload.uint(lhs["sampleCount"]) ?? 0) < (CrashPayload.uint(rhs["sampleCount"]) ?? 0)
        }
    }

    static func describe(kind: MetricKitDiagnosticKind, meta: [String: Any]) -> (String, String) {
        switch kind {
        case .hang:
            let duration = meta["hangDuration"] as? String
            return ("AppHang", duration.map { "App hang of \($0)" } ?? "App hang")
        case .cpuException:
            let cpu = meta["totalCPUTime"] as? String
            let sampled = meta["totalSampledTime"] as? String
            if let cpu, let sampled { return ("CPUException", "\(cpu) of CPU over \(sampled)") }
            return ("CPUException", "CPU usage limit exceeded")
        case .crash:
            let reason = meta["exceptionReason"] as? [String: Any]
            let signalName = (meta["signal"] as? NSNumber).flatMap { signalNames[$0.int32Value] }
            let machName = (meta["exceptionType"] as? NSNumber).flatMap { machExceptionNames[$0.int32Value] }
            let type = (reason?["className"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (reason?["exceptionName"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? machName ?? signalName ?? "MXCrashDiagnostic"
            let value = (reason?["composedMessage"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (meta["terminationReason"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? signalName ?? type
            return (type, value)
        }
    }

    /// "iPhone OS 17.4 (21E219)" -> "17.4".
    static func osVersionNumber(_ raw: String) -> String? {
        guard let range = raw.range(of: #"\d+(\.\d+)+"#, options: .regularExpression) else { return nil }
        return String(raw[range])
    }

    static let machExceptionNames: [Int32: String] = [
        1: "EXC_BAD_ACCESS", 2: "EXC_BAD_INSTRUCTION", 3: "EXC_ARITHMETIC", 4: "EXC_EMULATION",
        5: "EXC_SOFTWARE", 6: "EXC_BREAKPOINT", 7: "EXC_SYSCALL", 8: "EXC_MACH_SYSCALL",
        9: "EXC_RPC_ALERT", 10: "EXC_CRASH", 11: "EXC_RESOURCE", 12: "EXC_GUARD", 13: "EXC_CORPSE_NOTIFY"
    ]

    static let signalNames: [Int32: String] = [
        4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGBUS",
        11: "SIGSEGV", 13: "SIGPIPE", 15: "SIGTERM"
    ]
}

/// One call stack of a MetricKit call stack tree, flattened.
private struct CallStack {
    let id: Int
    let attributed: Bool
    let frames: [[String: Any]]
}
