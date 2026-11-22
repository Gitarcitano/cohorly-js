// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/PostHogReplayIntegration.swift, the wireframe path (toWireframe,
// createBasicWireframe, setAlignment, setPadding, the text and image masking checks,
// structureFingerprint / hashStructure / hashLayerContent) and getCurrentWindow from
// PostHog/Utils/UIApplication+.swift.
// Changed: ids are stable per view (an associated number from 10000000 up) instead of
// `view.hash`; text inputs (UITextField, editable UITextView, UISearchBar) are always masked
// and never walked into; secure fields are `inputType: password`; the masking rule is the pure
// `ReplayMasking`; a marked view (`cohorlyNoCapture`, `cohorly-no-capture`) is one placeholder;
// map, Metal, SceneKit, SpriteKit and web views are one labelled placeholder found by class
// name (nothing linked); SwiftUI hosting views are walked like any other; hidden, transparent,
// empty and off-screen views are skipped; at most 2000 wireframes per capture; images with
// pixels are JPEG at the view size; the SwiftUI `.cohorlyNoCapture()` areas are collected
// first, drawn on top as opaque placeholders, and what they touch loses its content; a text
// view once editable stays masked; the window falls back to the application's key window
// for apps without scenes.
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

private var replayIdKey: UInt8 = 0
private var replayTypedInputKey: UInt8 = 0

/// Wireframe ids: one per view, kept by the view (associated object) for
/// its whole life, so a view keeps its id from one capture to the next.
enum ReplayViewIds {
    private static var next = ReplayWireframe.firstId

    /// Main thread only.
    static func id(for view: UIView) -> Int {
        if let existing = objc_getAssociatedObject(view, &replayIdKey) as? NSNumber { return existing.intValue }
        let id = next
        next = next >= Int(Int32.max) ? ReplayWireframe.firstId : next + 1
        objc_setAssociatedObject(view, &replayIdKey, NSNumber(value: id), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return id
    }
}

/// Text views the user may type in.
enum ReplayTextViews {
    /// The text view of a React Native `TextInput` (`multiline`), found by
    /// name so React is not linked. Always an input, even with
    /// `editable={false}`, like a field on web and Android.
    private static let reactNativeInputName = "RCTUITextView"
    /// Main thread only (resolved lazily: React may load after the recorder).
    private static var reactNativeInput: AnyClass?

    /// True when `textView` is a React Native `TextInput`, is editable or
    /// first responder now, or was in any earlier capture (remembered on the
    /// view): text typed while it was editable stays masked after it turns
    /// read-only. Main thread only.
    static func isTypedInput(_ textView: UITextView) -> Bool {
        if objc_getAssociatedObject(textView, &replayTypedInputKey) != nil { return true }
        if reactNativeInput == nil { reactNativeInput = NSClassFromString(reactNativeInputName) }
        let isReactNativeInput = reactNativeInput.map { textView.isKind(of: $0) } ?? false
        guard isReactNativeInput || textView.isEditable || textView.isFirstResponder else { return false }
        objc_setAssociatedObject(textView, &replayTypedInputKey, NSNumber(value: true), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return true
    }
}

/// Views whose content is not views (a Metal or GL surface, a web
/// process): the walk stops there and draws one labelled placeholder. Found
/// by class name, so no framework is linked for them.
enum ReplayOpaqueViews {
    static let webLabel = "Web"
    private static let known: [(name: String, label: String)] = [
        ("MKMapView", "Map"), ("MTKView", "Metal"), ("SCNView", "SceneKit"),
        ("SKView", "SpriteKit"), ("WKWebView", webLabel)
    ]

    /// Main thread only (resolved lazily: a framework may load after launch).
    private static var resolved: [(cls: AnyClass, label: String)] = []
    private static var unresolved = known

    static func label(for view: UIView) -> String? {
        if !unresolved.isEmpty {
            unresolved.removeAll { entry in
                guard let cls = NSClassFromString(entry.name) else { return false }
                resolved.append((cls, entry.label))
                return true
            }
        }
        return resolved.first { view.isKind(of: $0.cls) }?.label
    }

    /// A `WKWebView`: web content may hold fields the view tree cannot see.
    static func isWebView(_ view: UIView) -> Bool {
        label(for: view) == webLabel
    }
}

/// The JPEGs of images shown with their pixels (`maskAllImages: false`),
/// by image and size, so a still image is encoded once. Main thread only.
final class ReplayImageEncoder {
    static let quality: CGFloat = 0.3
    private static let maxEntries = 64

