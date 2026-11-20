import Foundation

/// Session replay recording for React Native on iOS (VEL-2153),
/// `NativeModules.CohorlyReactNativeReplay`. The recorder under
/// ios/CohorlyReplay/ is a copy of sdks/ios/Sources/CohorlyReplay/Recorder
/// (`sync:replay`); this file is its host.
///
/// Inert until `replayStart`: nothing is allocated, swizzled or observed
/// before. Pull model: the native side never emits to JS. It records as if
/// every session were in "session" mode, because the JS layer owns the
/// session id, the sampling draw, the error buffer and the upload; the
/// events carry no session (JS adds `$session_id` when it uploads). Each
/// delivery of the recorder (a Meta + FullSnapshot, a Mutation, a touch) is
/// one JSON array of rrweb mobile events (docs/SESSION-REPLAY.md "Mobile")
/// in an in-memory list that `replayDrain` empties. No `Cohorly` (Swift SDK)
/// is needed or linked.
///
/// The resolve/reject block types match RCTPromiseResolveBlock /
/// RCTPromiseRejectBlock, so no `import React`: CohorlyReactNativeReplay.m
/// links this to the bridge.
@objc(CohorlyReactNativeReplay)
final class CohorlyReactNativeReplay: NSObject {
    /// Who started the recording: only that instance (the live bridge) may
    /// drain, checkout or stop it, so a torn down bridge never touches the
    /// recording of the bridge that replaced it.
    private let instanceId = UUID()

    @objc
    static func requiresMainQueueSetup() -> Bool { false }

    /// `configJson`: `{"mode":"screenshot"|"wireframe","maskAllImages":bool}`.
    /// Resolves true when recording started, false when this platform cannot
    /// record. Never rejects. Called while recording: restarts with the new
    /// config, from a Meta + FullSnapshot.
    @objc(replayStart:resolver:rejecter:)
    func replayStart(
        _ configJson: String,
        resolver resolve: @escaping (Any?) -> Void,
        rejecter reject: @escaping (String?, String?, Error?) -> Void
    ) {
        resolve(ReactNativeReplayRecording.shared.start(configJson: configJson, owner: instanceId))
    }

    /// Stops capturing (triggers removed) and discards every pending event.
    /// Idempotent. No-op when another instance owns the recording.
    @objc(replayStop:rejecter:)
    func replayStop(
        _ resolve: @escaping (Any?) -> Void,
        rejecter reject: @escaping (String?, String?, Error?) -> Void
    ) {
        ReactNativeReplayRecording.shared.stop(by: instanceId)
        resolve(nil)
    }

    /// The next capture is Meta + FullSnapshot. No-op when stopped or owned
    /// by another instance.
    @objc(replayCheckout:rejecter:)
    func replayCheckout(
        _ resolve: @escaping (Any?) -> Void,
        rejecter reject: @escaping (String?, String?, Error?) -> Void
    ) {
        ReactNativeReplayRecording.shared.checkout(by: instanceId)
        resolve(nil)
    }

    /// The pending batches in capture order, each a JSON string of an array of
    /// rrweb mobile events; the list is emptied. `[]` when stopped, empty or
    /// owned by another instance.
    @objc(replayDrain:rejecter:)
    func replayDrain(
        _ resolve: @escaping (Any?) -> Void,
        rejecter reject: @escaping (String?, String?, Error?) -> Void
    ) {
        resolve(ReactNativeReplayRecording.shared.drain(by: instanceId))
    }

    /// RCTInvalidating (React Native calls it through `respondsToSelector:`):
    /// the bridge goes away (a JS reload). The recording this instance started
    /// stops, so no recorder keeps capturing for a JS that is gone; the next
    /// JS starts its own. An instance that does not own the recording (the
    /// new bridge already started one) leaves it alone.
    @objc
    func invalidate() {
        ReactNativeReplayRecording.shared.stop(by: instanceId)
    }
}

