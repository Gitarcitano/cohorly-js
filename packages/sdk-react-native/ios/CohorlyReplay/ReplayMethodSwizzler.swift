// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

// Adapted from PostHog/posthog-ios (MIT), commit a0a71796c2740a82c8a08059bff0f9d464720db0:
// PostHog/Replay/MethodSwizzler.swift, which carries this notice:
//
//   Unless explicitly stated otherwise all files in this repository are licensed under the
//   Apache License Version 2.0.
//   This product includes software developed at Datadog (https://www.datadoghq.com/).
//   Copyright 2019-Present Datadog, Inc.
//
// Changed: renamed; its own error type; no unswizzle (the touch swizzle is installed once per
// process and stays, a subscriber list decides who hears it); plus the `UIApplication.sendEvent`
// touch source built on it (PostHog's ApplicationEventPublisher does the same with an
// implementation exchange).
//
// posthog-ios: Copyright (c) 2023 PostHog. Licensed under the MIT License:
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
import Foundation
import ObjectiveC
import UIKit

struct ReplaySwizzleError: Error, CustomStringConvertible {
    let description: String
}

/// Replaces an Objective-C method's implementation with a block that gets
/// the implementation it replaced, so the block always calls on whatever
/// was there before (the original, or another library's swizzle).
final class ReplayMethodSwizzler<TypedIMP, TypedBlockIMP> {
    struct FoundMethod: Hashable {
        let method: Method
        private let klass: AnyClass

        fileprivate init(method: Method, klass: AnyClass) {
            self.method = method
            self.klass = klass
        }

        static func == (lhs: FoundMethod, rhs: FoundMethod) -> Bool {
            lhs.method == rhs.method && NSStringFromClass(lhs.klass) == NSStringFromClass(rhs.klass)
        }

        func hash(into hasher: inout Hasher) {
            hasher.combine("\(NSStringFromSelector(method_getName(method)))|||\(NSStringFromClass(klass))")
        }
    }

    private var implementationCache: [FoundMethod: IMP] = [:]

    /// The method `selector` resolves to on `klass` or its nearest superclass.
    static func findMethod(with selector: Selector, in klass: AnyClass) throws -> FoundMethod {
        var headKlass: AnyClass? = klass
        while let someKlass = headKlass {
            if let found = findMethod(with: selector, inExactly: someKlass) {
                return FoundMethod(method: found, klass: someKlass)
            }
            headKlass = class_getSuperclass(someKlass)
        }
        throw ReplaySwizzleError(description: "\(NSStringFromSelector(selector)) is not found in \(NSStringFromClass(klass))")
    }

    func originalImplementation(of found: FoundMethod) -> TypedIMP {
        sync {
            let originalImp: IMP = implementationCache[found] ?? method_getImplementation(found.method)
            return unsafeBitCast(originalImp, to: TypedIMP.self)
        }
    }

    /// `impProvider` gets the implementation in place now and returns the
    /// block that replaces it.
    func swizzle(_ foundMethod: FoundMethod, impProvider: (TypedIMP) -> TypedBlockIMP) {
        sync {
            let currentIMP = method_getImplementation(foundMethod.method)
            let currentTypedIMP = unsafeBitCast(currentIMP, to: TypedIMP.self)
            let newImpBlock: TypedBlockIMP = impProvider(currentTypedIMP)
            let newImp: IMP = imp_implementationWithBlock(newImpBlock)
            if implementationCache[foundMethod] == nil {
                implementationCache[foundMethod] = currentIMP
            }
            method_setImplementation(foundMethod.method, newImp)
        }
    }

    @discardableResult
    private func sync<T>(block: () -> T) -> T {
        objc_sync_enter(self)
        defer { objc_sync_exit(self) }
        return block()
    }

    private static func findMethod(with selector: Selector, inExactly klass: AnyClass) -> Method? {
        var methodsCount: UInt32 = 0
        guard let methods = class_copyMethodList(klass, &methodsCount) else { return nil }
        defer { free(methods) }
        for index in 0..<Int(methodsCount) {
            let method = methods.advanced(by: index).pointee
            if method_getName(method) == selector { return method }
        }
        return nil
    }
}

