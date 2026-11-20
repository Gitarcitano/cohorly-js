// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/PostHogGraphicsImageRenderer.swift, which carries: "Portions of this file are
// derived from getsentry/sentry-cocoa. Copyright (c) 2015 Sentry. Licensed under the MIT
// License: https://github.com/getsentry/sentry-cocoa/blob/main/LICENSE.md".
// Changed: renamed; the actions return false to give the frame up (nil, no image made); no
// `roundingUp`; `isBlank` reads the bitmap the actions drew into.
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
import UIKit

private let deviceRGBColorSpace = CGColorSpaceCreateDeviceRGB()
private let displayP3ColorSpace = CGColorSpace(name: CGColorSpace.displayP3) ?? deviceRGBColorSpace

/// Draws into a bitmap of its own (a `CGContext` pushed as the current
/// UIKit context, so `drawHierarchy` draws into it) without the overhead of
/// `UIGraphicsImageRenderer`. The pixels live only in this call's buffer:
/// whatever the actions draw, and then paint over, is never kept elsewhere.
final class ReplayImageRenderer {
    private let size: CGSize
    private let scale: CGFloat
    private let colorSpace: CGColorSpace

    /// `gamut` picks the bitmap's color space (Display P3 for `.P3`, device
    /// RGB otherwise): a bitmap in the screen's gamut spares `drawHierarchy`
    /// a conversion of every pixel on the main thread.
    init(size: CGSize, scale: CGFloat, gamut: UIDisplayGamut = .unspecified) {
        self.size = size
        self.scale = scale
        colorSpace = gamut == .P3 ? displayP3ColorSpace : deviceRGBColorSpace
    }

    /// The image `actions` drew, in points from the top left; nil when the
    /// bitmap cannot be allocated or `actions` returns false.
    func image(actions: (CGContext) -> Bool) -> UIImage? {
        let width = Int(size.width * scale)
        let height = Int(size.height * scale)
        guard width > 0, height > 0 else { return nil }
        let bytesPerRow = 4 * width
        // calloc: pixels the draw leaves uncovered are transparent, never stale heap bytes.
        guard let raw = calloc(height * bytesPerRow, 1) else { return nil }
        defer { free(raw) }
        guard let context = CGContext(
            data: raw, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow,
            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        // UIKit's coordinates are flipped against Core Graphics'.
        context.translateBy(x: 0, y: size.height * scale)
        context.scaleBy(x: scale, y: -scale)
        UIGraphicsPushContext(context)
        let keep = actions(context)
        UIGraphicsPopContext()
        guard keep, let cgImage = context.makeImage() else { return nil }
        return UIImage(cgImage: cgImage, scale: scale, orientation: .up)
    }

    /// True when nothing was drawn in `context` (a bitmap of this renderer):
    /// every pixel of a 16 x 16 grid is still fully transparent.
    static func isBlank(_ context: CGContext) -> Bool {
        guard let data = context.data, context.bitsPerPixel == 32 else { return false }
        let pixels = data.assumingMemoryBound(to: UInt8.self)
        let width = context.width
        let height = context.height
        let steps = 16
        for row in 0..<steps {
            let y = min(height - 1, (row * height + height / 2) / steps)
            for column in 0..<steps {
                let x = min(width - 1, (column * width + width / 2) / steps)
                // premultipliedLast: alpha is the fourth byte.
                if pixels[y * context.bytesPerRow + x * 4 + 3] != 0 { return false }
            }
        }
        return true
    }
}
#endif
