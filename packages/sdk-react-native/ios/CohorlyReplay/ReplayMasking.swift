// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

import Foundation

/// What the masking rule needs to know about a view, read on the main
/// thread by the wireframe builder (or written by hand in tests).
struct ReplayViewTraits: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// `UILabel`.
        case label
        /// `UITextField` (a `UISearchTextField` included).
        case textField
        /// `UITextView`; editable or not is `isEditable`.
        case textView
        /// `UISearchBar`.
        case searchBar
        case image
        case other
    }

    var kind: Kind
    var isEditable = false
    var isSecureTextEntry = false
    /// `textContentType.rawValue`.
    var textContentType: String?
    /// `cohorlyNoCapture` or the `cohorly-no-capture` token on the view.
    var noCapture = false
}

/// How a view's content may appear in a recording.
struct ReplayMaskDecision: Equatable, Sendable {
    enum Content: Equatable, Sendable {
        /// The view and its subtree are one `placeholder`, no text, no children.
        case placeholder
        /// The text as it is (a label, a non-editable text view).
        case text
        /// The text as asterisks of the same length.
        case maskedText
        /// An image with its pixels (`base64`).
        case image
        /// An image without pixels (a grey box in the player).
        case maskedImage
        /// Nothing of its own to mask (containers, switches, buttons).
        case plain
    }

    var content: Content
    /// `inputType` of an `input` wireframe: `text`, `password`, `search`,
    /// `text_area`; nil for other views.
    var inputType: String?
}

/// The masking rule of session replay (docs/SESSION-REPLAY.md section 5,
/// iOS): pure, so it is tested without UIKit.
///
/// - Every text input (`UITextField`, editable `UITextView`, `UISearchBar`)
///   shows asterisks, always: no option turns it off.
/// - A secure field (`isSecureTextEntry`, or a password, one-time code or
///   card `textContentType`) is masked and `inputType: password` whatever
///   else is set; nothing unmasks it.
/// - `UILabel` and a non-editable `UITextView` show their text.
/// - Images: no pixels while `maskAllImages` (the default); with it off,
///   pixels except in a marked subtree.
/// - A marked view (`cohorlyNoCapture`, `cohorly-no-capture`) and its subtree
///   become one placeholder.
enum ReplayMasking {
    /// `UITextContentType` raw values of secrets. The wireframe builder adds
    /// the SDK's own constants to this set, so a raw value that differs on
    /// some iOS version is still caught there.
    static let secureContentTypes: Set<String> = [
        "password", "new-password", "one-time-code",
        "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-type"
    ]

    static func isSecure(_ traits: ReplayViewTraits, secureContentTypes: Set<String> = secureContentTypes) -> Bool {
        if traits.isSecureTextEntry { return true }
        guard let type = traits.textContentType else { return false }
        return secureContentTypes.contains(type)
    }

    static func decide(
        _ traits: ReplayViewTraits, maskAllImages: Bool, secureContentTypes: Set<String> = secureContentTypes
    ) -> ReplayMaskDecision {
        // A marker hides everything, inputs included: one placeholder, no text.
        if traits.noCapture { return ReplayMaskDecision(content: .placeholder, inputType: nil) }
        let secure = isSecure(traits, secureContentTypes: secureContentTypes)
        switch traits.kind {
        case .textField:
            return ReplayMaskDecision(content: .maskedText, inputType: secure ? "password" : "text")
        case .searchBar:
            return ReplayMaskDecision(content: .maskedText, inputType: secure ? "password" : "search")
        case .textView where traits.isEditable:
            return ReplayMaskDecision(content: .maskedText, inputType: secure ? "password" : "text_area")
        default:
            break
        }
        switch traits.kind {
        case .textView:
            return ReplayMaskDecision(content: secure ? .maskedText : .text, inputType: nil)
        case .label:
            return ReplayMaskDecision(content: .text, inputType: nil)
        case .image:
            return ReplayMaskDecision(content: maskAllImages ? .maskedImage : .image, inputType: nil)
        default:
            return ReplayMaskDecision(content: .plain, inputType: nil)
        }
    }
}
