// Session replay recorder: copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/.
// Edit it here, then run `pnpm --filter @cohorly/react-native sync:replay`; see ReplayRecorderTypes.swift.

import Foundation

#if canImport(UIKit)
import UIKit
#endif

enum ReplayLifecycleEvent: Sendable {
    case didEnterBackground
    case willEnterForeground
}

/// Where foreground/background transitions come from (UIKit live, a fake in
/// tests).
protocol ReplayLifecycleSource: AnyObject {
    func start(_ handler: @escaping @Sendable (ReplayLifecycleEvent) -> Void)
    func stop()
}

/// UIApplication notifications. Without UIKit (a macOS host) the app counts
/// as always in the foreground.
final class SystemReplayLifecycle: ReplayLifecycleSource {
    private var observers: [NSObjectProtocol] = []

    func start(_ handler: @escaping @Sendable (ReplayLifecycleEvent) -> Void) {
        stop()
        #if canImport(UIKit) && !os(watchOS)
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
                handler(.didEnterBackground)
            },
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { _ in
                handler(.willEnterForeground)
            }
        ]
        #endif
    }

    func stop() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
    }

    deinit { stop() }
}