    private struct Entry {
        weak var image: UIImage?
        let size: CGSize
        let base64: String
    }

    private var cache: [ObjectIdentifier: Entry] = [:]

    func base64(_ image: UIImage, size: CGSize) -> String? {
        let key = ObjectIdentifier(image)
        if let entry = cache[key], entry.image === image, entry.size == size { return entry.base64 }
        guard size.width >= 1, size.height >= 1, size.width * size.height <= 4_000_000 else { return nil }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1
        let data = UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: Self.quality) { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        let base64 = "data:image/jpeg;base64," + data.base64EncodedString()
        if cache.count >= Self.maxEntries { cache.removeAll() }
        cache[key] = Entry(image: image, size: size, base64: base64)
        return base64
    }
}

/// Turns a window's `UIView` tree into wireframes. Main thread only.
final class WireframeBuilder {
    static let maxWireframes = 2000
    /// Drawn for a `.cohorlyNoCapture()` area, on top of everything.
    static let coverColor = "#C7C7CC"

    let maskAllImages: Bool
    private let images = ReplayImageEncoder()
    private var count = 0
    private var covers: [ReplayWireframe] = []
    private var loggedCut = false

    init(maskAllImages: Bool) {
        self.maskAllImages = maskAllImages
    }

    /// The window as wireframes, `parentId`s set: the window's tree, then
    /// one opaque placeholder per SwiftUI no-capture area.
    func build(window: UIWindow) -> [ReplayWireframe] {
        // Covers first: the wireframe limit counts them but never cuts one,
        // and they mask whatever the walk reaches.
        covers = []
        collectCovers(in: window, window: window)
        count = covers.count
        let tree = wireframes(for: window, in: window, clip: window.bounds)
        return (tree.masked(under: covers) + covers).withParentIds()
    }

    /// Every visible `.cohorlyNoCapture()` marker of the window, as an
    /// opaque placeholder.
    private func collectCovers(in view: UIView, window: UIWindow) {
        guard !view.isHiddenForReplay else { return }
        if let marker = view as? CohorlyNoCaptureMarkerView {
            guard marker.isMaskingEnabled else { return }
            let frame = view.replayFrame(in: window)
            if frame.width > 0, frame.height > 0, frame.intersects(window.bounds) {
                var cover = basic(view, frame: frame, type: "placeholder")
                cover.style = ReplayStyle(backgroundColor: Self.coverColor)
                covers.append(cover)
            }
            return
        }
        // Nothing under these is read, so no marker there matters.
        if view.isCohorlyNoCapture || ReplayOpaqueViews.label(for: view) != nil { return }
        for subview in view.subviews { collectCovers(in: subview, window: window) }
    }

