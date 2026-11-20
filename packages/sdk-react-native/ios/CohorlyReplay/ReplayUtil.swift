// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/String+Util.swift (mask), PostHog/Replay/Float+Util.swift (toInt),
// PostHog/Replay/CGColor+Util.swift (the hex format of toRGBString),
// PostHog/Replay/Date+Util.swift (toMillis).
// Changed: free functions under one namespace, components clamped to 0...1 before the hex
// conversion, no UIKit (the UIColor side lives in UIView+CohorlyReplay.swift).
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

enum ReplayUtil {
    /// One `*` per character: the length shows, the text never does.
    static func mask(_ text: String) -> String {
        String(repeating: "*", count: text.count)
    }

    /// A coordinate or size rounded to whole points; nil when not finite or
    /// out of range.
    static func toInt<T: BinaryFloatingPoint>(_ value: T) -> Int? {
        // `<`: Int.max converted to a float rounds up past Int.max.
        guard value.isFinite, value >= T(Int.min), value < T(Int.max) else { return nil }
        return Int(value.rounded())
    }

    /// `#RRGGBB` from sRGB components in 0...1.
    static func hex(red: Double, green: Double, blue: Double) -> String {
        func byte(_ value: Double) -> Int {
            guard value.isFinite else { return 0 }
            return Int((min(1, max(0, value)) * 255).rounded())
        }
        return String(format: "#%02X%02X%02X", byte(red), byte(green), byte(blue))
    }

    /// Unix ms of `date`, rounded down and clamped to +/-9e15 (0 when not
    /// finite): the one conversion the recorder and the session store share.
    static func millis(_ date: Date) -> Int64 {
        let value = (date.timeIntervalSince1970 * 1000).rounded(.down)
        guard value.isFinite else { return 0 }
        return Int64(max(min(value, 9.0e15), -9.0e15))
    }
}
