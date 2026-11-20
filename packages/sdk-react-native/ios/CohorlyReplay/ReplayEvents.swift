// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

import Foundation

/// Builds the rrweb-envelope events of the mobile replay format
/// (docs/SESSION-REPLAY.md "Events"). Pure: the recorder queue turns a
/// capture into these.
enum ReplayEvents {
    enum EventType: Int {
        case fullSnapshot = 2
        case incrementalSnapshot = 3
        case meta = 4
        case custom = 5
    }

    enum TouchKind: Int, Sendable {
        case start = 7
        case end = 9
    }

    /// Meta: the screen size in points and its name.
    static func meta(width: Int, height: Int, href: String, timestamp: Int64) -> ReplayJSON {
        var data: [String: ReplayJSON] = ["width": .int(width), "height": .int(height)]
        if !href.isEmpty { data["href"] = .string(href) }
        return envelope(.meta, data: data, timestamp: timestamp)
    }

    static func fullSnapshot(_ wireframes: [ReplayWireframe], timestamp: Int64) -> ReplayJSON {
        envelope(.fullSnapshot, data: [
            "wireframes": .array(wireframes.map(\.json)),
            "initialOffset": .object(["top": .int(0), "left": .int(0)])
        ], timestamp: timestamp)
    }

    /// A Mutation (`source: 0`), nil when all three lists are empty. Empty
    /// lists are left out.
    static func mutation(
        adds: [ReplayWireframe], updates: [ReplayWireframe], removes: [ReplayWireframe], timestamp: Int64
    ) -> ReplayJSON? {
        guard !(adds.isEmpty && updates.isEmpty && removes.isEmpty) else { return nil }
        var data: [String: ReplayJSON] = ["source": .int(0)]
        if !adds.isEmpty {
            data["adds"] = .array(adds.map { .object(["parentId": .int($0.parentId), "wireframe": $0.json]) })
        }
        if !updates.isEmpty {
            data["updates"] = .array(updates.map { .object(["parentId": .int($0.parentId), "wireframe": $0.json]) })
        }
        if !removes.isEmpty {
            data["removes"] = .array(removes.map { .object(["parentId": .int($0.parentId), "id": .int($0.id)]) })
        }
        return envelope(.incrementalSnapshot, data: data, timestamp: timestamp)
    }

    /// A touch start or end at `x`, `y` (points from the window's top left)
    /// on the wireframe `id`: 0 (the player maps it to the screen root), or
    /// the screenshot in screenshot mode.
    static func touch(_ kind: TouchKind, x: Int, y: Int, timestamp: Int64, id: Int = 0) -> ReplayJSON {
        envelope(.incrementalSnapshot, data: [
            "source": .int(2),
            "type": .int(kind.rawValue),
            "id": .int(id),
            "x": .int(x),
            "y": .int(y),
            "pointerType": .int(2)
        ], timestamp: timestamp)
    }

    /// A Custom event (`type: 5`) `{ tag, payload }`.
    static func custom(tag: String, payload: [String: ReplayJSON] = [:], timestamp: Int64) -> ReplayJSON {
        envelope(.custom, data: ["tag": .string(tag), "payload": .object(payload)], timestamp: timestamp)
    }

    static func timestamp(of event: ReplayJSON) -> Int64? {
        guard case .object(let object) = event, case .int(let timestamp)? = object["timestamp"] else { return nil }
        return Int64(timestamp)
    }

    /// `event` with its `timestamp` replaced.
    static func restamped(_ event: ReplayJSON, at timestamp: Int64) -> ReplayJSON {
        guard case .object(var object) = event else { return event }
        object["timestamp"] = .int(Int(clamping: timestamp))
        return .object(object)
    }

    static func type(of event: ReplayJSON) -> Int? {
        guard case .object(let object) = event, case .int(let type)? = object["type"] else { return nil }
        return type
    }

    static func isMeta(_ event: ReplayJSON) -> Bool { type(of: event) == EventType.meta.rawValue }

    private static func envelope(_ type: EventType, data: [String: ReplayJSON], timestamp: Int64) -> ReplayJSON {
        .object([
            "type": .int(type.rawValue),
            "timestamp": .int(Int(clamping: timestamp)),
            "data": .object(data)
        ])
    }
}

struct ReplayWireframeDiff {
    var adds: [ReplayWireframe]
    var removes: [ReplayWireframe]
    var updates: [ReplayWireframe]
}

/// The added, removed and updated wireframes from `old` to `new`, by id.
/// An update is a wireframe whose own fields (children aside) changed: a
/// changed child is its own update.
func replayWireframeDiff(old: [ReplayWireframe], new: [ReplayWireframe]) -> ReplayWireframeDiff {
    let oldItems = old.flattened()
    let newItems = new.flattened()
    var oldById: [Int: ReplayWireframe] = [:]
    for item in oldItems { oldById[item.id] = item }
    let newIds = Set(newItems.map(\.id))
    var adds: [ReplayWireframe] = []
    var updates: [ReplayWireframe] = []
    for item in newItems {
        guard let previous = oldById[item.id] else {
            adds.append(item)
            continue
        }
        if previous.ownFields != item.ownFields { updates.append(item) }
    }
    let removes = oldItems.filter { !newIds.contains($0.id) }
    return ReplayWireframeDiff(adds: adds, removes: removes, updates: updates)
}

/// One capture of the screen, built on the main thread by a
/// `ReplaySnapshotSource` and stamped by the recorder.
struct ReplayScreenCapture: Sendable {
    var sessionId: String
    var distinctId: String
    var timestamp: Int64
    var width: Int
    var height: Int
    /// The screen name (Meta `href`).
    var href: String
    /// Identifies the window: another one means a full snapshot.
    var windowKey: Int
    var wireframes: [ReplayWireframe]
    /// A full snapshot whatever the diff says (return from background, a
    /// pause in recording).
    var forceFull: Bool
    /// The mode of the session when captured (picks the sink).
    var mode: ReplayMode = .session
    /// The recorder's consent generation when captured.
    var generation: UInt64 = 0
}