    /// The wireframe of `view` with its subtree, or, for a view that draws
    /// nothing itself but may hold visible children (empty, or off the clip
    /// without clipping), those children's wireframes.
    private func wireframes(for view: UIView, in window: UIWindow, clip: CGRect) -> [ReplayWireframe] {
        if view.isHiddenForReplay { return [] }
        // Already drawn by `collectCovers`.
        if view is CohorlyNoCaptureMarkerView { return [] }
        let frame = view.replayFrame(in: window)
        let visible = frame.width > 0 && frame.height > 0 && frame.intersects(clip)
        // A marked or opaque view ends the walk before anything that could
        // descend into it (a zero-size or off-clip view that does not clip
        // still shows its children): nothing under it is ever read.
        let opaqueLabel = view.isCohorlyNoCapture ? nil : ReplayOpaqueViews.label(for: view)
        if view.isCohorlyNoCapture || opaqueLabel != nil {
            guard visible, takeSlot() else { return [] }
            return placeholder(view, frame: frame, label: opaqueLabel, clip: clip).map { [$0] } ?? []
        }
        if !visible {
            // A clipping view shows nothing outside itself.
            if view.clipsToBounds { return [] }
            return children(of: view, in: window, clip: clip, skipping: nil)
        }
        guard takeSlot() else { return [] }

        // The player draws every wireframe fixed to the screen, so a parent's
        // clip only shows if the recorded rectangle is already clipped.
        var wireframe = basic(view, frame: frame.intersection(clip), type: "div")
        var style = ReplayStyle()
        let decision = ReplayMasking.decide(
            Self.traits(of: view), maskAllImages: maskAllImages, secureContentTypes: ReplaySecureContentTypes.all)
        var walkChildren = true
        var skipped: UIView?

        switch view {
        case let searchBar as UISearchBar:
            wireframe.type = "input"
            wireframe.inputType = decision.inputType
            wireframe.value = maskedValue(searchBar.text)
            walkChildren = false
        case let textField as UITextField:
            wireframe.type = "input"
            wireframe.inputType = decision.inputType
            wireframe.value = maskedValue(textField.text)
            wireframe.disabled = !textField.isEnabled
            textStyle(&style, color: textField.textColor, font: textField.font, alignment: textField.textAlignment, in: view)
            walkChildren = false
        case let textView as UITextView:
            if ReplayTextViews.isTypedInput(textView) {
                wireframe.type = "input"
                wireframe.inputType = decision.inputType
                wireframe.value = maskedValue(textView.text)
            } else {
                wireframe.type = "text"
                wireframe.text = decision.content == .maskedText ? textView.text.map(ReplayUtil.mask) : textView.text
            }
            textStyle(&style, color: textView.textColor, font: textView.font, alignment: textView.textAlignment, in: view)
            padding(&style, textView.textContainerInset)
            walkChildren = false
        case let label as UILabel:
            wireframe.type = "text"
            wireframe.text = label.text
            wireframe.disabled = label.isEnabled ? nil : true
            textStyle(&style, color: label.textColor, font: label.font, alignment: label.textAlignment, in: view)
            walkChildren = false
        case let toggle as UISwitch:
            wireframe.type = "input"
            wireframe.inputType = "toggle"
            wireframe.checked = toggle.isOn
            wireframe.disabled = !toggle.isEnabled
            walkChildren = false
        case let slider as UISlider:
            wireframe.type = "input"
            wireframe.inputType = "progress"
            let range = slider.maximumValue - slider.minimumValue
            wireframe.value = .double(range > 0 ? Double((slider.value - slider.minimumValue) / range) : 0)
            wireframe.max = 1
            style.bar = "horizontal"
            walkChildren = false
        case let progress as UIProgressView:
            wireframe.type = "input"
            wireframe.inputType = "progress"
            wireframe.value = .double(Double(progress.progress))
            wireframe.max = 1
            style.bar = "horizontal"
            walkChildren = false
        case is UIActivityIndicatorView:
            wireframe.type = "input"
            wireframe.inputType = "progress"
            style.bar = "circular"
            walkChildren = false
        case let button as UIButton:
            wireframe.type = "input"
            wireframe.inputType = "button"
            wireframe.disabled = !button.isEnabled
            // A marked title label is walked like any marked view (one
            // placeholder), never copied into the button's value.
            if let title = button.currentTitle ?? button.configuration?.title, !title.isEmpty,
               button.titleLabel?.isCohorlyNoCapture != true {
                wireframe.value = .string(title)
                // Its title is the button's value; drawing the label too would show it twice.
                skipped = button.titleLabel
            }
        case let imageView as UIImageView:
            wireframe.type = "image"
            if decision.content == .image, let image = imageView.image {
                wireframe.base64 = images.base64(image, size: imageView.bounds.size)
            }
        default:
            break
        }

        style.backgroundColor = view.replayHex(view.backgroundColor)
        let layer = view.layer
        if layer.borderWidth > 0 {
            style.borderWidth = ReplayUtil.toInt(layer.borderWidth)
            style.borderColor = view.replayHex(layer.borderColor)
        }
        if layer.cornerRadius > 0 { style.borderRadius = ReplayUtil.toInt(layer.cornerRadius) }
        wireframe.style = style.isEmpty ? nil : style

        if walkChildren {
            let childClip = view.clipsToBounds ? clip.intersection(frame) : clip
            let children = children(of: view, in: window, clip: childClip, skipping: skipped)
            wireframe.childWireframes = children.isEmpty ? nil : children
        }
        return [wireframe]
    }

    /// Counts one wireframe against `maxWireframes`; false once it is reached.
    private func takeSlot() -> Bool {
        guard count < Self.maxWireframes else {
            if !loggedCut {
                loggedCut = true
                ReplayLog.log("session replay: a screen has more than \(Self.maxWireframes) views, the rest is not recorded")
            }
            return false
        }
        count += 1
        return true
    }

    private func children(of view: UIView, in window: UIWindow, clip: CGRect, skipping skipped: UIView?) -> [ReplayWireframe] {
        var result: [ReplayWireframe] = []
        for subview in view.subviews where subview !== skipped {
            result.append(contentsOf: wireframes(for: subview, in: window, clip: clip))
        }
        return result
    }

