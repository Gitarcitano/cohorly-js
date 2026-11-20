// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

import Foundation

/// Where the recorder puts the events it builds for one mode (extension
/// point). The recorder asks its sink factory (`ReplaySinkFactory`) once per
/// mode and records only in the modes that got a sink. In the Swift SDK:
/// `.session` (`ReplayChunkBuffer`, chunks for the queue on disk) and
/// `.error` (`ReplayErrorBuffer`, the last seconds in memory, handed to the
/// queue only when an error happens); the React Native bridge has one
/// `.session` sink that hands every group out at once. All calls come from
/// the recorder's serial queue.
protocol ReplayEventSink: AnyObject {
    /// Adds `group` (one Meta + FullSnapshot, a Mutation, a touch) to the
    /// events of `sessionId`, never split from itself. `generation` is the
    /// recorder's consent generation when the group was captured; it goes
    /// back with the events to `ReplaySinkContext.deliver`.
    func add(_ group: [ReplayJSON], sessionId: String, distinctId: String, generation: UInt64)
    /// Hands over what is held now (background, rotation, a mode change).
    func flush()
    /// Drops what is held (opt-out, stop).
    func discard()
    /// An error happened while `sessionId` was live (`$exception`,
    /// `CohorlyReplay.notifyError()`). `distinctId`: who is identified now
    /// (nil = unknown), so an identify since the last capture is not missed.
    func errorOccurred(sessionId: String, distinctId: String?)
}

extension ReplayEventSink {
    /// A sink that sends what it records anyway has nothing to do on an error.
    func errorOccurred(sessionId: String, distinctId: String?) {}
}

/// A delayed run of `work` on the recorder's serial queue.
typealias ReplaySchedule = (_ delay: TimeInterval, _ work: @escaping () -> Void) -> Void

/// What the recorder gives a sink to hand its events on.
struct ReplaySinkContext {
    /// Queues events in `mode`; refused when `generation` is no longer the
    /// recorder's (an opt-out, pause or stop since), when stopped, opted out
    /// or paused by the queue.
    typealias Deliver = (
        _ events: [ReplayJSON], _ mode: ReplayChunkMode, _ sessionId: String, _ distinctId: String, _ generation: UInt64
    ) -> ReplayAdmission

    /// Delayed runs on the recorder's serial queue.
    var schedule: ReplaySchedule
    var deliver: Deliver
    /// Tells the recorder a delivery was not fully queued (`.refused`,
    /// `.snapshotDropped`), so its next capture of that session is full.
    var report: (_ admission: ReplayAdmission, _ sessionId: String) -> Void
    /// Asks the recorder for a Meta + FullSnapshot now (the error buffer's
    /// checkout). Never waits.
    var requestFullSnapshot: () -> Void = {}
    /// Unix ms from the SDK clock, the clock event timestamps come from.
    var nowMs: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
}

/// Builds the sink of a mode, nil for a mode that records nothing.
typealias ReplaySinkFactory = (_ mode: ReplayMode, _ context: ReplaySinkContext) -> ReplayEventSink?

/// A touch as read on the main thread.
struct ReplayTouch: Sendable {
    var kind: ReplayEvents.TouchKind
    var x: Int
    var y: Int
    var timestamp: Int64
    var sessionId: String
    var distinctId: String
    /// The mode of the session when the touch happened (picks the sink).
    var mode: ReplayMode = .session
    /// The recorder's consent generation when the touch happened.
    var generation: UInt64 = 0
}

/// The recorder-queue half of the recorder: captures and touches in,
/// events out to the sink of their mode. Not thread-safe; recorder queue
/// only.
final class ReplayRecordingPipeline {
    static let maxPendingTouches = 20

    let status = ReplayWindowStatus()
    private let sinks: [ReplayMode: ReplayEventSink]
    /// `ReplayRecorderHost.droppedChunks`, read when each capture is admitted.
    private let droppedChunks: () -> Int
    private var seenDroppedChunks: Int?
    private var lastMode: ReplayMode?
    /// Touches of a session whose first full snapshot is not queued yet.
    private var pendingTouches: [ReplayTouch] = []
    /// The session whose Meta + Full snapshot did not fit in a chunk: its
    /// images go without pixels until the session changes, so the next full
    /// snapshot fits instead of being dropped again.
    private var imagesMaskedSession: String?