/// The one recording of the process (a module instance per bridge, one
/// screen), and the recorder's host.
///
/// Locks: every transition (start, stop, checkout, drain) runs whole under
/// `controlLock`, the owner check included, so nothing can change the
/// owner between "is it mine" and the action. It is held across
/// `ReplayRecorder.stop()`, which waits for the recorder's queue. `lock`
/// (always taken inside `controlLock` by the module, never the other way)
/// guards the pending list and the running flag the recorder's queue reads:
/// the recorder's queue takes `lock` while it holds the recorder's own lock
/// (`enqueueRecorded`), never `controlLock`, and nothing holds `lock` while
/// calling the recorder, so there is no cycle. One lock for both is not
/// possible: `stop()` waits for the recorder's queue, which needs `lock`.
final class ReactNativeReplayRecording: ReplayRecorderHost, @unchecked Sendable {
    static let shared = ReactNativeReplayRecording()

    /// Cap on the sum of the pending JSON strings, in UTF-8 bytes.
    static let maxPendingBytes = 5 * 1024 * 1024
    /// The recorder keys its state by session; the JS layer owns the real one.
    static let placeholderSessionId = "react-native"

    private let controlLock = NSLock()
    private var recorder: ReplayRecorder?
    private var lifecycle: ReplayLifecycleSource?
    private var owner: UUID?

    private let lock = NSLock()
    private var running = false
    private weak var current: ReplayRecorder?
    private var pending: [String] = []
    private var pendingBytes = 0
    /// Bumped each time batches are dropped: the recorder's next capture is
    /// then full (`ReplayRecorderHost.droppedChunks`).
    private var dropped = 0

    // MARK: - Module (the module's queue)

    func start(configJson: String, owner: UUID) -> Bool {
        #if os(iOS)
        let config = Self.parse(configJson)
        controlLock.lock()
        defer { controlLock.unlock() }
        stopRecording()
        // A new start is a new config and a new session in JS: nothing
        // captured before it may be drained into it.
        lock.lock()
        pending = []
        pendingBytes = 0
        lock.unlock()
        let recorder = ReplayRecorder(
            host: self,
            source: config.makeSource(),
            touchSource: SendEventTouchSource(),
            sinks: { mode, context in mode == .session ? ReactNativeReplaySink(context: context) : nil })
        let lifecycle = SystemReplayLifecycle()
        self.recorder = recorder
        self.lifecycle = lifecycle
        self.owner = owner
        lock.lock()
        running = true
        current = recorder
        lock.unlock()
        lifecycle.start { [weak recorder] event in
            switch event {
            case .didEnterBackground: recorder?.didEnterBackground()
            case .willEnterForeground: recorder?.willEnterForeground()
            }
        }
        recorder.start()
        return true
        #else
        return false
        #endif
    }

    /// Stops the recording and discards what is pending, when `instance`
    /// owns it (or nobody does: then it only empties what is already empty).
    func stop(by instance: UUID) {
        controlLock.lock()
        defer { controlLock.unlock() }
        if let current = owner, current != instance { return }
        stopRecording()
        owner = nil
        lock.lock()
        pending = []
        pendingBytes = 0
        lock.unlock()
    }

    func checkout(by instance: UUID) {
        controlLock.lock()
        defer { controlLock.unlock() }
        guard owner == instance else { return }
        // Takes only the recorder's lock and `lock`, never `controlLock`.
        recorder?.requestCapture(full: true)
    }

    func drain(by instance: UUID) -> [String] {
        controlLock.lock()
        defer { controlLock.unlock() }
        guard owner == instance else { return [] }
        lock.lock()
        defer { lock.unlock() }
        let out = pending
        pending = []
        pendingBytes = 0
        return out
    }

