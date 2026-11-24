// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/PostHogReplayIntegration.swift, the wireframe path only (startRecording /
// stopRecording, startCaptureScheduler, snapshot, captureSnapshot, handleApplicationEvent).
// Changed: driven by the Cohorly replay runtime (its session, mode and chunk queue) instead
// of PostHog's session manager and `$snapshot` events; one recorded window; Meta +
// FullSnapshot on every new session, window, screen, return from background and dropped
// chunk, else a Mutation by wireframe id; touches wait for their session's first full
// snapshot; the capture source and the event sinks (one per mode) are protocols (screenshot
// mode and the error buffer plug in there, VEL-2140); a consent generation keeps captures and touches
// of before an opt-out, pause or stop out of the queue; background drains what was admitted. Not copied: GPU capture, inline masks, glass stand-in,
// portals, presentation covers, mask settle, network and console plugins, remote config,
// `minimumDuration`, event triggers.
//
// Copyright (c) 2023 PostHog. Licensed under the MIT License:
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

import Foundation
#if os(iOS)
import UIKit
#endif

/// The live session as the recorder sees it, read in one step.
struct ReplayRecordingState: Equatable, Sendable {
    /// What the session records now (Swift SDK: `ReplayRuntime.effectiveMode`).
    var mode: ReplayMode
    var sessionId: String
    var distinctId: String
}

/// What the recorder needs from whoever owns the session (the Swift SDK's
/// `ReplayRuntime`, the React Native bridge, a fake in tests).
protocol ReplayRecorderHost: AnyObject {
    func recordingState() -> ReplayRecordingState
    /// How many delivered chunks the host has dropped since it started (a
    /// change makes the next capture full), read on the recorder's queue.
    var droppedChunks: Int { get }
    /// Unix ms from the SDK clock.
    var nowMs: Int64 { get }
    /// Queues events of `sessionId` (the live session or one rotated out
    /// since) in `mode`.
    func enqueueRecorded(_ events: [ReplayJSON], mode: ReplayChunkMode, sessionId: String, distinctId: String) -> ReplayAdmission
    /// A recorded activity (a touch, a capture that changed the screen):
    /// the session's expiry rule runs as for a tracked event.
    func noteActivity()
    /// Runs `completion` once every chunk queued before is written to disk.
    func afterPendingWrites(_ completion: @escaping () -> Void)
}

/// The screen as a capture source sees it: one window.
struct ReplaySourceFrame: Sendable {
    /// Identifies the window (a full snapshot when it changes).
    var windowKey: Int
    /// The window size in points (Meta `width` / `height`).
    var width: Int
    var height: Int
    /// The screen name: the class name of the view controller on top.
    var href: String
    var wireframes: [ReplayWireframe]
}

/// Where a capture comes from (extension point). `WireframeSnapshotSource`
/// walks the `UIView` tree; `ScreenshotSnapshotSource` (screenshot mode)
/// returns one `screenshot` wireframe of the masked window. Main thread.
protocol ReplaySnapshotSource: AnyObject {
    /// The app is in the foreground with a window to record.
    func isInForeground() -> Bool
    /// The screen now, or nil (no window).
    func captureFrame() -> ReplaySourceFrame?
    /// A cheap summary of the view structure that changes when the screen
    /// may have (the backoff's way out of a still screen); nil if unknown.
    func structureFingerprint() -> Int?
}

/// A touch start or end in points from the window's top left.
struct ReplayRawTouch: Sendable {
    var kind: ReplayEvents.TouchKind
    var x: Double
    var y: Double
    /// `ReplaySourceFrame.windowKey` of the touch's window; nil if unknown.
    var windowKey: Int?
    /// The touch's window is the one a capture records now (the key
    /// window); nil if unknown.
    var isKeyWindow: Bool?
}

/// Where touches come from (the `UIApplication.sendEvent` swizzle on iOS).
protocol ReplayTouchSource: AnyObject {
    /// `handler` runs on the main thread, before UIKit dispatches the event.
    func start(_ handler: @escaping ([ReplayRawTouch]) -> Void)
    func stop()
}

/// Starts a background task named `name` (iOS: `beginBackgroundTask`) and
/// returns the closure that ends it, safe to call more than once and from
/// any thread.
typealias ReplayBackgroundTaskStarter = (_ name: String) -> () -> Void