/// Touches from `UIApplication.sendEvent(_:)`, swizzled once per process
/// the first time a recorder starts and never removed: a subscriber list
/// decides who hears them, and with none the swizzle only forwards. The
/// replacement always calls the implementation it replaced (the original,
/// or another library's swizzle installed before), after the subscribers,
/// so a handler of the touch cannot hide a view before it is read.
final class ReplayTouchPublisher {
    static let shared = ReplayTouchPublisher()

    private typealias SendEventIMP = @convention(c) (AnyObject, Selector, UIEvent) -> Void
    private typealias SendEventBlock = @convention(block) (AnyObject, UIEvent) -> Void

    private let lock = NSLock()
    private var installed = false
    private var subscribers: [UUID: (UIEvent) -> Void] = [:]
    private let swizzler = ReplayMethodSwizzler<SendEventIMP, SendEventBlock>()
    /// The class whose `sendEvent:` is swizzled: `UIApplication`, or a
    /// stand-in in tests.
    private let targetClass: AnyClass

    init(targetClass: AnyClass = UIApplication.self) {
        self.targetClass = targetClass
    }

    /// Adds `handler` (main thread, every event); returns its key for
    /// `unsubscribe`. Installs the swizzle the first time.
    func subscribe(_ handler: @escaping (UIEvent) -> Void) -> UUID {
        let id = UUID()
        lock.lock()
        subscribers[id] = handler
        let mustInstall = !installed
        installed = true
        lock.unlock()
        if mustInstall { install() }
        return id
    }

    func unsubscribe(_ id: UUID) {
        lock.lock()
        subscribers[id] = nil
        lock.unlock()
    }

    private func install() {
        let selector = #selector(UIApplication.sendEvent(_:))
        do {
            let method = try ReplayMethodSwizzler<SendEventIMP, SendEventBlock>.findMethod(
                with: selector, in: targetClass)
            swizzler.swizzle(method) { [weak self] original -> SendEventBlock in
                return { application, event in
                    self?.publish(event)
                    original(application, selector, event)
                }
            }
        } catch {
            ReplayLog.log("session replay could not follow touches: \(error)")
        }
    }

    private func publish(_ event: UIEvent) {
        guard event.type == .touches else { return }
        lock.lock()
        let handlers = Array(subscribers.values)
        lock.unlock()
        handlers.forEach { $0(event) }
    }
}

/// `ReplayTouchSource` over `ReplayTouchPublisher`: touch starts, ends and
/// cancellations, positions in points in the touch's window, with that
/// window's key and whether it is the key window a capture records (the
/// recorder keeps only those of the window it records).
/// `start` and `stop` hold one lock across the subscription change, so a
/// `stop` racing a `start` never leaves a subscriber behind.
final class SendEventTouchSource: ReplayTouchSource {
    private let lock = NSLock()
    private var subscription: UUID?
    private let publisher: ReplayTouchPublisher

    init(publisher: ReplayTouchPublisher = .shared) {
        self.publisher = publisher
    }

    func start(_ handler: @escaping ([ReplayRawTouch]) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        if let previous = subscription { publisher.unsubscribe(previous) }
        subscription = publisher.subscribe { event in
            // Read once per event, by the rule the captures use.
            var keyWindow: UIWindow?
            var keyWindowRead = false
            let touches = (event.allTouches ?? []).compactMap { touch -> ReplayRawTouch? in
                let kind: ReplayEvents.TouchKind
                switch touch.phase {
                case .began: kind = .start
                case .ended, .cancelled: kind = .end
                default: return nil
                }
                guard let window = touch.window else { return nil }
                let point = touch.location(in: window)
                if !keyWindowRead {
                    keyWindow = WireframeSnapshotSource.keyWindow()
                    keyWindowRead = true
                }
                return ReplayRawTouch(kind: kind, x: Double(point.x), y: Double(point.y),
                                      windowKey: ObjectIdentifier(window).hashValue,
                                      isKeyWindow: keyWindow === window)
            }
            if !touches.isEmpty { handler(touches) }
        }
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        if let id = subscription { publisher.unsubscribe(id) }
        subscription = nil
    }
}
#endif
