// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/UIView+Util.swift (isVisible, toAbsoluteRect, the accessibility token check),
// PostHog/Replay/UIColor+Util.swift and CGColor+Util.swift (toRGBString),
// PostHog/Replay/CGSize+Util.swift (hasSize), PostHog/Replay/UITextInputTraits+Util.swift
// (the secure content types).
// Changed: only what the wireframe path uses; the marker is `cohorlyNoCapture` (an associated
// object) or the `cohorly-no-capture` token in `accessibilityIdentifier` (never the label);
// visibility also drops alpha <= 0.01; colors are resolved for the view's traits and read
// through `getRed`, so grayscale and dynamic colors convert too, and transparent ones are
// left out; the secure content types are only secrets (passwords, codes, cards): every text
// input is masked anyway.
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

#if os(iOS)
import ObjectiveC
import UIKit

private var cohorlyNoCaptureKey: UInt8 = 0

extension UIView {
    /// The `cohorlyNoCapture` marker (an associated object). Internal: the
    /// public property lives outside Recorder/ (UIView+CohorlyNoCapture.swift),
    /// so the copy in the React Native pod adds no public API; there the
    /// `cohorly-no-capture` token below is the way in.
    var cohorlyReplayNoCaptureFlag: Bool {
        get { (objc_getAssociatedObject(self, &cohorlyNoCaptureKey) as? NSNumber)?.boolValue ?? false }
        set {
            objc_setAssociatedObject(
                self, &cohorlyNoCaptureKey, newValue ? NSNumber(value: true) : nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
    }

    static let cohorlyNoCaptureToken = "cohorly-no-capture"

    /// Marked by `cohorlyNoCapture` or the token in `accessibilityIdentifier`.
    var isCohorlyNoCapture: Bool {
        if cohorlyReplayNoCaptureFlag { return true }
        guard let identifier = accessibilityIdentifier else { return false }
        return identifier.range(of: Self.cohorlyNoCaptureToken, options: .caseInsensitive) != nil
    }

    /// Hidden and nearly transparent views draw nothing (nor does their
    /// subtree).
    var isHiddenForReplay: Bool {
        isHidden || alpha <= 0.01
    }

    /// The frame in `window` coordinates: wireframes are positioned against
    /// the screen, not their parent.
    func replayFrame(in window: UIWindow) -> CGRect {
        convert(bounds, to: window)
    }

    /// `#RRGGBB` of `color` as this view draws it, nil when absent or
    /// (nearly) transparent.
    func replayHex(_ color: UIColor?) -> String? {
        guard let color else { return nil }
        return Self.replayHex(color.resolvedColor(with: traitCollection))
    }

    func replayHex(_ color: CGColor?) -> String? {
        guard let color else { return nil }
        return replayHex(UIColor(cgColor: color))
    }

    static func replayHex(_ color: UIColor) -> String? {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha > 0.01 else { return nil }
        return ReplayUtil.hex(red: Double(red), green: Double(green), blue: Double(blue))
    }
}

enum ReplaySecureContentTypes {
    /// The raw values of the secret `UITextContentType`s of this SDK, plus
    /// the pure rule's own list.
    static let all: Set<String> = {
        var types: [UITextContentType] = [.password, .newPassword, .oneTimeCode, .creditCardNumber]
        if #available(iOS 17.0, *) {
            types += [
                .creditCardSecurityCode, .creditCardExpiration, .creditCardExpirationMonth,
                .creditCardExpirationYear, .creditCardType
            ]
        }
        return ReplayMasking.secureContentTypes.union(types.map(\.rawValue))
    }()
}
#endif