/// The session replay recorder. Created and owned by its host (the Swift
/// SDK's `ReplayRuntime` on a successful `install`, the React Native bridge
/// on `replayStart`), stopped with it.
///
/// - **One way to ask for a capture**: `requestCapture(full:)`, used by the
///   run loop observer (every cycle that did work), touches and the app
///   lifecycle. Requests go through one trailing throttle (`ReplayThrottle`,
///   1 s): never two captures less than a second apart. A capture that is
///   not forced full asks the backoff (`ReplayCaptureBackoff`) first, so a
///   still screen is captured less and less often (up to every 8 s).
/// - **Mode**: the sink factory gives each mode its sink; only a mode with
///   one records (`.session`: chunks; `.error`: the error buffer, sent by
///   `noteError()`). Other modes capture nothing, make the next capture full
///   and flush what the old mode held.
/// - **Consent generation**: bumped by start, stop, opt-out and opt-in.
///   Every capture and touch carries the generation of its moment; the
///   worker drops one of an older generation, and the queue admits events
///   only under the lock that guards the generation, so nothing read before
///   an opt-out reaches the queue after it.
/// - **Threads**: the view walk on the main thread (the source); the diff,
///   events, JSON and enqueue on `worker`, a serial queue. Nothing on the
///   main thread waits for the disk.
final class ReplayRecorder: @unchecked Sendable {
    static let throttleInterval: TimeInterval = 1

    private weak var host: ReplayRecorderHost?
    private let source: ReplaySnapshotSource
    private let touchSource: ReplayTouchSource?
    private let worker: DispatchQueue
    private let backoff: ReplayCaptureBackoff
    private let monotonicNow: () -> TimeInterval
    private let beginBackgroundTask: ReplayBackgroundTaskStarter
    /// The modes that have a sink; set in `init`, read anywhere.
    private var recordableModes: Set<ReplayMode> = []
    // Worker only.
    private var pipeline: ReplayRecordingPipeline!
    // Main thread only.
    private var throttle: ReplayThrottle!
    private var runLoopObserver: ReplayRunLoopObserver?
    private let observesRunLoop: Bool
    /// The window of the last capture: touches of other windows are left out.
    private var recordedWindowKey: Int?

    private let lock = NSLock()
    private var started = false
    private var stopped = false
    /// Opt-out: no trigger, nothing held.
    private var paused = false
    private var inBackground = false
    /// The next capture is Meta + FullSnapshot.
    private var needsFull = true
    private var generation: UInt64 = 0
    /// When the last request came (monotonic): a refused capture re-arms
    /// itself only up to `ReplayCaptureBackoff.maxIdleInterval` after it.
    private var lastRequestAt: TimeInterval = -.infinity
    private var lastMode: ReplayMode?

    /// - Parameters:
    ///   - observesRunLoop: install the main run loop observer (off in tests
    ///     that drive `requestCapture` themselves).
    ///   - monotonicNow: seconds, for the throttle and the backoff.
    ///   - schedule: main-thread delayed runs of the throttle.
    ///   - sinks: the sink of each mode (asked once per mode, here).
    ///   - beginBackgroundTask: covers the flush on the way to the background.
    init(
        host: ReplayRecorderHost,
        source: ReplaySnapshotSource,
        touchSource: ReplayTouchSource?,
        observesRunLoop: Bool = true,
        worker: DispatchQueue = DispatchQueue(label: "com.cohorly.replay.recorder"),
        monotonicNow: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        schedule: @escaping ReplayThrottle.Schedule = { delay, work in
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        },
        sinks factory: ReplaySinkFactory,
        beginBackgroundTask: @escaping ReplayBackgroundTaskStarter = ReplayRecorder.systemBackgroundTask
    ) {
        self.host = host
        self.source = source
        self.touchSource = touchSource
        self.observesRunLoop = observesRunLoop
        self.worker = worker
        self.monotonicNow = monotonicNow
        self.beginBackgroundTask = beginBackgroundTask
        backoff = ReplayCaptureBackoff(baseInterval: Self.throttleInterval, now: monotonicNow)
        let context = ReplaySinkContext(
            schedule: { delay, work in worker.asyncAfter(deadline: .now() + delay, execute: work) },
            deliver: { [weak self] events, mode, sessionId, distinctId, generation in
                self?.admit(events, mode: mode, sessionId: sessionId, distinctId: distinctId, generation: generation) ?? .refused
            },
            report: { [weak self] admission, sessionId in
                self?.pipeline.deliveryFailed(admission, sessionId: sessionId)
            },
            requestFullSnapshot: { [weak self] in self?.requestCapture(full: true) },
            nowMs: { [weak host] in host?.nowMs ?? 0 })
        var sinks: [ReplayMode: ReplayEventSink] = [:]
        for mode in [ReplayMode.session, .error] {
            if let sink = factory(mode, context) { sinks[mode] = sink }
        }
        recordableModes = Set(sinks.keys)
        pipeline = ReplayRecordingPipeline(sinks: sinks) { [weak self] in self?.host?.droppedChunks ?? 0 }
        throttle = ReplayThrottle(interval: Self.throttleInterval, now: monotonicNow, schedule: schedule) { [weak self] in
            self?.performCapture()
        }
    }