    private func basic(_ view: UIView, frame: CGRect, type: String) -> ReplayWireframe {
        ReplayWireframe(
            id: ReplayViewIds.id(for: view),
            x: ReplayUtil.toInt(frame.origin.x) ?? 0,
            y: ReplayUtil.toInt(frame.origin.y) ?? 0,
            width: ReplayUtil.toInt(frame.size.width) ?? 0,
            height: ReplayUtil.toInt(frame.size.height) ?? 0,
            type: type)
    }

    private func placeholder(_ view: UIView, frame: CGRect, label: String?, clip: CGRect) -> ReplayWireframe? {
        guard frame.width > 0, frame.height > 0, frame.intersects(clip) else { return nil }
        var wireframe = basic(view, frame: frame.intersection(clip), type: "placeholder")
        wireframe.label = label
        return wireframe
    }

    /// What the masking rule needs to know about `view` (screenshot mode
    /// reads it too).
    static func traits(of view: UIView) -> ReplayViewTraits {
        var traits = ReplayViewTraits(kind: .other)
        traits.noCapture = view.isCohorlyNoCapture
        switch view {
        case let searchBar as UISearchBar:
            traits.kind = .searchBar
            traits.isEditable = true
            traits.isSecureTextEntry = searchBar.searchTextField.isSecureTextEntry
            traits.textContentType = searchBar.searchTextField.textContentType?.rawValue
        case let textField as UITextField:
            traits.kind = .textField
            traits.isEditable = true
            traits.isSecureTextEntry = textField.isSecureTextEntry
            traits.textContentType = textField.textContentType?.rawValue
        case let textView as UITextView:
            traits.kind = .textView
            traits.isEditable = ReplayTextViews.isTypedInput(textView)
            traits.isSecureTextEntry = textView.isSecureTextEntry
            traits.textContentType = textView.textContentType?.rawValue
        case is UILabel:
            traits.kind = .label
        case is UIImageView:
            traits.kind = .image
        default:
            break
        }
        return traits
    }

    /// Typed text as asterisks of the same length; nil when empty.
    private func maskedValue(_ text: String?) -> ReplayJSON? {
        guard let text, !text.isEmpty else { return nil }
        return .string(ReplayUtil.mask(text))
    }

    private func textStyle(_ style: inout ReplayStyle, color: UIColor?, font: UIFont?, alignment: NSTextAlignment, in view: UIView) {
        style.color = view.replayHex(color)
        if let font {
            style.fontFamily = font.familyName
            style.fontSize = ReplayUtil.toInt(font.pointSize)
        }
        switch alignment {
        case .center:
            style.horizontalAlign = "center"
            style.verticalAlign = "center"
        case .right:
            style.horizontalAlign = "right"
        case .left:
            style.horizontalAlign = "left"
        default:
            break
        }
    }

    private func padding(_ style: inout ReplayStyle, _ insets: UIEdgeInsets) {
        style.paddingTop = ReplayUtil.toInt(insets.top)
        style.paddingRight = ReplayUtil.toInt(insets.right)
        style.paddingBottom = ReplayUtil.toInt(insets.bottom)
        style.paddingLeft = ReplayUtil.toInt(insets.left)
    }

    // MARK: - Structure fingerprint (the backoff's way out of a still screen)

    static let fingerprintNodeLimit = 1000
    static let fingerprintDepthLimit = 64

    /// A render-free summary of what the window would draw. Compared only
    /// within one process (`Hasher` is seeded).
    static func structureFingerprint(of window: UIView) -> Int {
        var hasher = Hasher()
        hasher.combine(ObjectIdentifier(window))
        var budget = fingerprintNodeLimit
        hashStructure(window, into: &hasher, budget: &budget, depthRemaining: fingerprintDepthLimit)
        return hasher.finalize()
    }

