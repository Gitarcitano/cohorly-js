import Foundation

// Resolve/reject block types match RCTPromiseResolveBlock/RCTPromiseRejectBlock's
// underlying signatures exactly, so this file needs no bridging header / `import React` -
// the .m extern-module file is what actually links this to the RN bridge.
@objc(CohorlyReactNative)
class CohorlyReactNativeModule: NSObject {
    @objc
    static func requiresMainQueueSetup() -> Bool { false }

    @objc(getDeviceInfo:rejecter:)
    func getDeviceInfo(
        _ resolve: @escaping (Any?) -> Void,
        rejecter reject: @escaping (String?, String?, Error?) -> Void
    ) {
        resolve(CohorlyDeviceInfo.asDictionary())
    }

    /// Writes the native crash reporter config (`cohorly.crash.config`), see
    /// `CohorlyNativeCrashes.configure(json:)`.
    @objc(configureNativeCrashes:)
    func configureNativeCrashes(_ json: String) {
        CohorlyNativeCrashes.configure(json: json)
    }
}