    /// `beginBackgroundTask` on iOS; nothing elsewhere.
    static let systemBackgroundTask: ReplayBackgroundTaskStarter = { name in
        #if os(iOS)
        let handle = ReplayBackgroundTaskHandle()
        let identifier = UIApplication.shared.beginBackgroundTask(withName: name) { handle.end() }
        handle.started(identifier)
        return { handle.end() }
        #else
        return {}
        #endif
    }

    private var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    /// True while `generation` is the live one and the recorder runs.
    private func isCurrent(_ generation: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !stopped && generation == self.generation
    }

    // MARK: - Lifecycle (any thread)

    /// Starts following the screen. A no-op once stopped.
    func start() {
        lock.lock()
        guard !stopped, !started else {
            lock.unlock()
            return
        }
        started = true
        needsFull = true
        generation &+= 1
        let paused = self.paused
        lock.unlock()
        if !paused { setTriggers(active: true) }
        requestCapture(full: true)
    }

    /// Stops for good: triggers removed, buffer and waiting touches dropped,
    /// nothing queued after this returns. Never call it on `worker`.
    func stop() {
        lock.lock()
        let wasStopped = stopped
        stopped = true
        generation &+= 1
        lock.unlock()
        guard !wasStopped else { return }
        setTriggers(active: false)
        worker.sync { pipeline.discard() }
    }

    /// Opt-out (`true`): triggers removed, buffer and waiting touches
    /// dropped. Opt-in (`false`): back, from a full snapshot (the runtime
    /// rotated the session first). Either way nothing captured before
    /// reaches the queue after.
    func setPaused(_ value: Bool) {
        lock.lock()
        guard !stopped, paused != value else {
            lock.unlock()
            return
        }
        paused = value
        needsFull = true
        generation &+= 1
        let started = self.started
        lock.unlock()
        if value {
            setTriggers(active: false)
            worker.async { self.pipeline.discard() }
        } else if started {
            setTriggers(active: true)
            requestCapture(full: true)
        }
    }

    /// The app went to the background: no new capture is admitted; the
    /// captures and touches already admitted are recorded, the buffers
    /// flushed and their chunks written to disk, under a background task.
    func didEnterBackground() {
        lock.lock()
        inBackground = true
        needsFull = true
        lock.unlock()
        onMain { $0.throttle.cancel() }
        let endTask = beginBackgroundTask("CohorlyReplay flush")
        worker.async { [weak self] in
            guard let self, let host = self.host else {
                endTask()
                return
            }
            self.pipeline.flush()
            host.afterPendingWrites(endTask)
        }
    }

    /// Back in the foreground: the next capture is Meta + FullSnapshot.
    func willEnterForeground() {
        lock.lock()
        inBackground = false
        lock.unlock()
        backoff.wake()
        requestCapture(full: true)
    }

    /// The runtime rotated the session: what the old one holds goes to the
    /// queue now, and the new one starts from a full snapshot.
    func sessionDidRotate() {
        worker.async { [weak self] in self?.pipeline.flush() }
        requestCapture(full: true)
    }

