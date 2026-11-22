// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/UIView+Util.swift (toImage, the drawHierarchy path only: afterScreenUpdates
// true only where a fresh screen would come out black, the screen's gamut) and
// PostHog/Replay/RRWireframe.swift (maskImage / paintMasks: opaque black rects in whole
// pixels).
// Changed: drawn at 1 point per pixel straight away (no native-scale copy, no resample); the
// masks are painted in the same bitmap as the draw, before any image or JPEG exists, and come
// from Cohorly's masking rule (`ReplayMasking`, the wireframe recorder's) plus the SwiftUI
// markers; each mask is rounded outward and grown by 1 px; a fresh screen is detected by its
// key (window, screen name, size) and a blank bitmap; a blank frame is never sent. Not copied:
// GPU capture, presentation-tree renderer, camera check, settle analysis, background capture.
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

/// What a screenshot must cover, in window points, by the wireframe
/// recorder's rule (`ReplayMasking`):
/// - every `UITextField`, `UISearchBar`, editable (or once editable)
///   `UITextView` and React Native `TextInput` (`RCTUITextView`), and a
///   secure text view;
/// - with `maskAllImages`, every `UIImageView` showing an image;
/// - a view marked `cohorlyNoCapture` (or `cohorly-no-capture` in its
///   `accessibilityIdentifier`) and its whole subtree;
/// - every `WKWebView` (its fields are not views);
/// - the SwiftUI `.cohorlyNoCapture()` areas (`ReplayNoCaptureMarkers`).
///
/// Map, Metal, SceneKit and SpriteKit views are not covered: their pixels
/// are what screenshot mode is for. Main thread only.
final class ReplayScreenshotMasker {
    let maskAllImages: Bool

    init(maskAllImages: Bool) {
        self.maskAllImages = maskAllImages
    }

    /// The rects to cover in `window`, clipped to what shows; nil while a
    /// SwiftUI marker is not laid out yet (the frame is then skipped).
    func collect(in window: UIWindow) -> [CGRect]? {
        guard let markers = ReplayNoCaptureMarkers.rects(in: window) else { return nil }
        // The window is what gets drawn: its own flags only matter when marked.
        if window.isCohorlyNoCapture { return [window.bounds] }
        var rects: [CGRect] = []
        for subview in window.subviews {
            walk(subview, window: window, clip: window.bounds, insideNoCapture: false, into: &rects)
        }
        return rects + markers
    }

    private func walk(_ view: UIView, window: UIWindow, clip: CGRect, insideNoCapture: Bool, into rects: inout [CGRect]) {
        let marked = insideNoCapture || view.isCohorlyNoCapture
        // Skipped only when it draws nothing at all, unlike the wireframe's
        // 0.01 alpha threshold: `drawHierarchy` still draws a nearly
        // transparent view and everything under it.
        if Self.drawsNothing(view) { return }
        // Read from the registry, enabled or not.
        if view is CohorlyNoCaptureMarkerView { return }
        let frame = view.replayFrame(in: window)
        let visible = frame.intersection(clip)
        let childClip = view.clipsToBounds ? visible : clip
        if marked {
            add(visible, to: &rects)
            // Children of a view that does not clip may draw outside it.
            for subview in view.subviews {
                walk(subview, window: window, clip: childClip, insideNoCapture: true, into: &rects)
            }
            return
        }
        if ReplayOpaqueViews.isWebView(view) {
            add(visible, to: &rects)
            return
        }
        let decision = ReplayMasking.decide(
            WireframeBuilder.traits(of: view), maskAllImages: maskAllImages,
            secureContentTypes: ReplaySecureContentTypes.all)
        switch decision.content {
        case .maskedText, .placeholder:
            add(visible, to: &rects)
            // A text input that does not clip may draw its text past its
            // bounds: its subviews are covered wherever they reach.
            guard !view.clipsToBounds else { return }
            for subview in view.subviews {
                walk(subview, window: window, clip: childClip, insideNoCapture: true, into: &rects)
            }
            return
        case .maskedImage:
            if let imageView = view as? UIImageView, Self.showsImage(imageView) { add(visible, to: &rects) }
        case .text, .image, .plain:
            break
        }
        for subview in view.subviews {
            walk(subview, window: window, clip: childClip, insideNoCapture: false, into: &rects)
        }
    }

    private func add(_ rect: CGRect, to rects: inout [CGRect]) {
        guard !rect.isNull, !rect.isEmpty else { return }
        rects.append(rect)
    }

    private static func showsImage(_ imageView: UIImageView) -> Bool {
        imageView.image != nil || imageView.highlightedImage != nil
            || !(imageView.animationImages ?? []).isEmpty
            || !(imageView.highlightedAnimationImages ?? []).isEmpty
    }

    private static func drawsNothing(_ view: UIView) -> Bool {
        view.isHidden || view.alpha == 0
    }
}

