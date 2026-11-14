import Foundation
import MachO
#if canImport(KSCrashRecording)
import KSCrashRecording // Swift Package Manager: product `Recording`
#elseif canImport(KSCrash)
import KSCrash // CocoaPods: pod `KSCrash/Recording`
#endif
#if canImport(MetricKit) && os(iOS)
import MetricKit
#endif

/// The process-wide native crash reporter: KSCrash (crash monitors only),
/// next-launch sending through `CrashUploader`, and MetricKit diagnostics.
/// Thread-safe. One per process.
final class CrashReporter: CrashBackend {
    static let shared = CrashReporter()

    /// KSCrash prunes the oldest report past this count. 10 (default 5) so a
    /// crash loop whose sends never land loses fewer crashes.
    static let maxReportCount = 10
    /// Cap on MetricKit payload files waiting in the outbox.
    static let maxMetricKitFiles = 20

    private static let kscrashPrefix = "ks-"
    static let metricKitPrefix = "mk-"

    private let lock = NSLock()
    private var lib = CrashLibInfo(lib: "ios", version: "0.0.0")
    private var installed = false
    private var userInfo = CrashUserInfo()
    private var uploader: CrashUploader?
    private var metricKitSubscriber: AnyObject?

    var isInstalled: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    /// Applies the launch decision once per process. A second call after the
    /// reporter is installed only refreshes the user info.
    @discardableResult
    func start(_ decision: CrashLaunchDecision, lib: CrashLibInfo) -> Bool {
        lock.lock()
        if installed {
            lock.unlock()
            if case let .install(_, userInfo) = decision { setUserInfo(userInfo) }
            return true
        }
        self.lib = lib
        lock.unlock()
        return CrashLauncher.run(decision, backend: self)
    }

    /// React Native entry point: decides from the config the JS layer wrote on
    /// the previous launch (`cohorly.crash.config`) and the Info.plist.
    @discardableResult
    func startFromStoredConfig(lib: CrashLibInfo, defaults: UserDefaults = .standard, bundle: Bundle = .main) -> Bool {
        let decision = CrashLaunchDecision.decide(
            storedConfig: defaults.string(forKey: CrashConfig.defaultsKey),
            infoDictionary: bundle.infoDictionary ?? [:]
        )
        return start(decision, lib: lib)
    }

    /// Refreshes release/dist/identity for crashes of THIS launch. No-op until
    /// the reporter is installed.
    func updateUserInfo(_ userInfo: CrashUserInfo) {
        guard isInstalled else { return }
        setUserInfo(userInfo)
    }

    /// From `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
    /// True when `identifier` is the reporter's session AND this launch has
    /// its uploader (created in `didFinishLaunching`, before iOS delivers the
    /// events): the handler is then called once those events are on disk.
    /// False otherwise (reporting off or misconfigured), so the caller passes
    /// the handler on and it is never left uncalled.
    func handleEventsForBackgroundURLSession(_ identifier: String, completionHandler: @escaping () -> Void) -> Bool {
        guard identifier == CrashUploader.sessionIdentifier(bundleId: Bundle.main.bundleIdentifier) else { return false }
        lock.lock()
        let uploader = self.uploader
        lock.unlock()
        guard let uploader else { return false }
        uploader.setBackgroundCompletion(completionHandler)
        return true
    }

    // MARK: - CrashBackend

    func installMonitors() -> Bool {
        let configuration = KSCrashConfiguration()
        // Crash monitors only. KSCrash force-adds the context monitors it
        // needs (system, app state, user info); no watchdog, zombie,
        // termination or resource monitors.
        configuration.monitors = [.machException, .signal, .cppException, .nsException]
        configuration.reportStoreConfiguration.maxReportCount = Self.maxReportCount
        do {
            try KSCrash.shared.install(with: configuration)
        } catch {
            CrashLog.log("KSCrash install failed: \(error.localizedDescription)")
            return false
        }
        lock.lock()
        installed = true
        lock.unlock()
        return true
    }

    func setUserInfo(_ userInfo: CrashUserInfo) {
        lock.lock()
        self.userInfo = userInfo
        lock.unlock()
        for (key, value) in userInfo.entries {
            KSCrash.shared.setUserInfo(value, forKey: key)
        }
    }

