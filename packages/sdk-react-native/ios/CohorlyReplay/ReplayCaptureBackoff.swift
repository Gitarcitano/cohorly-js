// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/PostHogReplayCaptureBackoff.swift.
// Changed: renamed; the monotonic clock is injected (seconds) so the policy is tested
// without waiting; compiled on every platform (no UIKit in it); no test-only members.
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

/// The recorder's capture cadence on a still screen. After
/// `unchangedFramesBeforeBackoff` captures in a row that changed nothing,
/// an opportunity is taken only once the idle interval has passed: twice
/// the base interval, doubling with each further unchanged capture up to
/// `maxIdleInterval` (with a 1 s base: captures 1 s, 1 s, 1 s, then 2, 4, 8,
/// 8 s apart). A changed capture, a touch (`wake()`) or a new view
/// structure fingerprint brings it back to the base interval at once, so a
/// still screen gets cheap but never unreachable.
final class ReplayCaptureBackoff: @unchecked Sendable {
    static let unchangedFramesBeforeBackoff = 3
    static let maxIdleInterval: TimeInterval = 8
    private static let maxDoublings = 20
    static let minimumBaseInterval: TimeInterval = 0.05

    private let lock = NSLock()
    private let now: () -> TimeInterval
    private var baseInterval: TimeInterval
    private var unchangedFrames = 0
    private var lastEmit: TimeInterval = 0
    private var lastWalkedStructure: Int?

    /// - Parameter now: a monotonic clock in seconds (`systemUptime`).
    init(baseInterval: TimeInterval = 1, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.baseInterval = max(baseInterval, Self.minimumBaseInterval)
        self.now = now
    }

    /// The verdict of a capture: whether it produced no event.
    func noteFrame(unchanged: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard unchanged else {
            unchangedFrames = 0
            return
        }
        unchangedFrames += 1
        if unchangedFrames == Self.unchangedFramesBeforeBackoff {
            lastEmit = now()
            lastWalkedStructure = nil
        }
    }

    /// Leaves the backoff (a touch, a return to the foreground).
    func wake() {
        lock.lock()
        unchangedFrames = 0
        lock.unlock()
    }

    /// Whether this opportunity is worth a capture. `structure` (a view
    /// structure fingerprint) is read only while backing off; one that
    /// differs from the previous read admits the capture at once and leaves
    /// the backoff, even if that capture then finds nothing to send.
    func shouldCapture(structure: () -> Int? = { nil }) -> Bool {
        guard locked({ isBackingOff }) else { return true }
        // Outside the lock: a capture verdict from the recorder queue never
        // waits on a view walk.
        let fingerprint = structure()
        return locked {
            guard isBackingOff else { return true }
            let baseline = lastWalkedStructure
            lastWalkedStructure = fingerprint
            if baseline != nil, fingerprint != nil, fingerprint != baseline {
                unchangedFrames = 0
                return true
            }
            let current = now()
            guard current - lastEmit >= idleInterval else { return false }
            lastEmit = current
            return true
        }
    }

    /// The interval between captures of a still screen now.
    var currentIdleInterval: TimeInterval { locked { isBackingOff ? idleInterval : baseInterval } }

    var isBackingOffNow: Bool { locked { isBackingOff } }

    private var isBackingOff: Bool {
        unchangedFrames >= Self.unchangedFramesBeforeBackoff
    }

    /// Twice the base at the third unchanged capture, doubling after.
    private var idleInterval: TimeInterval {
        guard isBackingOff else { return baseInterval }
        let doublings = min(unchangedFrames - Self.unchangedFramesBeforeBackoff + 1, Self.maxDoublings)
        return min(baseInterval * pow(2, Double(doublings)), Self.maxIdleInterval)
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
