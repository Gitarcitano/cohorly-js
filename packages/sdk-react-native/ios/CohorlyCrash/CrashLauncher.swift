import Foundation

/// The side effects a launch decision drives. `CrashReporter` is the real
/// one (KSCrash, background uploads, MetricKit); tests use a fake.
protocol CrashBackend: AnyObject {
    /// Installs the crash monitors. False when the install failed.
    func installMonitors() -> Bool
    func setUserInfo(_ userInfo: CrashUserInfo)
    /// Converts and uploads the reports of earlier launches, off the main thread.
    func sendPendingReports(endpoint: CrashEndpoint)
    func subscribeMetricKit(endpoint: CrashEndpoint)
    /// Deletes every report of earlier launches without sending it.
    func deletePendingReports()
}

/// Applies a `CrashLaunchDecision`. Pure apart from the backend calls.
enum CrashLauncher {
    /// True when the reporter is installed in this process.
    @discardableResult
    static func run(_ decision: CrashLaunchDecision, backend: CrashBackend) -> Bool {
        switch decision {
        case let .install(endpoint, userInfo):
            let installed = backend.installMonitors()
            // Written right after install (KSCrash ignores user info before),
            // so even a crash during the rest of launch carries it.
            if installed { backend.setUserInfo(userInfo) }
            // Reports of earlier launches and MetricKit do not depend on this
            // launch's handlers: a failed install still sends them.
            backend.sendPendingReports(endpoint: endpoint)
            backend.subscribeMetricKit(endpoint: endpoint)
            return installed
        case .disable:
            backend.deletePendingReports()
            return false
        case .misconfigured:
            CrashLog.log("native crash reporting is on but the Info.plist has no \(CrashLaunchDecision.tokenKey) or \(CrashLaunchDecision.hostKey); not installed")
            return false
        }
    }
}
