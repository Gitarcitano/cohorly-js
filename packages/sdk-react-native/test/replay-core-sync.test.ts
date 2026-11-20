import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANDROID_REPLAY_EXCLUDED,
  ANDROID_REPLAY_FILES,
  ANDROID_REPLAY_SOURCE,
  ANDROID_REPLAY_TARGET,
  IOS_REPLAY_FILES,
  IOS_REPLAY_SOURCE,
  IOS_REPLAY_TARGET,
} from "../scripts/sync-replay-core.mjs";

// The pod and the Android library compile a copy of the session replay
// recorder; the source of truth is sdks/ios and sdks/android (absent in the
// published JS mirror, hence the skip). One case per platform.

/** Every file under `dir`, as sorted paths relative to it (`Sub/File.swift`). */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();

describe("ios/CohorlyReplay", () => {
  it.skipIf(!existsSync(IOS_REPLAY_SOURCE))(
    "is a byte-for-byte copy of sdks/ios/Sources/CohorlyReplay/Recorder (run `pnpm --filter @cohorly/react-native sync:replay`)",
    () => {
      // A recorder file missing from the script's list would never reach the pod.
      expect(IOS_REPLAY_FILES).toEqual(filesUnder(IOS_REPLAY_SOURCE).filter((f) => f.endsWith(".swift")));
      // Nothing more and nothing less in the copy.
      expect(filesUnder(IOS_REPLAY_TARGET)).toEqual(IOS_REPLAY_FILES);
      for (const file of IOS_REPLAY_FILES) {
        expect(readFileSync(join(IOS_REPLAY_TARGET, file)).equals(readFileSync(join(IOS_REPLAY_SOURCE, file))), file).toBe(
          true,
        );
      }
    },
  );
});

describe("android/src/main/java/com/cohorly/android/replay", () => {
  it.skipIf(!existsSync(ANDROID_REPLAY_SOURCE))(
    "is a byte-for-byte copy of the sdks/android recorder, SDK adapters left out (run `pnpm --filter @cohorly/react-native sync:replay`)",
    () => {
      const sources = filesUnder(ANDROID_REPLAY_SOURCE).filter((f) => f.endsWith(".kt"));
      // Every recorder file is either copied or left out on purpose, never both, never neither.
      for (const file of sources) {
        const lists = Number(ANDROID_REPLAY_FILES.includes(file)) + Number(ANDROID_REPLAY_EXCLUDED.includes(file));
        expect(lists, file).toBe(1);
      }
      expect([...ANDROID_REPLAY_FILES, ...ANDROID_REPLAY_EXCLUDED].sort()).toEqual(sources);
      // Nothing more and nothing less in the copy.
      expect(filesUnder(ANDROID_REPLAY_TARGET)).toEqual(ANDROID_REPLAY_FILES);
      for (const file of ANDROID_REPLAY_FILES) {
        const copy = readFileSync(join(ANDROID_REPLAY_TARGET, file));
        expect(copy.equals(readFileSync(join(ANDROID_REPLAY_SOURCE, file))), file).toBe(true);
        // The copy compiles against a cohorly-android release without the SDK's replay types.
        const sdkImports = copy
          .toString("utf8")
          .split("\n")
          .filter((line) =>
            /^\s*import\s+com\.cohorly\.android\.(core\.|crash\.|Cohorly\b)/.test(line),
          );
        expect(sdkImports, file).toEqual([]);
      }
    },
  );
});