    init(sinks: [ReplayMode: ReplayEventSink], droppedChunks: @escaping () -> Int = { 0 }) {
        self.sinks = sinks
        self.droppedChunks = droppedChunks
    }

    /// A pipeline recording `.session` into `sink`.
    convenience init(sink: ReplayEventSink, droppedChunks: @escaping () -> Int = { 0 }) {
        self.init(sinks: [.session: sink], droppedChunks: droppedChunks)
    }

    var pendingTouchCount: Int { pendingTouches.count }

    /// Turns `capture` into events for the sink of its mode. Returns false
    /// when the capture changed nothing (no event), which feeds the backoff.
    @discardableResult
    func record(_ capture: ReplayScreenCapture) -> Bool {
        guard let sink = sinks[capture.mode] else { return false }
        var capture = capture
        if let lastMode, lastMode != capture.mode {
            // Another sink from here on: it has no snapshot to build on. The
            // error buffer is dropped (timer included), never sent: only an
            // error sends it, and none can reach it outside error mode.
            if lastMode == .error {
                sinks[lastMode]?.discard()
            } else {
                sinks[lastMode]?.flush()
            }
            capture.forceFull = true
        }
        lastMode = capture.mode
        let dropped = droppedChunks()
        if let seen = seenDroppedChunks, seen != dropped {
            // The queue dropped chunks it had taken: the server may lack the
            // snapshot the next Mutation builds on.
            capture.forceFull = true
        }
        seenDroppedChunks = dropped
        if let masked = imagesMaskedSession {
            if masked == capture.sessionId {
                capture.wireframes = capture.wireframes.withoutImagePixels()
            } else {
                imagesMaskedSession = nil
            }
        }
        let events = status.events(for: capture)
        guard !events.isEmpty else { return false }
        sink.add(events, sessionId: capture.sessionId, distinctId: capture.distinctId, generation: capture.generation)
        if let first = events.first, ReplayEvents.isMeta(first) { releasePendingTouches(after: capture) }
        return true
    }

    /// A touch: queued at once when its session has a full snapshot out,
    /// else kept (the newest `maxPendingTouches`) until that snapshot.
    func touch(_ touch: ReplayTouch) {
        guard let sink = sinks[touch.mode] else { return }
        if status.hasFullSnapshot(touch.sessionId) {
            sink.add([ReplayEvents.touch(touch.kind, x: touch.x, y: touch.y, timestamp: touch.timestamp,
                                         id: status.touchTargetId)],
                     sessionId: touch.sessionId, distinctId: touch.distinctId, generation: touch.generation)
            return
        }
        if pendingTouches.count >= Self.maxPendingTouches { pendingTouches.removeFirst() }
        pendingTouches.append(touch)
    }

    /// A delivery of `sessionId` was not fully queued: the player never got
    /// what the next diff would build on. A dropped full snapshot also
    /// turns that session's images into boxes without pixels.
    func deliveryFailed(_ admission: ReplayAdmission, sessionId: String) {
        if admission == .snapshotDropped { imagesMaskedSession = sessionId }
        if status.sessionId == sessionId { status.reset() }
    }

    func flush() {
        for sink in sinks.values { sink.flush() }
    }

    /// An error while `sessionId` was live: the error sink sends what it holds.
    func errorOccurred(sessionId: String, distinctId: String? = nil) {
        sinks[.error]?.errorOccurred(sessionId: sessionId, distinctId: distinctId)
    }

    /// The session left error mode (to `.off` too, which records nothing):
    /// the error buffer is dropped, timer included.
    func leaveErrorMode() {
        sinks[.error]?.discard()
    }

    /// Forgets the buffers, the screen sent and the waiting touches.
    func discard() {
        for sink in sinks.values { sink.discard() }
        status.reset()
        pendingTouches = []
    }

    private func releasePendingTouches(after capture: ReplayScreenCapture) {
        let waiting = pendingTouches
        // Touches of another session keep waiting for that session's snapshot.
        pendingTouches = waiting.filter { $0.sessionId != capture.sessionId }
        for touch in waiting where touch.sessionId == capture.sessionId {
            guard let sink = sinks[touch.mode] else { continue }
            // Never before the snapshot it lands on.
            let event = ReplayEvents.touch(touch.kind, x: touch.x, y: touch.y,
                                           timestamp: max(touch.timestamp, capture.timestamp),
                                           id: status.touchTargetId)
            sink.add([event], sessionId: capture.sessionId, distinctId: touch.distinctId, generation: touch.generation)
        }
    }
}