    /// An error happened (`$exception` tracked, `CohorlyReplay.notifyError()`)
    /// in `sessionId` (the `$session_id` stamped on the event; nil = the live
    /// session). In error mode the buffer of that session goes out: now, once
    /// 5 s after the previous send, or at that session's first snapshot when
    /// the buffer holds none yet; in any other mode nothing happens (session
    /// mode sends anyway). Any thread; never waits: the checks run on
    /// `worker`, so the caller (the SDK queue) never takes `lock`, which
    /// `admit` holds across a disk write.
    func noteError(sessionId: String? = nil) {
        worker.async { [weak self] in
            guard let self, self.recordableModes.contains(.error) else { return }
            self.lock.lock()
            let active = self.started && !self.stopped && !self.paused
            self.lock.unlock()
            guard active, let host = self.host else { return }
            let state = host.recordingState()
            guard state.mode == .error else { return }
            let target = sessionId ?? state.sessionId
            self.pipeline.errorOccurred(
                sessionId: target, distinctId: target == state.sessionId ? state.distinctId : nil)
        }
    }

    // MARK: - Capture

    /// The one way to ask for a capture (run loop, touches, lifecycle, a new
    /// session). `full`: the next capture is Meta + FullSnapshot and skips
    /// the backoff. Any thread; captures run on the main thread through the
    /// throttle.
    func requestCapture(full: Bool) {
        lock.lock()
        if full { needsFull = true }
        let active = started && !stopped && !paused && !inBackground
        if active { lastRequestAt = monotonicNow() }
        lock.unlock()
        guard active, let host else { return }
        // Checked here so a session that does not record costs no capture
        // and no throttle wake-up on every run loop cycle.
        let state = host.recordingState()
        let mode = state.mode
        noteMode(mode, sessionId: state.sessionId)
        guard recordableModes.contains(mode) else {
            markNeedsFull()
            return
        }
        if full { backoff.wake() }
        onMain { $0.throttle.invoke() }
    }

    /// Main thread, from the throttle.
    private func performCapture() {
        // This delivery woke the run loop: that cycle is not a new opportunity.
        runLoopObserver?.ignoreCurrentCycle()
        lock.lock()
        let active = started && !stopped && !paused && !inBackground
        let force = needsFull
        let generation = self.generation
        let lastRequestAt = self.lastRequestAt
        lock.unlock()
        guard active, let host else { return }
        let state = host.recordingState()
        noteMode(state.mode, sessionId: state.sessionId)
        guard recordableModes.contains(state.mode), source.isInForeground() else {
            markNeedsFull()
            return
        }
        if !force, !backoff.shouldCapture(structure: { [source] in source.structureFingerprint() }) {
            // Something asked for this capture: try again until the backoff
            // takes one, so the last state of a screen that then goes still
            // is never left out. The backoff takes one at most
            // `maxIdleInterval` after the last request, so the chain stops
            // there whatever happens.
            if monotonicNow() - lastRequestAt <= ReplayCaptureBackoff.maxIdleInterval { throttle.invoke() }
            return
        }
        guard let frame = source.captureFrame() else { return }
        recordedWindowKey = frame.windowKey
        lock.lock()
        needsFull = false
        lock.unlock()
        let capture = ReplayScreenCapture(
            sessionId: state.sessionId, distinctId: state.distinctId, timestamp: host.nowMs,
            width: frame.width, height: frame.height, href: frame.href, windowKey: frame.windowKey,
            wireframes: frame.wireframes, forceFull: force, mode: state.mode, generation: generation)
        worker.async { [weak self] in
            // Admitted before a background is still recorded; one from
            // before an opt-out, pause or stop is not.
            guard let self, self.isCurrent(generation) else { return }
            let changed = self.pipeline.record(capture)
            self.backoff.noteFrame(unchanged: !changed)
            if changed { self.host?.noteActivity() }
        }
    }

    /// Main thread, from the touch source.
    private func handleTouches(_ touches: [ReplayRawTouch]) {
        lock.lock()
        let active = started && !stopped && !paused && !inBackground
        let generation = self.generation
        lock.unlock()
        let recordedWindow = recordedWindowKey
        let ofRecordedWindow = touches.filter { Self.isOfRecordedWindow($0, recordedWindowKey: recordedWindow) }
        guard !ofRecordedWindow.isEmpty, active, let host else { return }
        // First: a touch after the session expired belongs to the new one.
        host.noteActivity()
        let state = host.recordingState()
        noteMode(state.mode, sessionId: state.sessionId)
        // A touch in a mode with no sink is not recorded.
        guard recordableModes.contains(state.mode) else { return }
        let timestamp = host.nowMs
        let recorded = ofRecordedWindow.compactMap { touch -> ReplayTouch? in
            guard let x = ReplayUtil.toInt(touch.x), let y = ReplayUtil.toInt(touch.y) else { return nil }
            return ReplayTouch(kind: touch.kind, x: x, y: y, timestamp: timestamp,
                               sessionId: state.sessionId, distinctId: state.distinctId,
                               mode: state.mode, generation: generation)
        }
        backoff.wake()
        requestCapture(full: false)
        worker.async { [weak self] in
            guard let self, self.isCurrent(generation) else { return }
            for touch in recorded { self.pipeline.touch(touch) }
        }
    }