    /// Under `controlLock`. The caller decides what happens to the pending
    /// events (`start` and `stop` both discard them).
    private func stopRecording() {
        let recorder = self.recorder
        self.recorder = nil
        lifecycle?.stop()
        lifecycle = nil
        lock.lock()
        running = false
        current = nil
        lock.unlock()
        // Nothing of it is delivered after this returns.
        recorder?.stop()
    }

    /// Unknown or missing mode: screenshot; anything but a boolean
    /// `maskAllImages`: true. Never fails.
    static func parse(_ json: String) -> ReplayRecorderConfig {
        var object: [String: Any] = [:]
        if let data = json.data(using: .utf8),
           let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            object = parsed
        }
        let captureMode: ReplayCaptureMode = (object["mode"] as? String) == "wireframe" ? .wireframe : .screenshot
        var maskAllImages = true
        if let value = object["maskAllImages"] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() {
            maskAllImages = value.boolValue
        }
        return ReplayRecorderConfig(captureMode: captureMode, maskAllImages: maskAllImages)
    }

    // MARK: - ReplayRecorderHost

    func recordingState() -> ReplayRecordingState {
        lock.lock()
        let running = self.running
        lock.unlock()
        return ReplayRecordingState(mode: running ? .session : .off, sessionId: Self.placeholderSessionId, distinctId: "")
    }

    var droppedChunks: Int {
        lock.lock()
        defer { lock.unlock() }
        return dropped
    }

    var nowMs: Int64 { ReplayUtil.millis(Date()) }

    /// The recorder's queue, under the recorder's lock: encodes the delivery
    /// and appends it; over the cap, the oldest batches go and a full
    /// snapshot is asked for.
    func enqueueRecorded(
        _ events: [ReplayJSON], mode: ReplayChunkMode, sessionId: String, distinctId: String
    ) -> ReplayAdmission {
        guard !events.isEmpty else { return .queued }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(events) else { return .refused }
        let json = String(decoding: data, as: UTF8.self)
        let bytes = data.count
        lock.lock()
        guard running else {
            lock.unlock()
            return .refused
        }
        guard bytes <= Self.maxPendingBytes else {
            // Alone over the cap (a full snapshot with huge images): the
            // recorder then sends images without pixels, as the Swift SDK
            // does for a snapshot over its chunk limit.
            dropped += 1
            lock.unlock()
            ReplayLog.log("session replay dropped a capture of \(bytes) bytes over the \(Self.maxPendingBytes) byte buffer")
            return .snapshotDropped
        }
        pending.append(json)
        pendingBytes += bytes
        var droppedBatches = 0
        while pendingBytes > Self.maxPendingBytes, pending.count > 1 {
            pendingBytes -= pending.removeFirst().utf8.count
            droppedBatches += 1
        }
        if droppedBatches > 0 { dropped += 1 }
        let recorder = current
        lock.unlock()
        if droppedBatches > 0 {
            ReplayLog.log("session replay dropped \(droppedBatches) undrained batch(es) over \(Self.maxPendingBytes) bytes")
            // Async: the recorder's lock is held here.
            DispatchQueue.main.async { recorder?.requestCapture(full: true) }
        }
        return .queued
    }

    /// The JS layer owns the session and its expiry.
    func noteActivity() {}

    /// Nothing is written to disk.
    func afterPendingWrites(_ completion: @escaping () -> Void) {
        completion()
    }
}

/// The only sink: every group goes to the host at once (no chunking, no
/// buffer); the JS layer batches what it drains.
final class ReactNativeReplaySink: ReplayEventSink {
    private let context: ReplaySinkContext

    init(context: ReplaySinkContext) {
        self.context = context
    }

    func add(_ group: [ReplayJSON], sessionId: String, distinctId: String, generation: UInt64) {
        guard !group.isEmpty else { return }
        let admission = context.deliver(group, .session, sessionId, distinctId, generation)
        if admission != .queued { context.report(admission, sessionId) }
    }

    func flush() {}

    func discard() {}
}
