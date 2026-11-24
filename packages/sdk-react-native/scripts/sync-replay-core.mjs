#!/usr/bin/env node
// Copies the session replay recorders into this package, byte for byte, from
// their source of truth:
// - iOS: sdks/ios/Sources/CohorlyReplay/Recorder -> ios/CohorlyReplay/. The pod
//   compiles the copy next to ios/CohorlyReactNativeReplay.swift.
// - Android (VEL-2142): sdks/android/cohorly-replay/src/main/kotlin/com/cohorly/android/replay
//   -> android/src/main/java/com/cohorly/android/replay/. The library compiles
//   the copy next to CohorlyReactNativeReplay.kt. The files that talk to the
//   Cohorly Android SDK stay out (ANDROID_REPLAY_EXCLUDED).
// test/replay-core-sync.test.ts fails when a copy diverges or when a source
// file is missing from these lists. Only the files listed here are copied: a
// new recorder file is added on purpose.
import { copyFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Paths relative to Recorder/ (a subfolder is written `Sub/File.swift`), sorted. */
export const IOS_REPLAY_FILES = [
  "ReplayCaptureBackoff.swift",
  "ReplayCaptureScheduler.swift",
  "ReplayEvents.swift",
  "ReplayImageRenderer.swift",
  "ReplayLifecycle.swift",
  "ReplayMasking.swift",
  "ReplayMethodSwizzler.swift",
  "ReplayRecorder.swift",
  "ReplayRecorderTypes.swift",
  "ReplayRecordingPipeline.swift",
  "ReplayUtil.swift",
  "ReplayWindowStatus.swift",
  "ReplayWireframe.swift",
  "ScreenshotSnapshotSource.swift",
  "UIImage+CohorlyReplay.swift",
  "UIView+CohorlyReplay.swift",
  "WireframeBuilder.swift",
];

/**
 * Paths relative to the `com/cohorly/android/replay` package directory (a
 * subpackage is written `internal/Throttler.kt`), sorted. None of them may
 * import `com.cohorly.android.core`, `com.cohorly.android.crash` or
 * `com.cohorly.android.Cohorly`: the copy compiles against a cohorly-android
 * release that lacks those replay types.
 */
export const ANDROID_REPLAY_FILES = [
  "ChunkBuffer.kt",
  "CohorlyReplay.kt",
  "ComposeDetector.kt",
  "ComposeImageMask.kt",
  "ComposeMask.kt",
  "ComposeWireframes.kt",
  "Keyboard.kt",
  "RecorderTypes.kt",
  "ReplayRecorder.kt",
  "ScreenshotCapture.kt",
  "Sources.kt",
  "TouchRecorder.kt",
  "WireframeBuilder.kt",
  "compose/CohorlyNoCaptureModifier.kt",
  "internal/NextDrawListener.kt",
  "internal/PixelCopyBitmapBuffer.kt",
  "internal/ScreenshotScaling.kt",
  "internal/Throttler.kt",
  "internal/ViewTreeSnapshotStatus.kt",
  "rr/RREvent.kt",
  "rr/RRWireframe.kt",
];

/**
 * The native SDK's side of the recorder (the replay controller, the crash
 * reporter, `Cohorly.getInstance`'s entry point), never copied: in React
 * Native, android/.../reactnative/CohorlyReactNativeReplay.kt plays that part.
 */
export const ANDROID_REPLAY_EXCLUDED = ["ControllerSessionSource.kt", "ReplayInstaller.kt"];

const pkg = fileURLToPath(new URL("..", import.meta.url));
export const IOS_REPLAY_SOURCE = join(pkg, "../../sdks/ios/Sources/CohorlyReplay/Recorder");
export const IOS_REPLAY_TARGET = join(pkg, "ios/CohorlyReplay");
export const ANDROID_REPLAY_SOURCE = join(
  pkg,
  "../../sdks/android/cohorly-replay/src/main/kotlin/com/cohorly/android/replay",
);
export const ANDROID_REPLAY_TARGET = join(pkg, "android/src/main/java/com/cohorly/android/replay");

/** Replaces `target` with the listed files of `source`, byte for byte. */
function copyAll(source, target, files) {
  rmSync(target, { recursive: true, force: true });
  for (const file of files) {
    const to = join(target, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(source, file), to);
  }
}

function main() {
  copyAll(IOS_REPLAY_SOURCE, IOS_REPLAY_TARGET, IOS_REPLAY_FILES);
  console.log(`sync:replay: ${IOS_REPLAY_FILES.length} file(s) -> ios/CohorlyReplay`);
  copyAll(ANDROID_REPLAY_SOURCE, ANDROID_REPLAY_TARGET, ANDROID_REPLAY_FILES);
  console.log(
    `sync:replay: ${ANDROID_REPLAY_FILES.length} file(s) -> android/src/main/java/com/cohorly/android/replay`,
  );
}

// Run as a script (not when the sync test imports the lists).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