    private static func hashStructure(_ view: UIView, into hasher: inout Hasher, budget: inout Int, depthRemaining: Int) {
        guard budget > 0, depthRemaining > 0 else { return }
        budget -= 1
        hasher.combine(ObjectIdentifier(type(of: view)))
        let invisible = view.isHidden || view.alpha == 0
        hasher.combine(invisible)
        // A hidden subtree draws nothing: its churn is no change.
        guard !invisible else { return }
        hasher.combine(view.alpha)
        hasher.combine(view.backgroundColor)
        let frame = view.frame
        hasher.combine(frame.origin.x)
        hasher.combine(frame.origin.y)
        hasher.combine(frame.size.width)
        hasher.combine(frame.size.height)
        // Recorded as one box: what changes inside never reaches a capture.
        if view.isCohorlyNoCapture || ReplayOpaqueViews.label(for: view) != nil { return }
        // Scroll offset lives in bounds, not frame.
        hasher.combine(view.bounds.origin.x)
        hasher.combine(view.bounds.origin.y)
        if let label = view as? UILabel {
            hasher.combine(label.text)
            hasher.combine(label.textColor)
        } else if let textField = view as? UITextField {
            hasher.combine(textField.text?.count)
        } else if let imageView = view as? UIImageView {
            hasher.combine(imageView.image.map(ObjectIdentifier.init))
        }
        hashLayerContent(view.layer, into: &hasher, budget: &budget, depthRemaining: depthRemaining)
        let subviews = view.subviews
        hasher.combine(subviews.count)
        for subview in subviews {
            hashStructure(subview, into: &hasher, budget: &budget, depthRemaining: depthRemaining - 1)
        }
    }

    /// SwiftUI updates reach the screen through layers without touching a
    /// `UIView` property; layers a view owns are left to `hashStructure`.
    private static func hashLayerContent(_ layer: CALayer, into hasher: inout Hasher, budget: inout Int, depthRemaining: Int) {
        hasher.combine(layer.backgroundColor.map { UIColor(cgColor: $0) })
        hasher.combine((layer.contents as AnyObject?).map(ObjectIdentifier.init))
        for sublayer in layer.sublayers ?? [] where !(sublayer.delegate is UIView) {
            guard budget > 0, depthRemaining > 1 else { return }
            budget -= 1
            hasher.combine(sublayer.isHidden)
            guard !sublayer.isHidden else { continue }
            hasher.combine(sublayer.opacity)
            let bounds = sublayer.bounds
            hasher.combine(bounds.origin.x)
            hasher.combine(bounds.origin.y)
            hasher.combine(bounds.size.width)
            hasher.combine(bounds.size.height)
            hasher.combine(sublayer.position.x)
            hasher.combine(sublayer.position.y)
            hashLayerContent(sublayer, into: &hasher, budget: &budget, depthRemaining: depthRemaining - 1)
        }
    }
}

/// `ReplaySnapshotSource` of wireframe mode: the key window's view tree.
final class WireframeSnapshotSource: ReplaySnapshotSource {
    private let builder: WireframeBuilder

    init(maskAllImages: Bool) {
        builder = WireframeBuilder(maskAllImages: maskAllImages)
    }

    func isInForeground() -> Bool {
        UIApplication.shared.applicationState != .background
    }

    func captureFrame() -> ReplaySourceFrame? {
        guard let window = Self.keyWindow(),
              let width = ReplayUtil.toInt(window.bounds.width),
              let height = ReplayUtil.toInt(window.bounds.height),
              width > 0, height > 0
        else { return nil }
        let wireframes = builder.build(window: window)
        guard !wireframes.isEmpty else { return nil }
        return ReplaySourceFrame(
            windowKey: ObjectIdentifier(window).hashValue, width: width, height: height,
            href: Self.screenName(window), wireframes: wireframes)
    }

    func structureFingerprint() -> Int? {
        Self.keyWindow().map { WireframeBuilder.structureFingerprint(of: $0) }
    }

    /// The key window of the foreground scene, else any scene's key window,
    /// else (an app without scenes) the application's key window.
    static func keyWindow() -> UIWindow? {
        let application = UIApplication.shared
        let scenes = application.connectedScenes.compactMap { $0 as? UIWindowScene }
        return chooseWindow(
            foregroundKeyWindows: scenes.filter { $0.activationState == .foregroundActive }.compactMap(\.keyWindow),
            sceneWindows: scenes.flatMap(\.windows),
            applicationWindows: (application as ReplayApplicationWindows).windows)
    }

    /// The rule of `keyWindow()`, apart from UIKit's globals.
    static func chooseWindow(
        foregroundKeyWindows: [UIWindow], sceneWindows: [UIWindow], applicationWindows: [UIWindow],
        isKey: (UIWindow) -> Bool = { $0.isKeyWindow }
    ) -> UIWindow? {
        if let window = foregroundKeyWindows.first { return window }
        if let window = sceneWindows.first(where: isKey) { return window }
        return applicationWindows.first(where: isKey)
    }

