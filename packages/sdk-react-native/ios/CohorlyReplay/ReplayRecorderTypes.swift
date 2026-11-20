import Foundation

// Recorder of the session replay (VEL-2153). Files under Recorder/ (the view
// walk, wireframes, screenshots and their masking, the capture scheduler,
// touches, the lifecycle, the rrweb events and the recording pipeline) import
// only Foundation, CoreFoundation, UIKit and ObjectiveC, never `Cohorly`: they know
// nothing of the session store, the chunk queue or the transport, which
// reach them through `ReplayRecorderHost` and `ReplayEventSink`. They are
// copied byte for byte into packages/sdk-react-native/ios/CohorlyReplay/
// (`pnpm --filter @cohorly/react-native sync:replay`, an explicit file list
// in scripts/sync-replay-core.mjs), and a vitest test fails when the copies
// diverge or a file here is missing from that list. Edit them here, then run
// the sync. Nothing here is `public`: the copy is compiled into the
// `CohorlyReactNative` pod and must not add to its API.

/// A JSON value, the shape of every recorded event (rrweb envelope,
/// wireframes). The recorder's own type, so the copy compiled into the React
/// Native pod needs no `Cohorly`; same cases and coding as `Cohorly.JSONValue`.
enum ReplayJSON: Codable, Equatable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([ReplayJSON])
    case object([String: ReplayJSON])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([ReplayJSON].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: ReplayJSON].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

/// What a session records: everything, the buffer sent on errors, or nothing.
enum ReplayMode: String, Codable, Sendable {
    case session
    case error
    case off
}

/// The mode a delivery of recorded events goes out in (`ReplayMode` minus
/// `.off`), the chunk's `mode` on the wire.
enum ReplayChunkMode: String, Codable, Sendable {
    case session
    case error
}

/// What became of events the recorder handed to its host
/// (`ReplayRecorderHost.enqueueRecorded`).
enum ReplayAdmission: Equatable, Sendable {
    /// Taken (an event or group alone over the host's size limit aside).
    case queued
    /// Nothing taken (the host is stopped, paused or refuses this session):
    /// the recorder's next capture of that session is a full snapshot.
    case refused
    /// Took what fits, but a Meta + Full snapshot pair alone over the
    /// host's size limit was dropped (both events).
    case snapshotDropped
}

enum ReplayLog {
    static func log(_ message: String) {
        NSLog("[Cohorly] %@", message)
    }
}

/// How the screen is described: one wireframe per view, or one masked JPEG
/// of the window per capture.
enum ReplayCaptureMode: Equatable, Sendable {
    case wireframe
    case screenshot
}

/// What a recorder's capture source is built from.
struct ReplayRecorderConfig: Equatable, Sendable {
    var captureMode: ReplayCaptureMode
    /// Every image masked (wireframes without pixels, screenshot areas painted).
    var maskAllImages: Bool

    #if os(iOS)
    /// The capture source of this config.
    func makeSource() -> ReplaySnapshotSource {
        switch captureMode {
        case .wireframe:
            return WireframeSnapshotSource(maskAllImages: maskAllImages)
        case .screenshot:
            return ScreenshotSnapshotSource(maskAllImages: maskAllImages)
        }
    }
    #endif
}
