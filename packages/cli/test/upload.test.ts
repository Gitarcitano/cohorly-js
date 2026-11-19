import { readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { lookup, parseIndex } from "../src/index-format.js";
import { VERSION } from "../src/version.js";
import {
  fakeSymcache,
  fixtureMap,
  hermesPair,
  makeIo,
  type Responder,
  SOURCES_CONTENT_MARKER,
  startServer,
  tempDir,
  writeFiles,
} from "./helpers.js";

const DWARF_BYTES = Buffer.from("\xcf\xfa\xed\xfe DWARF_BYTES_MARKER_51d0", "latin1");
const ARM64_SLICE = { debugId: "b56f32c9-83ec-339f-9020-f46fa710bfe5", arch: "arm64", bytes: new Uint8Array([0x43, 0x48, 1, 2, 3]) };
const X86_SLICE = { debugId: "479e52dc-d599-3d16-b664-4f1135e71b5a", arch: "x86_64", bytes: new Uint8Array([0x43, 0x48, 4, 5, 6]) };

const TOKEN = "chrly_upload_s3cr3t_token_value";
const R8_MAPPING = [
  "# compiler: R8",
  "# compiler_version: 8.5.35",
  "# min_api: 24",
  '# {"id":"com.android.tools.r8.mapping","version":"2.2"}',
  "# pg_map_id: 3e7c1e3",
  "# pg_map_hash: SHA-256 3e7c1e3a9f",
  "com.example.app.MainActivity -> com.example.app.MainActivity:",
  "    void onCreate(android.os.Bundle) -> onCreate",
  "com.example.app.Checkout -> a.b:",
  "    1:4:void pay():12:15 -> a",
  "",
].join("\n");

let servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function server(responder?: Responder) {
  const s = await startServer(responder);
  servers.push(s);
  return s;
}

async function sourcemapDir() {
  const dir = await tempDir();
  await writeFiles(dir, {
    "assets/app.js": "x()\n//# sourceMappingURL=app.js.map\n",
    "assets/app.js.map": JSON.stringify({ ...fixtureMap(), debugId: "1b2c3d4e-0000-5000-8000-0000000000aa" }),
    "vendor.js.map": JSON.stringify(fixtureMap()),
    "styles.css.map": JSON.stringify(fixtureMap()),
  });
  return dir;
}

describe("sourcemaps upload", () => {
  it("PUTs one gzipped index per map with Bearer auth and the key in the query string", async () => {
    const s = await server();
    const dir = await sourcemapDir();
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    const code = await main(["sourcemaps", "upload", "--release", "web@2026.11.3", "--dist", "b71e04", dir], io);

    expect(code).toBe(0);
    expect(s.requests).toHaveLength(2);
    for (const req of s.requests) {
      expect(req.method).toBe("PUT");
      expect(req.pathname).toBe("/api/symbols/sourcemap-index");
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(req.headers["content-type"]).toBe("application/octet-stream");
      expect(req.headers["content-encoding"]).toBe("gzip");
      expect(req.body.toString("latin1")).not.toContain(SOURCES_CONTENT_MARKER);
    }
    expect(s.requests.map((r) => r.query)).toEqual([
      { release: "web@2026.11.3", dist: "b71e04", file: "~/assets/app.js", debug_id: "1b2c3d4e-0000-5000-8000-0000000000aa" },
      { release: "web@2026.11.3", dist: "b71e04", file: "~/vendor.js" },
    ]);
    const index = parseIndex(new Uint8Array(s.requests[0]!.body));
    expect(lookup(index, 1, 10)).toEqual({ source: "src/b.ts", line: 4, column: 4, name: null });
    expect(out.stdout).toContain("2 uploaded, 0 failed");
  });

  it("composes a Hermes pair into a single index for the bundle", async () => {
    const s = await server();
    const dir = await tempDir();
    const { packager, hermes } = hermesPair();
    await writeFiles(dir, {
      "index.android.bundle.map": JSON.stringify(packager),
      "index.android.hbc.map": JSON.stringify(hermes),
    });
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    expect(await main(["sourcemaps", "upload", "--release", "android@3.8.1+415", dir], io)).toBe(0);

    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.query).toEqual({ release: "android@3.8.1+415", file: "~/index.android.bundle" });
    const index = parseIndex(new Uint8Array(s.requests[0]!.body));
    expect(lookup(index, 1, 100)).toEqual({ source: "src/App.tsx", line: 10, column: 2, name: "onPress" });
  });

  it("keys a lone, already composed .hbc.map under the .bundle name like a pair", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "android/index-b08fdca.hbc.map": JSON.stringify(fixtureMap()) });
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], io)).toBe(0);
    expect(s.requests.map((r) => r.query.file)).toEqual(["~/android/index-b08fdca.bundle"]);
  });

  it("accepts an explicit Hermes pair", async () => {
    const s = await server();
    const dir = await tempDir();
    const { packager, hermes } = hermesPair();
    await writeFiles(dir, {
      "main.jsbundle.packager.map": JSON.stringify(packager),
      "main.jsbundle.compiler.map": JSON.stringify(hermes),
    });
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    const code = await main(
      [
        "sourcemaps",
        "upload",
        "--release",
        "ios@3.8.0+412",
        "--packager-map",
        path.join(dir, "main.jsbundle.packager.map"),
        "--hermes-map",
        path.join(dir, "main.jsbundle.compiler.map"),
        dir,
      ],
      io,
    );
    expect(code).toBe(0);
    expect(s.requests.map((r) => r.query.file)).toEqual(["~/main.jsbundle"]);
  });

  it("retries 5xx up to 3 attempts with exponential backoff", async () => {
    const s = await server(() => ({ status: 503, body: { error: "unavailable" } }));
    const dir = await tempDir();
    await writeFiles(dir, { "app.js.map": JSON.stringify(fixtureMap()) });
    const { io, out, sleeps } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });

    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], io)).toBe(1);
    expect(s.requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(out.stderr).toContain("HTTP 503");
    expect(out.stdout).toContain("0 uploaded, 1 failed");
  });

  it("succeeds when a retry succeeds", async () => {
    const s = await server((_req, n) => (n === 1 ? { status: 502 } : { status: 200, body: { id: "idx_9" } }));
    const dir = await tempDir();
    await writeFiles(dir, { "app.js.map": JSON.stringify(fixtureMap()) });
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });

    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], io)).toBe(0);
    expect(s.requests).toHaveLength(2);
    expect(out.stdout).toContain("uploaded ~/app.js (idx_9)");
  });

  it("waits out 429s for their Retry-After without spending attempts: a parallel build of the same org", async () => {
    // Five 429s (more than the 3 attempts), with Retry-After 3, none, 0 and
    // 600: honored, then the 1 s floor twice, then the 60 s cap.
    const retryAfter = ["3", undefined, "0", "600", "1"];
    const s = await server((_req, n) => {
      if (n > retryAfter.length) return { status: 201, body: { id: "idx_2" } };
      const header = retryAfter[n - 1];
      return { status: 429, body: { error: "upload busy" }, headers: header === undefined ? {} : { "retry-after": header } };
    });
    const dir = await tempDir();
    await writeFiles(dir, { "app.js.map": JSON.stringify(fixtureMap()) });
    const { io, out, sleeps } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });

    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], io)).toBe(0);
    expect(s.requests).toHaveLength(6);
    expect(sleeps).toEqual([3000, 1000, 1000, 60_000, 1000]);
    expect(out.stdout).toContain("uploaded ~/app.js (idx_2)");
  });

  it("gives up on a 429 that outlasts the 5 minute wait budget", async () => {
    const s = await server(() => ({ status: 429, body: { error: "upload busy" }, headers: { "retry-after": "60" } }));
    const dir = await tempDir();
    await writeFiles(dir, { "app.js.map": JSON.stringify(fixtureMap()) });
    const { io, out, sleeps } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });

    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], io)).toBe(1);
    expect(sleeps).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(s.requests).toHaveLength(6);
    expect(out.stderr).toContain("HTTP 429: upload busy (still busy after 300 s)");
  });

  it("honors a 5xx Retry-After instead of the backoff", async () => {
    const s = await server((_req, n) =>
      n === 1 ? { status: 503, body: { error: "server busy" }, headers: { "retry-after": "5" } } : { status: 201, body: { id: "idx_3" } },
    );
    const dir = await tempDir();
    await writeFiles(dir, { "app.js.map": JSON.stringify(fixtureMap()) });
    const { io, sleeps } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });

    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], io)).toBe(0);
    expect(sleeps).toEqual([5000]);
  });

  it("never retries a 4xx", async () => {
    const s = await server(() => ({ status: 400, body: { error: "release required" } }));
    const dir = await tempDir();
    await writeFiles(dir, { "app.js.map": JSON.stringify(fixtureMap()) });
    const { io, out, sleeps } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });

    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], io)).toBe(1);
    expect(s.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(out.stderr).toContain("HTTP 400: release required");
  });

  it("keeps uploading the rest when one upload fails, then exits non-zero", async () => {
    const s = await server((req) => (req.query.file === "~/a.js" ? { status: 403 } : { status: 201, body: { id: "ok" } }));
    const dir = await tempDir();
    await writeFiles(dir, {
      "a.js.map": JSON.stringify(fixtureMap()),
      "b.js.map": JSON.stringify(fixtureMap()),
      "c.js.map": "{ not json",
    });
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });

    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], io)).toBe(1);
    expect(s.requests.map((r) => r.query.file)).toEqual(["~/a.js", "~/b.js"]);
    expect(out.stderr).toContain("failed ~/a.js: HTTP 403");
    expect(out.stderr).toContain("failed ~/c.js");
    expect(out.stdout).toContain("1 uploaded, 2 failed");
  });
});

