import Foundation

/// What to do with a report once its upload finished.
enum UploadOutcome: Equatable {
    /// Delivered, or refused for good: delete the report and its file.
    case delete
    /// Try again on the next launch.
    case keep
}

/// Upload completion policy, the SDK retry contract applied to crash reports:
/// 2xx is delivered; 400 (malformed) and 413 (too large) will never succeed,
/// so the report is dropped; 401, 429, 5xx, any other status and any
/// transport error keep it for the next launch, even when a status arrived
/// (a response cut short is not proof of delivery).
enum UploadPolicy {
    static func outcome(statusCode: Int?, error: Error?) -> UploadOutcome {
        if error != nil { return .keep }
        guard let statusCode else { return .keep }
        if (200..<300).contains(statusCode) || statusCode == 400 || statusCode == 413 { return .delete }
        return .keep
    }
}

/// Sends crash payloads through a background `URLSession`, uploading from a
/// file so `nsurlsessiond` finishes the request even when the app dies right
/// after launch (ADR-0020: 7/7 delivered in a crash loop).
///
/// Every payload is a file `<id>.json` in the outbox directory. A file stays
/// until its upload completes with `UploadOutcome.delete`; a file without a
/// task in flight is uploaded again on the next `resumePending()`. All work
/// runs on a private serial queue, never on the main thread.
final class CrashUploader: NSObject, URLSessionDataDelegate {
    let identifier: String
    let directory: URL
    private let endpoint: CrashEndpoint
    private let onDelete: (String) -> Void
    private let work = DispatchQueue(label: "com.cohorly.crash.uploader", qos: .utility)
    private let delegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "com.cohorly.crash.uploader.delegate"
        return queue
    }()
    /// Task descriptions (payload ids) of the uploads in flight. Touched on `work` only.
    private var inFlight: Set<String> = []
    private var attached = false
    /// Touched on `work` only.
    private var completionGate = BackgroundCompletionGate()

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

    /// - Parameter onDelete: called with the payload id once its file is
    ///   deleted after a final outcome (the caller removes its own copy, e.g.
    ///   the KSCrash report).
    init(identifier: String, directory: URL, endpoint: CrashEndpoint, onDelete: @escaping (String) -> Void) {
        self.identifier = identifier
        self.directory = directory
        self.endpoint = endpoint
        self.onDelete = onDelete
        super.init()
    }

    /// One stable session identifier per app, so a later launch reattaches to
    /// the uploads an earlier one started.
    static func sessionIdentifier(bundleId: String?) -> String {
        "\(bundleId ?? "app").cohorly.crash.upload"
    }

    /// Sessions being cancelled, kept alive until iOS hands them the tasks
    /// of earlier launches and they are cancelled.
    private static var cancelling: [URLSession] = []
    private static let cancellingLock = NSLock()

    /// Cancels every upload of the session `identifier`, from any launch:
    /// attaches to it, cancels each task `nsurlsessiond` still holds, then
    /// invalidates it. The session is retained until that is done.
    static func cancelAll(identifier: String) {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        let session = URLSession(configuration: configuration)
        cancellingLock.lock()
        cancelling.append(session)
        cancellingLock.unlock()
        session.getAllTasks { tasks in
            tasks.forEach { $0.cancel() }
            session.invalidateAndCancel()
            cancellingLock.lock()
            cancelling.removeAll { $0 === session }
            cancellingLock.unlock()
        }
    }

    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("com.cohorly.crash", isDirectory: true)
            .appendingPathComponent("outbox", isDirectory: true)
    }

    /// Reattaches the session (completions of an earlier launch are delivered
    /// to this delegate), then runs `body` with the ids already in flight.
    func withInFlight(_ body: @escaping (Set<String>) -> Void) {
        work.async {
            self.attachIfNeeded()
            body(self.inFlight)
        }
    }

    /// Writes the payload file (replacing an earlier copy) and uploads it
    /// unless an upload with the same id is already in flight.
    ///
    /// - Parameter onWritten: called on the uploader's queue once the payload
    ///   is durably in the outbox: right after the file is written, or when
    ///   an upload with the same id is already in flight (its file was
    ///   written by the earlier call and stays until a final outcome, so the
    ///   payload is just as safe). Never called when the write fails.
    func enqueue(id: String, body: Data, onWritten: (() -> Void)? = nil) {
        work.async {
            self.attachIfNeeded()
            guard !self.inFlight.contains(id) else {
                onWritten?()
                return
            }
            guard self.write(id: id, body: body) else { return }
            onWritten?()
            self.upload(id: id)
        }
    }

    /// Uploads every outbox file without a task in flight.
    func resumePending() {
        work.async {
            self.attachIfNeeded()
            for id in self.fileIds() where !self.inFlight.contains(id) {
                self.upload(id: id)
            }
        }
    }

    /// For `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
    /// The handler runs once the session's events are delivered and their
    /// outcomes are on disk, whichever of the two arrives first.
    func setBackgroundCompletion(_ handler: @escaping () -> Void) {
        work.async {
            self.attachIfNeeded()
            if let ready = self.completionGate.setHandler(handler) { DispatchQueue.main.async(execute: ready) }
        }
    }

    func fileURL(id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    /// Ids of the payload files in the outbox, oldest first.
    func fileIds() -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]
        )) ?? []
        return files.filter { $0.pathExtension == "json" }
            .sorted { modified($0) < modified($1) }
            .map { $0.deletingPathExtension().lastPathComponent }
    }

    private func modified(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    // MARK: - On `work`

    private func attachIfNeeded() {
        guard !attached else { return }
        attached = true
        let done = DispatchSemaphore(value: 0)
        var described: [String] = []
        // Delivered on `delegateQueue`, so waiting here (a utility queue,
        // never main) cannot deadlock.
        session.getAllTasks { tasks in
            described = tasks.compactMap(\.taskDescription)
            done.signal()
        }
        _ = done.wait(timeout: .now() + 5)
        inFlight.formUnion(described)
    }

    private func write(id: String, body: Data) -> Bool {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var dir = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? dir.setResourceValues(values)
            try body.write(to: fileURL(id: id), options: .atomic)
            return true
        } catch {
            CrashLog.log("could not write crash payload \(id): \(error.localizedDescription)")
            return false
        }
    }

    private func upload(id: String) {
        let file = fileURL(id: id)
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        var request = URLRequest(url: endpoint.trackURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(endpoint.token, forHTTPHeaderField: "X-Cohorly-Token")
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = id
        inFlight.insert(id)
        task.resume()
    }

    private func finish(id: String, outcome: UploadOutcome) {
        inFlight.remove(id)
        guard outcome == .delete else { return }
        try? FileManager.default.removeItem(at: fileURL(id: id))
        onDelete(id)
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = task.taskDescription else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode
        let outcome = UploadPolicy.outcome(statusCode: status, error: error)
        work.async { self.finish(id: id, outcome: outcome) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        // Queued on `work` after every `finish` the completions above queued,
        // so the files are deleted before the system may suspend the app.
        work.async {
            if let ready = self.completionGate.eventsFinished() { DispatchQueue.main.async(execute: ready) }
        }
    }
}

/// Pairs `urlSessionDidFinishEvents` with the app delegate's completion
/// handler, which can arrive in either order: the handler is returned
/// exactly once, when both have happened.
struct BackgroundCompletionGate {
    private var handler: (() -> Void)?
    private var finished = false

    mutating func setHandler(_ handler: @escaping () -> Void) -> (() -> Void)? {
        if finished {
            finished = false
            return handler
        }
        self.handler = handler
        return nil
    }

    mutating func eventsFinished() -> (() -> Void)? {
        guard let handler else {
            finished = true
            return nil
        }
        self.handler = nil
        return handler
    }
}

/// One-line logs, prefixed so they can be filtered.
enum CrashLog {
    static func log(_ message: String) {
        NSLog("[Cohorly] %@", message)
    }
}
