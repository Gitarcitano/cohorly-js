import CommonCrypto
import Foundation

/// Shared pieces of the `$exception` payload (docs/NATIVE-SYMBOLICATION.md
/// section 1) used by the KSCrash and MetricKit converters.
enum CrashPayload {
    /// SDK-side caps: at most this many threads in `$exception_threads`...
    static let maxThreads = 20
    /// ...and this many frames per stack, dropping the oldest calls.
    static let maxFrames = 100

    /// One native frame. `function` is only set on `in_app: false` frames:
    /// a release binary is stripped, so the runtime's nearest symbol for an
    /// app frame is wrong and would poison the fingerprint.
    static func frame( // swiftlint:disable:this function_parameter_count
        module: String,
        instructionAddr: UInt64,
        imageAddr: UInt64,
        debugId: String,
        inApp: Bool,
        function: String?
    ) -> [String: Any] {
        var frame: [String: Any] = [
            "platform": "native",
            "module": module,
            "instruction_addr": hex(instructionAddr),
            "image_addr": hex(imageAddr),
            "debug_id": debugId,
            "in_app": inApp
        ]
        if !inApp, let function, !function.isEmpty { frame["function"] = function }
        return frame
    }

    /// Frames are oldest call first with the crashing frame last, so the cap
    /// keeps the LAST `maxFrames`: the crashing end survives.
    static func capFrames(_ frames: [[String: Any]]) -> [[String: Any]] {
        frames.count > maxFrames ? Array(frames.suffix(maxFrames)) : frames
    }

    static func stacktrace(_ frames: [[String: Any]]) -> [String: Any] {
        ["type": "raw", "frames": capFrames(frames)]
    }

    /// "0x" + 16 lowercase hex digits.
    static func hex(_ value: UInt64) -> String {
        let digits = String(value, radix: 16)
        return "0x" + String(repeating: "0", count: max(0, 16 - digits.count)) + digits
    }

    static func uint(_ value: Any?) -> UInt64? {
        if let number = value as? NSNumber { return number.uint64Value }
        if let string = value as? String {
            if string.hasPrefix("0x") || string.hasPrefix("0X") { return UInt64(string.dropFirst(2), radix: 16) }
            return UInt64(string)
        }
        return nil
    }

    /// A Mach-O LC_UUID as the contract wants it: lowercase, hyphenated.
    static func debugId(_ uuid: String?) -> String {
        guard let uuid, !uuid.isEmpty else { return "" }
        if let parsed = UUID(uuidString: uuid) { return parsed.uuidString.lowercased() }
        // 32 hex digits without separators.
        let hexDigits = uuid.lowercased().filter(\.isHexDigit)
        guard hexDigits.count == 32 else { return uuid.lowercased() }
        let chars = Array(hexDigits)
        let parts = [0..<8, 8..<12, 12..<16, 16..<20, 20..<32].map { String(chars[$0]) }
        return parts.joined(separator: "-")
    }

    static func basename(_ path: String) -> String {
        (path as NSString).lastPathComponent
    }

    /// In-app = the image lives inside an `.app` bundle and not under a system
    /// prefix (device OS, simulator runtime).
    static func isInApp(path: String) -> Bool {
        guard path.contains(".app/") else { return false }
        for prefix in ["/System/", "/usr/", "/Library/Developer/CoreSimulator/Volumes/"] where path.hasPrefix(prefix) {
            return false
        }
        return !path.contains("/RuntimeRoot/")
    }

    /// A UUID derived from the SHA-256 of `data` (version nibble 8, RFC 9562
    /// variant), so the same input always yields the same `$insert_id` and a
    /// resend dedups on the server.
    static func stableUUID(_ data: Data) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(buffer.count), &digest)
        }
        var bytes = Array(digest.prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x80
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hexString = bytes.map { byte -> String in
            let digits = String(byte, radix: 16)
            return digits.count == 1 ? "0" + digits : digits
        }.joined()
        return debugId(hexString)
    }

    /// Canonical JSON (sorted keys) of a JSON-compatible dictionary.
    static func canonicalJSON(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }

    static func event(properties: [String: Any]) -> [String: Any] {
        ["event": "$exception", "properties": properties]
    }
}