describe("credentials", () => {
  it("exits 1 before any request when the token is missing", async () => {
    const s = await server();
    const dir = await sourcemapDir();
    await writeFiles(dir, { "mapping.txt": R8_MAPPING });
    for (const argv of [
      ["sourcemaps", "upload", "--release", "r1", dir],
      ["debug-files", "upload", "--release", "r1", path.join(dir, "mapping.txt")],
    ]) {
      const { io, out } = makeIo({ COHORLY_API_URL: s.url });
      expect(await main(argv, io)).toBe(1);
      expect(out.stderr).toContain("missing upload token");
    }
    expect(s.requests).toHaveLength(0);
  });

  it("never prints the token, even when the server echoes it back", async () => {
    const s = await server((req, n) =>
      n === 1 ? { status: 201, body: { id: "ok" } } : { status: 401, body: { error: `bad token ${req.headers.authorization}` } },
    );
    const dir = await tempDir();
    await writeFiles(dir, { "a.js.map": JSON.stringify(fixtureMap()), "b.js.map": JSON.stringify(fixtureMap()) });

    const fromEnv = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    expect(await main(["sourcemaps", "upload", "--release", "r1", dir], fromEnv.io)).toBe(1);
    const fromFlag = makeIo({ COHORLY_API_URL: s.url });
    expect(await main(["sourcemaps", "upload", "--release", "r1", "--token", TOKEN, dir], fromFlag.io)).toBe(1);
    const fromFlagEquals = makeIo({ COHORLY_API_URL: s.url });
    expect(await main(["sourcemaps", "upload", "--release", "r1", `--token=${TOKEN}`, dir], fromFlagEquals.io)).toBe(1);

    expect(s.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    for (const { out } of [fromEnv, fromFlag, fromFlagEquals]) {
      expect(out.stderr).toContain("bad token");
      expect(`${out.stdout}${out.stderr}`).not.toContain(TOKEN);
    }
  });
});

describe("debug-files upload", () => {
  it("uploads mapping.txt byte for byte with its pg_map_id, on Linux too", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "app/build/outputs/mapping/release/mapping.txt": R8_MAPPING, "app/notes.txt": "x" });
    const fake = fakeSymcache({}, false);
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "linux", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "android@3.8.1+415", "--dist", "release", dir], io)).toBe(0);
    expect(s.requests).toHaveLength(1);
    const req = s.requests[0]!;
    expect(req.method).toBe("PUT");
    expect(req.pathname).toBe("/api/symbols/r8-mapping");
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.query).toEqual({ release: "android@3.8.1+415", dist: "release", map_id: "3e7c1e3" });
    const original = await readFile(path.join(dir, "app/build/outputs/mapping/release/mapping.txt"));
    expect(req.body.equals(original)).toBe(true);
  });

  it("uploads a single file without pg_map_id", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "proguard.txt": "a.b -> c:\n" });
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });

    expect(await main(["debug-files", "upload", "--release", "r1", path.join(dir, "proguard.txt")], io)).toBe(0);
    expect(s.requests[0]!.query).toEqual({ release: "r1" });
    expect(s.requests[0]!.body.toString()).toBe("a.b -> c:\n");
  });

  it("uploads one symcache per dSYM slice and never the DWARF bytes", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "build/App.app.dSYM/Contents/Resources/DWARF/App": DWARF_BYTES });
    const dsym = path.join(dir, "build/App.app.dSYM");
    const dwarf = path.join(dsym, "Contents/Resources/DWARF/App");

    for (const target of [dir, dsym, dwarf]) {
      s.requests.length = 0;
      const fake = fakeSymcache({ App: [ARM64_SLICE, X86_SLICE] });
      const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "darwin", symcache: fake.builder });
      expect(await main(["debug-files", "upload", "--release", "ios@3.8.0+412", "--dist", "d1", target], io)).toBe(0);

      expect(fake.built).toEqual([dwarf]);
      expect(s.requests.map((r) => [r.method, r.pathname, r.query])).toEqual([
        ["PUT", "/api/symbols/symcache", { release: "ios@3.8.0+412", dist: "d1", debug_id: ARM64_SLICE.debugId, arch: "arm64" }],
        ["PUT", "/api/symbols/symcache", { release: "ios@3.8.0+412", dist: "d1", debug_id: X86_SLICE.debugId, arch: "x86_64" }],
      ]);
      expect(s.requests[0]!.body.equals(Buffer.from(ARM64_SLICE.bytes))).toBe(true);
      expect(s.requests[1]!.body.equals(Buffer.from(X86_SLICE.bytes))).toBe(true);
      for (const req of s.requests) expect(req.body.includes(DWARF_BYTES)).toBe(false);
    }
  });

  it("refuses a dSYM outside macOS before any request, even next to a mapping.txt", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "App.app.dSYM/Contents/Resources/DWARF/App": DWARF_BYTES, "mapping.txt": R8_MAPPING });
    const fake = fakeSymcache({ App: [ARM64_SLICE] });
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "linux", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "r1", dir], io)).toBe(1);
    expect(out.stderr).toContain("macOS");
    expect(out.stderr).toContain("xcrun dwarfdump");
    expect(fake.built).toEqual([]);
    expect(s.requests).toHaveLength(0);
  });

  it("refuses a dSYM on a Mac without the Xcode command line tools", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "App.app.dSYM/Contents/Resources/DWARF/App": DWARF_BYTES, "mapping.txt": R8_MAPPING });
    const fake = fakeSymcache({ App: [ARM64_SLICE] }, false);
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "darwin", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "r1", dir], io)).toBe(1);
    expect(out.stderr).toContain("Command Line Tools");
    expect(out.stderr).toContain("xcode-select --install");
    expect(fake.built).toEqual([]);
    expect(s.requests).toHaveLength(0);
  });

  it("uploads mapping.txt and the dSYM of one directory on macOS", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "App.app.dSYM/Contents/Resources/DWARF/App": DWARF_BYTES, "mapping.txt": R8_MAPPING });
    const fake = fakeSymcache({ App: [ARM64_SLICE] });
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "darwin", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "r1", dir], io)).toBe(0);
    expect(s.requests.map((r) => [r.pathname, r.query])).toEqual([
      ["/api/symbols/r8-mapping", { release: "r1", map_id: "3e7c1e3" }],
      ["/api/symbols/symcache", { release: "r1", debug_id: ARM64_SLICE.debugId, arch: "arm64" }],
    ]);
  });

  it("refuses, before any request, a directory where one of several dSYMs has no DWARF file", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, {
      "Shop.app.dSYM/Contents/Resources/DWARF/Shop": DWARF_BYTES,
      "Empty.framework.dSYM/Contents/Info.plist": "plist",
    });
    const fake = fakeSymcache({ Shop: [ARM64_SLICE] });
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "darwin", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "r1", dir], io)).toBe(1);
    expect(out.stderr).toContain("Empty.framework.dSYM/Contents/Resources/DWARF");
    expect(out.stderr).not.toContain("Shop.app.dSYM/Contents/Resources/DWARF");
    expect(s.requests).toHaveLength(0);
  });

  it("follows a symlinked dSYM, and a link cycle does not loop", async () => {
    const s = await server();
    const real = await tempDir();
    await writeFiles(real, { "Shop.app.dSYM/Contents/Resources/DWARF/Shop": DWARF_BYTES });
    const dir = await tempDir();
    await writeFiles(dir, { "mapping.txt": R8_MAPPING });
    await symlink(path.join(real, "Shop.app.dSYM"), path.join(dir, "Shop.app.dSYM"));
    await symlink(dir, path.join(dir, "loop"));
    const fake = fakeSymcache({ Shop: [ARM64_SLICE] });
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "darwin", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "r1", dir], io)).toBe(0);
    expect(fake.built).toEqual([path.join(dir, "Shop.app.dSYM/Contents/Resources/DWARF/Shop")]);
    expect(s.requests.map((r) => r.pathname)).toEqual(["/api/symbols/r8-mapping", "/api/symbols/symcache"]);
  });

  it("uploads a dSYM once when a symlink next to it points at it", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "App.app.dSYM/Contents/Resources/DWARF/App": DWARF_BYTES });
    await symlink(path.join(dir, "App.app.dSYM"), path.join(dir, "Alias.app.dSYM"));
    const fake = fakeSymcache({ App: [ARM64_SLICE] });
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "darwin", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "r1", dir], io)).toBe(0);
    expect(fake.built).toHaveLength(1);
    expect(s.requests.map((r) => r.query.debug_id)).toEqual([ARM64_SLICE.debugId]);
  });

  it("reports a failed dSYM file or slice on its own and keeps uploading the rest", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, {
      "Broken.framework.dSYM/Contents/Resources/DWARF/Broken": DWARF_BYTES,
      "Shop.app.dSYM/Contents/Resources/DWARF/Shop": DWARF_BYTES,
    });
    const fake = fakeSymcache({
      Broken: new Error("dwarfdump exited 1"),
      Shop: [{ arch: "armv7", error: "armv7: no LC_UUID" }, ARM64_SLICE],
    });
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "darwin", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "r1", dir], io)).toBe(1);
    expect(fake.built.map((f) => path.basename(f))).toEqual(["Broken", "Shop"]);
    expect(s.requests.map((r) => r.query.debug_id)).toEqual([ARM64_SLICE.debugId]);
    expect(out.stderr).toContain("dwarfdump exited 1");
    expect(out.stderr).toContain("armv7: no LC_UUID");
    expect(out.stdout).toContain("1 uploaded, 2 failed");
  });

  it("skips an unsupported 32-bit slice (watchOS arm64_32) with a warning and still exits 0", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "Watch.appex.dSYM/Contents/Resources/DWARF/Watch": DWARF_BYTES });
    const fake = fakeSymcache({
      Watch: [{ arch: "arm64_32", unsupported: true, error: "arm64_32: 32-bit Mach-O slices are not supported" }, ARM64_SLICE],
    });
    const { io, out } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url }, { platform: "darwin", symcache: fake.builder });

    expect(await main(["debug-files", "upload", "--release", "r1", dir], io)).toBe(0);
    expect(s.requests.map((r) => r.query.debug_id)).toEqual([ARM64_SLICE.debugId]);
    expect(out.stderr).toContain("warning: skipped");
    expect(out.stderr).toContain("arm64_32: 32-bit Mach-O slices are not supported");
    expect(out.stdout).toContain("1 uploaded, 0 failed, 1 skipped");
  });

  it("refuses a single binary file as an R8 mapping", async () => {
    const s = await server();
    const dir = await tempDir();
    await writeFiles(dir, { "libfoo.so": new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]) });
    const { io } = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN, COHORLY_API_URL: s.url });
    expect(await main(["debug-files", "upload", "--release", "r1", path.join(dir, "libfoo.so")], io)).not.toBe(0);
    expect(s.requests).toHaveLength(0);
  });
});

describe("cli", () => {
  it("prints the version and per-command help", async () => {
    const version = makeIo({});
    expect(await main(["--version"], version.io)).toBe(0);
    expect(version.out.stdout).toBe(`${VERSION}\n`);

    for (const argv of [
      ["sourcemaps", "inject", "--help"],
      ["sourcemaps", "upload", "--help"],
      ["debug-files", "upload", "--help"],
      ["react-native", "xcode", "--help"],
      ["react-native", "gradle", "--help"],
      ["expo", "upload-update", "--help"],
    ]) {
      const { io, out } = makeIo({});
      expect(await main(argv, io)).toBe(0);
      expect(out.stdout).toContain(`Usage: cohorly ${argv[0]} ${argv[1]}`);
    }
  });

  it("rejects a missing --release and unknown commands", async () => {
    const missing = makeIo({ COHORLY_UPLOAD_TOKEN: TOKEN });
    expect(await main(["sourcemaps", "upload", "dist"], missing.io)).toBe(1);
    expect(missing.out.stderr).toContain("--release");

    const unknown = makeIo({});
    expect(await main(["sourcemap", "push"], unknown.io)).toBe(1);
    expect(unknown.out.stderr).toContain("unknown command");
  });
});