    func sendPendingReports(endpoint: CrashEndpoint) {
        let uploader = makeUploader(endpoint: endpoint)
        let sending = CrashSendingLaunch.current(lib: lib, infoDictionary: Bundle.main.infoDictionary ?? [:])
        uploader.withInFlight { inFlight in
            if let store = Self.reportStore() {
                var stored: Set<String> = []
                for number in store.reportIDs {
                    let reportId = number.int64Value
                    let id = Self.kscrashPrefix + String(reportId)
                    stored.insert(id)
                    // Already handed to nsurlsessiond by an earlier launch.
                    if inFlight.contains(id) { continue }
                    guard let report = store.report(for: reportId)?.value,
                          let payload = CrashReportConverter.convert(report: report, sending: sending),
                          let body = try? JSONSerialization.data(withJSONObject: payload)
                    else {
                        CrashLog.log("crash report \(reportId) could not be converted; deleted")
                        store.deleteReport(with: reportId)
                        continue
                    }
                    uploader.enqueue(id: id, body: body)
                }
                // A copy whose KSCrash report is gone (pruned past
                // maxReportCount) and is not uploading is dropped, so the
                // outbox stays bounded by the store in a crash loop that
                // cannot send.
                for id in uploader.fileIds() where id.hasPrefix(Self.kscrashPrefix)
                    && !stored.contains(id) && !inFlight.contains(id) {
                    try? FileManager.default.removeItem(at: uploader.fileURL(id: id))
                }
            }
            // MetricKit payloads and reports whose earlier upload was kept.
            uploader.resumePending()
        }
    }

    func subscribeMetricKit(endpoint: CrashEndpoint) {
        #if canImport(MetricKit) && os(iOS)
        guard #available(iOS 14.0, *) else { return }
        let uploader = makeUploader(endpoint: endpoint)
        let subscriber = MetricKitSubscriber { [weak self] payloads in
            self?.enqueueMetricKit(payloads, uploader: uploader)
        }
        lock.lock()
        metricKitSubscriber = subscriber
        lock.unlock()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            MXMetricManager.shared.add(subscriber)
            // Payloads MetricKit delivered while no subscriber was registered
            // (the app was not running when they came, or crash reporting
            // started later) are only here; the ledger skips the diagnostics
            // didReceive already wrote to the outbox, and the other way around.
            self?.enqueueMetricKit(MXMetricManager.shared.pastDiagnosticPayloads, uploader: uploader)
        }
        #endif
    }

    func deletePendingReports() {
        // Never create KSCrash's directories on an app that never had it on.
        let installPath = (NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true).first ?? "")
            + "/KSCrash"
        let outbox = CrashUploader.defaultDirectory()
        let hasKSCrash = FileManager.default.fileExists(atPath: installPath)
        let hasOutbox = FileManager.default.fileExists(atPath: outbox.path)
        guard hasKSCrash || hasOutbox else { return }
        DispatchQueue.global(qos: .utility).async {
            if hasKSCrash, let store = try? CrashReportStore(configuration: nil) {
                store.deleteAllReports()
            }
            if hasOutbox {
                // Uploads an earlier launch handed to nsurlsessiond stop too.
                CrashUploader.cancelAll(identifier: CrashUploader.sessionIdentifier(bundleId: Bundle.main.bundleIdentifier))
                try? FileManager.default.removeItem(at: outbox)
            }
        }
    }

    // MARK: - Private

    private func makeUploader(endpoint: CrashEndpoint) -> CrashUploader {
        lock.lock()
        defer { lock.unlock() }
        if let uploader { return uploader }
        let uploader = CrashUploader(
            identifier: CrashUploader.sessionIdentifier(bundleId: Bundle.main.bundleIdentifier),
            directory: CrashUploader.defaultDirectory(),
            endpoint: endpoint
        ) { id in
            guard id.hasPrefix(Self.kscrashPrefix), let reportId = Int64(id.dropFirst(Self.kscrashPrefix.count)) else { return }
            Self.reportStore()?.deleteReport(with: reportId)
        }
        self.uploader = uploader
        return uploader
    }

    /// KSCrash's store, or the same on-disk store opened directly when the
    /// install failed this launch (its reports still need sending).
    private static func reportStore() -> CrashReportStore? {
        if let store = KSCrash.shared.reportStore { return store }
        let configuration = CrashReportStoreConfiguration()
        configuration.maxReportCount = maxReportCount
        return try? CrashReportStore(configuration: configuration)
    }

    #if canImport(MetricKit) && os(iOS)
    @available(iOS 14.0, *)
    private func enqueueMetricKit(_ payloads: [MXDiagnosticPayload], uploader: CrashUploader) {
        lock.lock()
        let environment = MetricKitEnvironment(
            lib: lib,
            bundleId: Bundle.main.bundleIdentifier,
            deviceId: userInfo.deviceId,
            appVersionString: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
            appBuildNumber: Bundle.main.infoDictionary?["CFBundleVersion"] as? String,
            inAppImageUUIDs: LoadedImages.appImageUUIDs(),
            mainExecutableName: Bundle.main.infoDictionary?["CFBundleExecutable"] as? String
        )
        lock.unlock()
        var events: [(insertId: String, body: Data)] = []
        for payload in payloads {
            let timeMs = Int64(payload.timeStampEnd.timeIntervalSince1970 * 1000)
            var diagnostics: [(MetricKitDiagnosticKind, MXDiagnostic)] = []
            diagnostics += (payload.crashDiagnostics ?? []).map { (.crash, $0) }
            diagnostics += (payload.hangDiagnostics ?? []).map { (.hang, $0) }
            diagnostics += (payload.cpuExceptionDiagnostics ?? []).map { (.cpuException, $0) }
            for (kind, diagnostic) in diagnostics {
                guard let dict = try? JSONSerialization.jsonObject(with: diagnostic.jsonRepresentation()) as? [String: Any],
                      let event = MetricKitConverter.convert(diagnostic: dict, kind: kind, timeMs: timeMs, environment: environment),
                      let insertId = (event["properties"] as? [String: Any])?["$insert_id"] as? String,
                      let body = try? JSONSerialization.data(withJSONObject: event)
                else { continue }
                events.append((insertId, body))
            }
        }
        Self.enqueueMetricKitEvents(events, uploader: uploader, ledger: MetricKitLedger())
    }
    #endif

    /// Converted MetricKit diagnostics -> ledger -> outbox, shared by
    /// `didReceive` and the past payloads. Only the diagnostics no earlier
    /// delivery wrote to the outbox (this launch or an earlier one) are
    /// enqueued, each once; a diagnostic enters the ledger only after its
    /// file is written, so a failed write or a death before it is retried
    /// on the next delivery (at-least-once, deduped by `$insert_id` on the
    /// server).
    static func enqueueMetricKitEvents(_ events: [(insertId: String, body: Data)], uploader: CrashUploader, ledger: MetricKitLedger) {
        let bodies = Dictionary(events.map { ($0.insertId, $0.body) }, uniquingKeysWith: { first, _ in first })
        for insertId in ledger.unseen(events.map(\.insertId)) {
            guard let body = bodies[insertId] else { continue }
            uploader.enqueue(id: metricKitPrefix + insertId, body: body) { ledger.record(insertId) }
        }
        pruneMetricKitFiles(uploader)
    }

    /// MetricKit files only live in the outbox, so their count is bounded here.
    private static func pruneMetricKitFiles(_ uploader: CrashUploader) {
        uploader.withInFlight { _ in
            let files = uploader.fileIds().filter { $0.hasPrefix(metricKitPrefix) }
            for id in files.dropLast(maxMetricKitFiles) {
                try? FileManager.default.removeItem(at: uploader.fileURL(id: id))
            }
        }
    }
}

