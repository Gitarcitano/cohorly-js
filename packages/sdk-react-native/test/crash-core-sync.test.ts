import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The pod compiles a copy of the Swift crash reporter core; the source of
// truth is sdks/ios (absent in the published JS mirror, hence the skip).
const source = new URL("../../../sdks/ios/Sources/CohorlyCrash/Core/", import.meta.url);
const copy = new URL("../ios/CohorlyCrash/", import.meta.url);

const swiftFiles = (dir: URL) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".swift"))
    .sort();

describe("ios/CohorlyCrash", () => {
  it.skipIf(!existsSync(source))(
    "is a byte-for-byte copy of sdks/ios/Sources/CohorlyCrash/Core (run `pnpm --filter @cohorly/react-native sync:crash`)",
    () => {
      expect(swiftFiles(copy)).toEqual(swiftFiles(source));
      for (const file of swiftFiles(source)) {
        expect(readFileSync(new URL(file, copy), "utf8"), file).toBe(readFileSync(new URL(file, source), "utf8"));
      }
    },
  );
});

describe("ios/CohorlyNativeCrashes.swift", () => {
  it("stamps the package version as $lib_version (scripts/sync-versions.mjs)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const swift = readFileSync(new URL("../ios/CohorlyNativeCrashes.swift", import.meta.url), "utf8");
    expect(/static let libVersion = "([^"]+)"/.exec(swift)?.[1]).toBe(pkg.version);
  });
});
