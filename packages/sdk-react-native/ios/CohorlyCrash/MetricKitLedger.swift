import Foundation

/// The MetricKit diagnostics already written to the outbox (VEL-1802), so a
/// diagnostic delivered again is not uploaded again.
///
/// MetricKit hands a payload to `didReceive` and also keeps it in
/// `pastDiagnosticPayloads`, which the reporter reads on every launch to catch
/// the ones delivered while no subscriber was registered (the app was not
/// running, or crash reporting started later). The same diagnostic can also
/// come back inside another payload. Both paths skip what the ledger already
/// holds.
///
/// The key is each converted diagnostic's `$insert_id`, derived from its
/// content (the outbox file is `mk-<insert id>`). A key is recorded only once
/// the outbox file is durably written (`CrashUploader.enqueue` `onWritten`),
/// never before: if the app dies or the write fails, the next delivery tries
/// again. That makes delivery at-least-once; the server dedups by
/// `$insert_id`, so the ledger only saves the upload and the outbox slot.
///
/// The ledger is UserDefaults `cohorly.crash.metrickit.seen`, the most recent
/// `capacity` keys: MetricKit delivers about one payload a day with a handful
/// of diagnostics, and keeps a few days of them, so 256 is weeks of margin.
struct MetricKitLedger {
    static let defaultsKey = "cohorly.crash.metrickit.seen"
    static let defaultCapacity = 256

    private let defaults: UserDefaults
    private let capacity: Int
    private static let lock = NSLock()

    init(defaults: UserDefaults = .standard, capacity: Int = MetricKitLedger.defaultCapacity) {
        self.defaults = defaults
        self.capacity = max(1, capacity)
    }

    /// The keys not recorded yet, in order and without repeats. Records nothing.
    func unseen(_ keys: [String]) -> [String] {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        var known = Set(defaults.stringArray(forKey: Self.defaultsKey) ?? [])
        return keys.filter { known.insert($0).inserted }
    }

    /// Appends `key` (no-op if already there), keeping the last `capacity`.
    func record(_ key: String) {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        var seen = defaults.stringArray(forKey: Self.defaultsKey) ?? []
        guard !seen.contains(key) else { return }
        seen.append(key)
        defaults.set(Array(seen.suffix(capacity)), forKey: Self.defaultsKey)
    }
}