#if canImport(MetricKit) && os(iOS)
@available(iOS 14.0, *)
private final class MetricKitSubscriber: NSObject, MXMetricManagerSubscriber {
    private let onDiagnostics: ([MXDiagnosticPayload]) -> Void

    init(onDiagnostics: @escaping ([MXDiagnosticPayload]) -> Void) {
        self.onDiagnostics = onDiagnostics
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        onDiagnostics(payloads)
    }
}
#endif

/// LC_UUIDs of the images loaded from inside the app bundle.
enum LoadedImages {
    static func appImageUUIDs(bundlePath: String = Bundle.main.bundlePath) -> Set<String> {
        var uuids: Set<String> = []
        let prefix = bundlePath.hasSuffix("/") ? bundlePath : bundlePath + "/"
        for index in 0..<_dyld_image_count() {
            guard let name = _dyld_get_image_name(index), String(cString: name).hasPrefix(prefix),
                  let header = _dyld_get_image_header(index),
                  let uuid = uuid(of: header)
            else { continue }
            uuids.insert(uuid)
        }
        return uuids
    }

    private static func uuid(of header: UnsafePointer<mach_header>) -> String? {
        guard header.pointee.magic == MH_MAGIC_64 else { return nil }
        var command = UnsafeRawPointer(header).advanced(by: MemoryLayout<mach_header_64>.size)
        for _ in 0..<header.pointee.ncmds {
            let load = command.load(as: load_command.self)
            if load.cmd == UInt32(LC_UUID) {
                let uuid = command.load(as: uuid_command.self).uuid
                return UUID(uuid: uuid).uuidString.lowercased()
            }
            command = command.advanced(by: Int(load.cmdsize))
        }
        return nil
    }
}
