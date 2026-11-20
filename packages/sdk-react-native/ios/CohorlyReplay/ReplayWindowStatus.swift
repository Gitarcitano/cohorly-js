// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/ViewTreeSnapshotStatus.swift (sentMetaEvent, sentFullSnapshot, the last
// snapshot of a window). The decision rules and the diff follow the Android recorder of this
// repo (sdks/android/cohorly-replay, internal/ViewTreeSnapshotStatus.kt), itself adapted from
// posthog-android.
// Changed: one status for the recorded window; it keeps the wireframes last sent and turns a
// capture into Meta + FullSnapshot or one Mutation (the diff by wireframe id), or nothing;
// no image hash, keyboard or screenshot state.
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

/// What the recorder last sent for the screen, and the step from it to a
/// new capture. Recorder queue only.
///
/// Meta + FullSnapshot when: nothing was sent yet (or `reset()`), the
/// session changed (a rotation, opt-in), the window changed, the screen
/// changed (`href`, size), the capture forces it (return from background,
/// a pause), the tree was reshaped (a view kept under another parent or
/// children in another order, which a Mutation cannot say), or an added or
/// updated view overlaps a later sibling (the player appends it on top of
/// them). Otherwise one Mutation with the diff, or nothing.
final class ReplayWindowStatus {
    private(set) var sessionId: String?
    private var screenKey: ScreenKey?
    private var lastSnapshot: [ReplayWireframe]?

    private struct ScreenKey: Equatable {
        var windowKey: Int
        var href: String
        var width: Int
        var height: Int
    }

    /// The next capture is sent whole.
    func reset() {
        sessionId = nil
        screenKey = nil
        lastSnapshot = nil
    }

    /// True once a full snapshot of `sessionId` was sent, so incremental
    /// events of that session may follow.
    func hasFullSnapshot(_ sessionId: String) -> Bool {
        self.sessionId == sessionId && lastSnapshot != nil
    }

    /// The wireframe id touches carry: the screenshot's when the last
    /// snapshot is one (screenshot mode, as on Android), else 0 (the player
    /// maps it to the screen root).
    var touchTargetId: Int {
        guard let snapshot = lastSnapshot, snapshot.count == 1, let only = snapshot.first,
              only.type == ReplayWireframe.screenshotType
        else { return 0 }
        return only.id
    }

    /// The events `capture` turns into; empty when nothing changed.
    func events(for capture: ReplayScreenCapture) -> [ReplayJSON] {
        let key = ScreenKey(windowKey: capture.windowKey, href: capture.href, width: capture.width, height: capture.height)
        let previous = lastSnapshot
        let wireframes = capture.wireframes
        var full = capture.forceFull || previous == nil || sessionId != capture.sessionId || screenKey != key
        var diff: ReplayWireframeDiff?
        if !full, let previous {
            let computed = replayWireframeDiff(old: previous, new: wireframes)
            diff = computed
            full = Self.reshaped(previous, wireframes)
                || Self.coversLaterSibling(computed.adds + computed.updates, in: wireframes)
        }
        sessionId = capture.sessionId
        screenKey = key
        lastSnapshot = wireframes
        if full {
            return [
                ReplayEvents.meta(width: capture.width, height: capture.height, href: capture.href, timestamp: capture.timestamp),
                ReplayEvents.fullSnapshot(wireframes, timestamp: capture.timestamp)
            ]
        }
        guard let diff,
              let mutation = ReplayEvents.mutation(
                adds: diff.adds, updates: diff.updates, removes: diff.removes, timestamp: capture.timestamp)
        else { return [] }
        return [mutation]
    }

    /// True when a view kept between `old` and `new` has another parent, or
    /// the views a parent kept are in another order.
    static func reshaped(_ old: [ReplayWireframe], _ new: [ReplayWireframe]) -> Bool {
        let oldShape = Shape(old)
        let newShape = Shape(new)
        for (id, parent) in newShape.parents {
            if let oldParent = oldShape.parents[id], oldParent != parent { return true }
        }
        for (parent, children) in newShape.children {
            guard let oldChildren = oldShape.children[parent] else { continue }
            let kept = children.filter { oldShape.parents[$0] != nil }
            let oldKept = oldChildren.filter { newShape.parents[$0] != nil }
            if kept != oldKept { return true }
        }
        return false
    }

    /// True when one of `changed` has a later sibling in `windows` whose
    /// rectangle intersects its own: the player applies an update as remove
    /// + add and an add at the end of its parent, so the view would be drawn
    /// over siblings it is below.
    static func coversLaterSibling(_ changed: [ReplayWireframe], in windows: [ReplayWireframe]) -> Bool {
        guard !changed.isEmpty else { return false }
        var places: [Int: (siblings: [ReplayWireframe], index: Int)] = [:]
        func walk(_ list: [ReplayWireframe]) {
            for (index, item) in list.enumerated() {
                places[item.id] = (list, index)
                if let children = item.childWireframes { walk(children) }
            }
        }
        walk(windows)
        return changed.contains { node in
            guard let place = places[node.id] else { return false }
            return place.siblings[(place.index + 1)...].contains { node.intersects($0) }
        }
    }

    private struct Shape {
        var parents: [Int: Int] = [:]
        var children: [Int: [Int]] = [:]

        init(_ windows: [ReplayWireframe]) {
            walk(windows, parent: ReplayWireframe.screenRootId)
        }

        private mutating func walk(_ list: [ReplayWireframe], parent: Int) {
            for item in list {
                parents[item.id] = parent
                children[parent, default: []].append(item.id)
                if let childWireframes = item.childWireframes { walk(childWireframes, parent: item.id) }
            }
        }
    }
}
