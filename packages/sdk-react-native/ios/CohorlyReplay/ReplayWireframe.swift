// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/RRWireframe.swift and PostHog/Replay/RRStyle.swift.
// Changed: value types (Equatable, so a capture can be diffed against the last one), the
// JSON is a `ReplayJSON` in the field set of docs/SESSION-REPLAY.md "Wireframes"; no UIImage,
// mask rects or screenshot encoding (wireframe mode only: an image is base64 already).
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

/// The `style` of a wireframe (docs/SESSION-REPLAY.md "Wireframes"). Colors
/// are `#RRGGBB`, sizes whole points.
struct ReplayStyle: Equatable, Sendable {
    var color: String?
    var backgroundColor: String?
    var borderWidth: Int?
    var borderRadius: Int?
    var borderColor: String?
    var fontSize: Int?
    var fontFamily: String?
    var horizontalAlign: String?
    var verticalAlign: String?
    var paddingTop: Int?
    var paddingBottom: Int?
    var paddingLeft: Int?
    var paddingRight: Int?
    /// `progress` inputs: `horizontal` | `circular`.
    var bar: String?

    var isEmpty: Bool { self == ReplayStyle() }

    var json: ReplayJSON {
        var object: [String: ReplayJSON] = [:]
        object["color"] = color.map(ReplayJSON.string)
        object["backgroundColor"] = backgroundColor.map(ReplayJSON.string)
        object["borderWidth"] = borderWidth.map(ReplayJSON.int)
        object["borderRadius"] = borderRadius.map(ReplayJSON.int)
        object["borderColor"] = borderColor.map(ReplayJSON.string)
        object["fontSize"] = fontSize.map(ReplayJSON.int)
        object["fontFamily"] = fontFamily.map(ReplayJSON.string)
        object["horizontalAlign"] = horizontalAlign.map(ReplayJSON.string)
        object["verticalAlign"] = verticalAlign.map(ReplayJSON.string)
        object["paddingTop"] = paddingTop.map(ReplayJSON.int)
        object["paddingBottom"] = paddingBottom.map(ReplayJSON.int)
        object["paddingLeft"] = paddingLeft.map(ReplayJSON.int)
        object["paddingRight"] = paddingRight.map(ReplayJSON.int)
        object["bar"] = bar.map(ReplayJSON.string)
        return .object(object)
    }
}

/// One view of the screen as the mobile replay format describes it
/// (docs/SESSION-REPLAY.md "Wireframes"). Only the types of that table are
/// emitted: `text`, `image`, `rectangle`, `div`, `placeholder`, `input`, and
/// `screenshot` in screenshot mode.
struct ReplayWireframe: Equatable, Sendable {
    /// The id of the screen root: the `parentId` of a wireframe at the top.
    static let screenRootId = 5
    /// Ids below this collide with the player's own nodes.
    static let firstId = 10_000_000
    /// The `type` of a screenshot-mode frame: one image of the whole window.
    static let screenshotType = "screenshot"

    var id: Int
    var x: Int
    var y: Int
    var width: Int
    var height: Int
    var type: String
    var inputType: String?
    var text: String?
    var label: String?
    var value: ReplayJSON?
    var base64: String?
    var style: ReplayStyle?
    var disabled: Bool?
    var checked: Bool?
    var max: Int?
    var childWireframes: [ReplayWireframe]?
    /// The parent wireframe's id, or `screenRootId`. Not serialized (the
    /// tree says it); Mutations carry it beside the wireframe.
    var parentId: Int = ReplayWireframe.screenRootId

    init(id: Int, x: Int, y: Int, width: Int, height: Int, type: String) {
        self.id = id
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.type = type
    }

    /// This wireframe without its children: what an update compares.
    var ownFields: ReplayWireframe {
        var copy = self
        copy.childWireframes = nil
        return copy
    }

    func contains(_ other: ReplayWireframe) -> Bool {
        other.x >= x && other.y >= y && other.x + other.width <= x + width && other.y + other.height <= y + height
    }

    func intersects(_ other: ReplayWireframe) -> Bool {
        x < other.x + other.width && other.x < x + width && y < other.y + other.height && other.y < y + height
    }

    /// The box without what it shows: no text, no pixels, no typed value
    /// and, for an input, no label.
    var withoutContent: ReplayWireframe {
        var copy = self
        copy.text = nil
        copy.base64 = nil
        copy.value = nil
        if copy.type == "input" { copy.label = nil }
        return copy
    }

    var json: ReplayJSON {
        var object: [String: ReplayJSON] = [
            "id": .int(id),
            "x": .int(x),
            "y": .int(y),
            "width": .int(width),
            "height": .int(height),
            "type": .string(type)
        ]
        object["inputType"] = inputType.map(ReplayJSON.string)
        object["text"] = text.map(ReplayJSON.string)
        object["label"] = label.map(ReplayJSON.string)
        object["value"] = value
        object["base64"] = base64.map(ReplayJSON.string)
        if let style, !style.isEmpty { object["style"] = style.json }
        object["disabled"] = disabled.map(ReplayJSON.bool)
        object["checked"] = checked.map(ReplayJSON.bool)
        object["max"] = max.map(ReplayJSON.int)
        if let childWireframes, !childWireframes.isEmpty {
            object["childWireframes"] = .array(childWireframes.map(\.json))
        }
        return .object(object)
    }
}

extension Array where Element == ReplayWireframe {
    /// The same trees with every `parentId` set from its place in them; the
    /// top level gets `parent`.
    func withParentIds(_ parent: Int = ReplayWireframe.screenRootId) -> [ReplayWireframe] {
        map { wireframe in
            var copy = wireframe
            copy.parentId = parent
            copy.childWireframes = wireframe.childWireframes?.withParentIds(wireframe.id)
            return copy
        }
    }

    /// Every wireframe of the trees, parents before their children.
    func flattened() -> [ReplayWireframe] {
        var result: [ReplayWireframe] = []
        func walk(_ list: [ReplayWireframe]) {
            for item in list {
                result.append(item)
                if let children = item.childWireframes { walk(children) }
            }
        }
        walk(self)
        return result
    }

    /// The trees under the SwiftUI `.cohorlyNoCapture()` areas (`covers`,
    /// drawn as opaque placeholders on top of the window): a wireframe lying
    /// entirely inside a cover is dropped with its children; one that only
    /// intersects a cover loses its content (`withoutContent`) and keeps its
    /// box, its children filtered the same way. Nothing under a cover may
    /// reach the player, not even the part of a label sticking out of it.
    func masked(under covers: [ReplayWireframe]) -> [ReplayWireframe] {
        guard !covers.isEmpty else { return self }
        return compactMap { wireframe in
            if covers.contains(where: { $0.contains(wireframe) }) { return nil }
            var copy = covers.contains(where: { $0.intersects(wireframe) }) ? wireframe.withoutContent : wireframe
            copy.childWireframes = wireframe.childWireframes?.masked(under: covers)
            return copy
        }
    }

    /// The trees with every image sent without pixels (as with
    /// `maskAllImages`).
    func withoutImagePixels() -> [ReplayWireframe] {
        map { wireframe in
            var copy = wireframe
            copy.base64 = nil
            copy.childWireframes = wireframe.childWireframes?.withoutImagePixels()
            return copy
        }
    }
}
