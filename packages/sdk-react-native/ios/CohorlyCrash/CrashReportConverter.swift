import Foundation

/// Values of the launch that SENDS a report. Only `$app_version_string`,
/// `$app_build_number`, `$lib` and `$lib_version` come from here: like every
/// event they describe the sender (ADR-0019 joins crash-free users on them).
/// Release and identity always come from the crash itself.
struct CrashSendingLaunch: Equatable {
    var lib: CrashLibInfo
    var appVersionString: String?
    var appBuildNumber: String?

    static func current(lib: CrashLibInfo, infoDictionary: [String: Any]) -> CrashSendingLaunch {
        CrashSendingLaunch(
            lib: lib,
            appVersionString: infoDictionary["CFBundleShortVersionString"] as? String,
            appBuildNumber: infoDictionary["CFBundleVersion"] as? String
        )
    }
}

/// Turns one KSCrash 2.x JSON report (as returned by the report store, user
/// info stitched in) into the `$exception` `/track` body of
/// docs/NATIVE-SYMBOLICATION.md. Pure.
enum CrashReportConverter {
    /// nil when the report has no crash time or no threads: a report is never
    /// stamped with the send time.
    static func convert(report: [String: Any], sending: CrashSendingLaunch) -> [String: Any]? {
        let reportInfo = report["report"] as? [String: Any] ?? [:]
        guard let crashTime = crashTimeMs(reportInfo["timestamp"]),
              let crash = report["crash"] as? [String: Any],
              let threads = crash["threads"] as? [[String: Any]], !threads.isEmpty
        else { return nil }
        let error = crash["error"] as? [String: Any] ?? [:]
        let system = report["system"] as? [String: Any] ?? [:]
        let user = report["user"] as? [String: Any] ?? [:]
        let images = report["binary_images"] as? [[String: Any]] ?? []

        var imageByAddr: [UInt64: (uuid: String, path: String)] = [:]
        for image in images {
            guard let addr = CrashPayload.uint(image["image_addr"]) else { continue }
            imageByAddr[addr] = (CrashPayload.debugId(image["uuid"] as? String), image["name"] as? String ?? "")
        }

        func frames(_ backtrace: [String: Any]?) -> [[String: Any]] {
            var contents = backtrace?["contents"] as? [[String: Any]] ?? []
            // KSCrash's second entry is the link register. When the crash is
            // the instruction right after a call (Swift's fatalError is
            // `bl ...; brk`), that is the program counter again: one frame
            // listed twice, which the server would read as a recursion.
            if contents.count > 1,
               let pc = CrashPayload.uint(contents[0]["instruction_addr"]),
               CrashPayload.uint(contents[1]["instruction_addr"]) == pc {
                contents.remove(at: 1)
            }
            // KSCrash lists the innermost frame first; the contract wants the
            // oldest call first and the crashing frame last.
            return contents.reversed().compactMap { entry in
                guard let ip = CrashPayload.uint(entry["instruction_addr"]) else { return nil }
                let imageAddr = CrashPayload.uint(entry["object_addr"]) ?? 0
                let image = imageByAddr[imageAddr]
                let path = image?.path ?? ""
                let module = (entry["object_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? CrashPayload.basename(path)
                return CrashPayload.frame(
                    module: module,
                    instructionAddr: ip,
                    imageAddr: imageAddr,
                    debugId: image?.uuid ?? "",
                    inApp: CrashPayload.isInApp(path: path),
                    function: entry["symbol_name"] as? String
                )
            }
        }

        let crashed = threads.first { ($0["crashed"] as? Bool) == true } ?? threads[0]
        let crashedIndex = crashed["index"] as? Int
        // KSCrash's own handler threads ("KSCrash Exception Handler
        // (Primary|Secondary)") describe the reporter, never the app.
        let others = threads.filter { thread in
            (thread["index"] as? Int) != crashedIndex
                && !((thread["name"] as? String)?.hasPrefix("KSCrash ") ?? false)
        }
        let otherThreads: [[String: Any]] = others.prefix(CrashPayload.maxThreads).map { thread in
            var entry: [String: Any] = [
                "id": thread["index"] as? Int ?? -1,
                "stacktrace": CrashPayload.stacktrace(frames(thread["backtrace"] as? [String: Any]))
            ]
            if let name = (thread["name"] as? String) ?? (thread["dispatch_queue"] as? String) { entry["name"] = name }
            return entry
        }

        let described = describe(error: error, images: images)
        let (type, value, mechanism) = (described.type, described.value, described.mechanism)
        // NSException: the exception's own call stack (the throw site) beats
        // the crashed thread's stack, which by then is only the abort path.
        let lastException = crash["last_exception_backtrace"] as? [String: Any]
            ?? crashed["last_exception_backtrace"] as? [String: Any]
        let crashedFrames = mechanism == "nsexception" && lastException != nil
            ? frames(lastException)
            : frames(crashed["backtrace"] as? [String: Any])

        // Unknown is never replaced by the sending launch's values: no release
        // becomes "ios@unknown", no distinct id falls back to the device id
        // recorded at crash time (never the sender's).
        func present(_ key: String) -> String? {
            guard let value = user[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        let deviceId = present(CrashUserInfo.deviceIdKey)
        let insertId = (reportInfo["id"] as? String).flatMap { $0.isEmpty ? nil : $0.lowercased() }
            ?? CrashPayload.stableUUID(CrashPayload.canonicalJSON(report))

        var props: [String: Any] = [
            "time": crashTime,
            "$insert_id": insertId,
            "$lib": sending.lib.lib,
            "$lib_version": sending.lib.version,
            "$os": "iOS",
            "$exception_list": [[
                "type": type,
                "value": value,
                "mechanism": ["handled": false, "type": mechanism, "synthetic": false],
                "stacktrace": CrashPayload.stacktrace(crashedFrames)
            ]],
            "$exception_level": "fatal",
            "$exception_release": present(CrashUserInfo.releaseKey) ?? CrashRelease.unknown,
            "$exception_threads": otherThreads
        ]
        if let distinctId = present(CrashUserInfo.distinctIdKey) ?? deviceId { props["distinct_id"] = distinctId }
        if let deviceId { props["$device_id"] = deviceId }
        if let userId = present(CrashUserInfo.userIdKey) { props["$user_id"] = userId }
        if let dist = present(CrashUserInfo.distKey) { props["$exception_dist"] = dist }
        if let osVersion = system["system_version"] as? String { props["$os_version"] = osVersion }
        if let model = system["machine"] as? String { props["$model"] = model }
        if let version = sending.appVersionString { props["$app_version_string"] = version }
        if let build = sending.appBuildNumber { props["$app_build_number"] = build }
        return CrashPayload.event(properties: props)
    }

    /// (type, value, mechanism). The mechanism is the monitor that caught the
    /// crash (`crash.error.type`); NSException and C++ keep their own class
    /// name as `type` rather than the EXC_CRASH/SIGABRT KSCrash also records.
    static func describe(error: [String: Any], images: [[String: Any]]) -> ExceptionDescription {
        let kind = error["type"] as? String ?? "signal"
        let mach = error["mach"] as? [String: Any]
        let signalName = (error["signal"] as? [String: Any])?["name"] as? String
        let address = CrashPayload.uint(error["address"]) ?? 0
        switch kind {
        case "nsexception":
            let ns = error["nsexception"] as? [String: Any]
            return ExceptionDescription(ns?["name"] as? String ?? "NSException",
                    error["reason"] as? String ?? ns?["reason"] as? String ?? "",
                    "nsexception")
        case "cpp_exception":
            let cpp = error["cpp_exception"] as? [String: Any]
            return ExceptionDescription(cpp?["name"] as? String ?? "C++ exception", error["reason"] as? String ?? "", "cpp_exception")
        default:
            let machName = mach?["exception_name"] as? String
            let type = machName ?? signalName ?? "UNKNOWN"
            var value: String
            // "<code> at <address>" only means something for EXC_BAD_ACCESS.
            if machName == "EXC_BAD_ACCESS", let code = mach?["code_name"] as? String {
                value = "\(code) at \(CrashPayload.hex(address))"
                if let signalName { value += " (\(signalName))" }
            } else {
                value = signalName ?? type
            }
            // Swift fatalError/precondition write their message into the
            // __crash_info section of libswiftCore, which KSCrash records.
            if let message = images.compactMap({ $0["crash_info_message"] as? String }).first {
                value += ": \(message.trimmingCharacters(in: .whitespacesAndNewlines))"
            }
            return ExceptionDescription(type, value, kind == "mach" ? "mach" : "signal")
        }
    }

    /// KSCrash 2.6 writes `report.timestamp` as ISO 8601 with microseconds
    /// ("2026-11-11T14:44:49.914280Z"), which ISO8601DateFormatter cannot
    /// parse; older reports use whole seconds or a number of microseconds.
    static func crashTimeMs(_ value: Any?) -> Int64? {
        if let number = value as? NSNumber { return number.int64Value / 1000 }
        guard let string = value as? String, !string.isEmpty else { return nil }
        let parts = string.replacingOccurrences(of: "Z", with: "").split(separator: ".", maxSplits: 1)
        guard let base = parts.first, let date = ISO8601DateFormatter().date(from: base + "Z") else { return nil }
        var ms = Int64(date.timeIntervalSince1970) * 1000
        if parts.count == 2 {
            let digits = String(parts[1].prefix(3).filter(\.isNumber))
            ms += Int64(digits.padding(toLength: 3, withPad: "0", startingAt: 0)) ?? 0
        }
        return ms
    }
}

/// `$exception_list[0]`'s `type`, `value` and `mechanism.type`.
struct ExceptionDescription: Equatable {
    let type: String
    let value: String
    let mechanism: String

    init(_ type: String, _ value: String, _ mechanism: String) {
        self.type = type
        self.value = value
        self.mechanism = mechanism
    }
}