/// `ReplaySnapshotSource` of screenshot mode: the key window drawn into one
/// image, masked in its pixels, sent as one `screenshot` wireframe.
///
/// `drawHierarchy(afterScreenUpdates: false)` copies the last frame on
/// screen (Metal and maps included) without forcing a layout pass; only the
/// first frame of a screen that comes out blank (a view controller just
/// presented) is drawn again with `afterScreenUpdates: true`. The masks are
/// read after the draw, in the same main-thread turn, and painted in the same
/// bitmap before it becomes an image: the unmasked pixels never leave that
/// buffer. An animation running during the capture may leave a mask a few
/// points off the content it follows (docs/SESSION-REPLAY.md, limitations).
final class ScreenshotSnapshotSource: ReplaySnapshotSource {
    static let quality: CGFloat = 0.3
    /// Each mask reaches this far past its rect (in pixels, after rounding
    /// outward): the downscaled draw blends a pixel next to a mask with what
    /// lies under it.
    static let maskBleed: CGFloat = 1

    /// `drawHierarchy(in:afterScreenUpdates:)` of a view into the current
    /// context, in its own bounds; false when nothing could be drawn.
    typealias Draw = (_ view: UIView, _ afterScreenUpdates: Bool) -> Bool

    private struct ScreenKey: Equatable {
        var window: ObjectIdentifier
        var href: String
        var width: Int
        var height: Int
    }

    private let masker: ReplayScreenshotMasker
    private let draw: Draw
    private var lastScreen: ScreenKey?

    init(maskAllImages: Bool, draw: @escaping Draw = ScreenshotSnapshotSource.drawHierarchy) {
        masker = ReplayScreenshotMasker(maskAllImages: maskAllImages)
        self.draw = draw
    }

    static let drawHierarchy: Draw = { view, afterScreenUpdates in
        view.drawHierarchy(in: view.bounds, afterScreenUpdates: afterScreenUpdates)
    }

    func isInForeground() -> Bool {
        UIApplication.shared.applicationState != .background
    }

    func captureFrame() -> ReplaySourceFrame? {
        guard let window = WireframeSnapshotSource.keyWindow() else { return nil }
        return frame(of: window, href: WireframeSnapshotSource.screenName(window))
    }

    func structureFingerprint() -> Int? {
        WireframeSnapshotSource.keyWindow().map { WireframeBuilder.structureFingerprint(of: $0) }
    }

    /// `window` as one masked screenshot, nil when it cannot be drawn, came
    /// out blank, or a mask cannot be read yet.
    func frame(of window: UIWindow, href: String) -> ReplaySourceFrame? {
        guard let width = ReplayUtil.toInt(window.bounds.width),
              let height = ReplayUtil.toInt(window.bounds.height),
              width > 0, height > 0
        else { return nil }
        let key = ScreenKey(window: ObjectIdentifier(window), href: href, width: width, height: height)
        let freshScreen = key != lastScreen
        // Only the first attempt of a screen: one that stays blank never
        // forces a layout pass again.
        lastScreen = key
        guard let base64 = render(window, freshScreen: freshScreen) else { return nil }
        var wireframe = ReplayWireframe(
            id: ReplayViewIds.id(for: window), x: 0, y: 0, width: width, height: height,
            type: ReplayWireframe.screenshotType)
        wireframe.base64 = base64
        return ReplaySourceFrame(
            windowKey: ObjectIdentifier(window).hashValue, width: width, height: height, href: href,
            wireframes: [wireframe])
    }

    /// The masked JPEG of `window` as a `data:` URL.
    private func render(_ window: UIWindow, freshScreen: Bool) -> String? {
        let bounds = window.bounds
        let renderer = ReplayImageRenderer(size: bounds.size, scale: 1, gamut: window.traitCollection.displayGamut)
        let image = renderer.image { context in
            var drawn = draw(window, false)
            if freshScreen, !drawn || ReplayImageRenderer.isBlank(context) {
                context.clear(bounds)
                drawn = draw(window, true)
            }
            guard drawn, !ReplayImageRenderer.isBlank(context) else { return false }
            // After the draw: one after screen updates commits the layout the
            // masks must match.
            guard let masks = masker.collect(in: window) else { return false }
            Self.paint(masks, in: context)
            return true
        }
        return image?.cohorlyJPEGBase64(Self.quality)
    }

    /// Opaque black over each rect, in whole pixels, rounded outward and
    /// grown by `maskBleed`.
    static func paint(_ masks: [CGRect], in context: CGContext) {
        guard !masks.isEmpty else { return }
        let toPixels = context.userSpaceToDeviceSpaceTransform
        let toPoints = toPixels.inverted()
        context.setFillColor(UIColor.black.cgColor)
        for rect in masks {
            let pixels = rect.applying(toPixels).integral.insetBy(dx: -maskBleed, dy: -maskBleed)
            context.fill(pixels.applying(toPoints))
        }
    }
}
#endif