    /// The class name (no module) of the view controller on top of
    /// `window`: presented first, then a navigation stack's visible one, a
    /// tab bar's selected one.
    static func screenName(_ window: UIWindow) -> String {
        guard var controller = window.rootViewController else { return "" }
        var steps = 0
        while steps < 32 {
            steps += 1
            if let presented = controller.presentedViewController, !presented.isBeingDismissed {
                controller = presented
            } else if let navigation = controller as? UINavigationController,
                      let top = navigation.visibleViewController ?? navigation.topViewController {
                if top === controller { break }
                controller = top
            } else if let tabs = controller as? UITabBarController, let selected = tabs.selectedViewController {
                controller = selected
            } else {
                break
            }
        }
        return String(describing: type(of: controller))
    }
}

/// `UIApplication.windows` (deprecated in iOS 15 for scene apps, still the
/// only list of an app without scenes), read through a protocol so the
/// deprecation does not warn on every build.
private protocol ReplayApplicationWindows {
    var windows: [UIWindow] { get }
}

extension UIApplication: ReplayApplicationWindows {}

/// The view `.cohorlyNoCapture()` lays over SwiftUI content: its area is
/// drawn as an opaque placeholder above everything of the window
/// (wireframes) or painted over the pixels (screenshots). Its frame is read
/// at capture time, so a row that scrolled or moved is masked where it is.
final class CohorlyNoCaptureMarkerView: UIView {
    var isMaskingEnabled = true {
        didSet {
            cohorlyReplayNoCaptureFlag = isMaskingEnabled
            updateRegistration()
        }
    }

    /// Tells "not laid out yet" (a screenshot is then skipped) from a
    /// laid-out marker of no size.
    private(set) var hasCompletedFirstLayout = false
    private weak var lastLayoutWindow: UIWindow?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        cohorlyReplayNoCaptureFlag = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        hasCompletedFirstLayout = true
        lastLayoutWindow = window
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if let window {
            // A frame from another window's layout is stale; the same window
            // again (cell reuse) keeps it, since frames are read live anyway.
            if window !== lastLayoutWindow { hasCompletedFirstLayout = false }
            // Else a marker whose bounds never change again would hold every
            // screenshot back.
            if !hasCompletedFirstLayout { setNeedsLayout() }
        }
        updateRegistration()
    }

    private func updateRegistration() {
        if window != nil, isMaskingEnabled {
            ReplayNoCaptureMarkers.register(self)
        } else {
            ReplayNoCaptureMarkers.unregister(self)
        }
    }

    /// Nothing between it and its window is hidden or transparent.
    func isVisible(in window: UIWindow) -> Bool {
        guard self.window === window else { return false }
        var view: UIView? = self
        while let current = view {
            // The window is what gets drawn: its own flags do not hide the marker.
            if current === window { return true }
            if current.isHiddenForReplay { return false }
            view = current.superview
        }
        return false
    }
}

/// The live `.cohorlyNoCapture()` markers, so screenshot mode finds them
/// without walking SwiftUI's views. Weak: a marker that is gone drops out.
enum ReplayNoCaptureMarkers {
    private final class Weak {
        weak var marker: CohorlyNoCaptureMarkerView?
        init(_ marker: CohorlyNoCaptureMarkerView) { self.marker = marker }
    }

    private static let lock = NSLock()
    private static var markers: [ObjectIdentifier: Weak] = [:]

    static func register(_ marker: CohorlyNoCaptureMarkerView) {
        lock.lock()
        markers[ObjectIdentifier(marker)] = Weak(marker)
        lock.unlock()
    }

    static func unregister(_ marker: CohorlyNoCaptureMarkerView) {
        lock.lock()
        markers[ObjectIdentifier(marker)] = nil
        lock.unlock()
    }

    /// The areas (window coordinates) of the enabled markers shown in
    /// `window`; nil while one of them is not laid out yet, so a frame is
    /// skipped rather than sent with that area bare. Main thread.
    static func rects(in window: UIWindow) -> [CGRect]? {
        lock.lock()
        markers = markers.filter { $0.value.marker != nil }
        let live = markers.values.compactMap(\.marker)
        lock.unlock()
        var rects: [CGRect] = []
        for marker in live where marker.isMaskingEnabled && marker.isVisible(in: window) {
            guard marker.hasCompletedFirstLayout else { return nil }
            let rect = marker.replayFrame(in: window)
            if !rect.isEmpty { rects.append(rect) }
        }
        return rects
    }
}
#endif