    /// Whether `touch` lands on the window the recording shows. Once a frame
    /// was captured, only touches of that window (`recordedWindowKey`) count.
    /// Before the first frame, only touches of the key window, the one the
    /// first capture will record: a touch of an alert or keyboard window
    /// then is left out too. A touch whose window is unknown (no
    /// `windowKey`, or before the first frame no `isKeyWindow`) is kept, as
    /// it was before windows were told apart.
    static func isOfRecordedWindow(_ touch: ReplayRawTouch, recordedWindowKey: Int?) -> Bool {
        guard let key = touch.windowKey else { return true }
        guard let recordedWindowKey else { return touch.isKeyWindow ?? true }
        return key == recordedWindowKey
    }

    /// Worker, from a sink: queues events of `generation` only while it is
    /// the live one. The check and the enqueue happen under `lock`, so an
    /// opt-out, pause or stop lands either before (refused) or after (and
    /// then the runtime's opt-out discards the queue).
    private func admit(
        _ events: [ReplayJSON], mode: ReplayChunkMode, sessionId: String, distinctId: String, generation: UInt64
    ) -> ReplayAdmission {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped, generation == self.generation, let host else { return .refused }
        return host.enqueueRecorded(events, mode: mode, sessionId: sessionId, distinctId: distinctId)
    }

    /// Flushes what the previous mode held when the live session
    /// (`sessionId`) leaves it (to `.off`, `.error`, or back). Leaving error
    /// mode for session mode sends that session's error buffer first.
    private func noteMode(_ mode: ReplayMode, sessionId: String) {
        lock.lock()
        let previous = lastMode
        lastMode = mode
        lock.unlock()
        guard let previous, previous != mode else { return }
        worker.async { [weak self] in
            guard let self else { return }
            if previous == .error { self.pipeline.leaveErrorMode(to: mode, sessionId: sessionId) }
            self.pipeline.flush()
        }
    }

    private func markNeedsFull() {
        lock.lock()
        needsFull = true
        lock.unlock()
    }

    private func setTriggers(active: Bool) {
        if active {
            touchSource?.start { [weak self] touches in self?.handleTouches(touches) }
        } else {
            touchSource?.stop()
        }
        onMain { recorder in
            if active, !recorder.isStopped {
                if recorder.observesRunLoop {
                    if recorder.runLoopObserver == nil {
                        recorder.runLoopObserver = ReplayRunLoopObserver { [weak recorder] in
                            recorder?.requestCapture(full: false)
                        }
                    }
                    recorder.runLoopObserver?.start()
                }
            } else {
                recorder.runLoopObserver?.stop()
                recorder.throttle.cancel()
            }
        }
    }

    private func onMain(_ body: @escaping (ReplayRecorder) -> Void) {
        if Thread.isMainThread {
            body(self)
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                body(self)
            }
        }
    }

    // MARK: - Tests

    /// Returns once everything queued on the worker before it has run.
    func drainWorker() {
        worker.sync {}
    }
}

#if os(iOS)
/// One `beginBackgroundTask`, ended once: by the flush or by expiry,
/// whichever comes first.
private final class ReplayBackgroundTaskHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var identifier: UIBackgroundTaskIdentifier = .invalid
    private var ended = false

    func started(_ id: UIBackgroundTaskIdentifier) {
        lock.lock()
        guard !ended else {
            lock.unlock()
            if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
            return
        }
        identifier = id
        lock.unlock()
    }

    func end() {
        lock.lock()
        guard !ended else {
            lock.unlock()
            return
        }
        ended = true
        let id = identifier
        identifier = .invalid
        lock.unlock()
        if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
    }
}
#endif
