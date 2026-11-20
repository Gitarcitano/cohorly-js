// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/ApplicationRunLoopPublisher.swift and the trailing path of
// PostHogThrottledMulticastCallback (PostHog/Utils/PostHogMulticastCallback.swift).
// Changed: one subscriber (the recorder) instead of a multicast, so the observer is
// installed and removed by its owner instead of by subscriber count; the throttle is a
// separate type with an injected clock and delayed-run function (tested without the main
// run loop); the background check is the owner's (`isEnabled`), not a DI publisher.
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

import CoreFoundation
import Foundation

/// Runs `handler` at most once per `interval`, always at the end of a window
/// (trailing): the first call is delivered on the next turn (no earlier
/// than `interval` after the previous delivery), calls before that delivery
/// add nothing, since the handler reads the state of its own moment. The
/// next window starts at delivery, not at scheduling, so a busy main thread
/// never fires two captures back to back. No call, no delivery.
///
/// Not thread-safe: the recorder uses it on the main thread only.
final class ReplayThrottle {
    typealias Schedule = (_ delay: TimeInterval, _ work: @escaping () -> Void) -> Void

    let interval: TimeInterval
    private let now: () -> TimeInterval
    private let schedule: Schedule
    private let handler: () -> Void
    private var lastFired: TimeInterval?
    private var pending = false
    /// Bumped by `cancel()`: a delivery scheduled before it does nothing.
    private var generation: UInt64 = 0

    /// - Parameters:
    ///   - now: a monotonic clock in seconds.
    ///   - schedule: runs `work` after `delay` seconds (the main queue on a device).
    init(interval: TimeInterval, now: @escaping () -> TimeInterval, schedule: @escaping Schedule, handler: @escaping () -> Void) {
        self.interval = interval
        self.now = now
        self.schedule = schedule
        self.handler = handler
    }

    var isPending: Bool { pending }

    func invoke() {
        guard !pending else { return }
        pending = true
        let elapsed = lastFired.map { now() - $0 } ?? .infinity
        let delay = max(0, interval - elapsed)
        let armed = generation
        schedule(delay) { [weak self] in
            guard let self, armed == self.generation else { return }
            self.pending = false
            self.lastFired = self.now()
            self.handler()
        }
    }

    /// Drops a pending delivery.
    func cancel() {
        generation &+= 1
        pending = false
    }
}

/// Offers a capture opportunity once per main run loop cycle that did
/// work, after Core Animation's commit, so nothing has to swizzle layout to
/// learn that the screen may have changed. With the run loop asleep (a still
/// screen, nothing scheduled) there is no opportunity and no capture; a
/// cycle that only ran the recorder's own capture is not one either
/// (`ignoreCurrentCycle()`).
///
/// An opportunity is a hint, not proof of a new frame: the throttle and the
/// backoff behind `onOpportunity` decide. Main thread only.
final class ReplayRunLoopObserver {
    private var observer: CFRunLoopObserver?
    private var didConsiderCurrentCycle = false
    /// The current cycle was woken by the recorder's own throttled capture.
    private var skipCurrentCycle = false
    private let onOpportunity: () -> Void

    init(onOpportunity: @escaping () -> Void) {
        self.onOpportunity = onOpportunity
    }

    deinit {
        // The run loop retains the observer: it outlives this object unless
        // invalidated, which also removes it from every run loop.
        if let observer { CFRunLoopObserverInvalidate(observer) }
    }

    var isObserving: Bool { observer != nil }

    func start() {
        guard observer == nil else { return }
        didConsiderCurrentCycle = false
        // Core Animation's commit observer has order 2_000_000; a larger
        // order runs after it in practice (not a documented guarantee, so
        // nothing depends on it for correctness).
        let activities: CFRunLoopActivity = [.afterWaiting, .beforeWaiting, .exit]
        guard let created = CFRunLoopObserverCreateWithHandler(
            nil, activities.rawValue, true, 2_100_000, { [weak self] _, activity in
                self?.handle(activity)
            })
        else {
            ReplayLog.log("session replay could not observe the main run loop; nothing will be recorded")
            return
        }
        observer = created
        // Common modes, so scrolling and gestures (tracking mode) count too.
        CFRunLoopAddObserver(CFRunLoopGetMain(), created, .commonModes)
    }

    /// The cycle running now only delivered the recorder's own capture: it
    /// offers no opportunity. Without this, every delivery would wake the
    /// run loop for the next one, a 1 s timer by another name, and a still
    /// screen would keep being captured (PostHog relies on that wake-up;
    /// here a still run loop means no capture).
    func ignoreCurrentCycle() {
        skipCurrentCycle = true
    }

    func stop() {
        guard let observer else { return }
        self.observer = nil
        didConsiderCurrentCycle = false
        CFRunLoopObserverInvalidate(observer)
    }

    private func handle(_ activity: CFRunLoopActivity) {
        // Waking up starts a cycle; `.beforeWaiting` and `.exit` can both
        // land in one, and the flag keeps it to one opportunity.
        if activity.contains(.afterWaiting) {
            didConsiderCurrentCycle = false
            return
        }
        guard !didConsiderCurrentCycle else { return }
        didConsiderCurrentCycle = true
        if skipCurrentCycle {
            skipCurrentCycle = false
            return
        }
        onOpportunity()
    }
}
