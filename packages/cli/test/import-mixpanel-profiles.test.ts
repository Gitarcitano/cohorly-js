import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { hashValue } from "../src/import-mixpanel.js";
import { importMixpanelProfiles, type ProfileLimits } from "../src/import-mixpanel-profiles.js";
import { makeIo, tempDir } from "./helpers.js";
import { fakeProfilesServer, generatedProfileLines, json, PROFILES_JSONL_FIXTURE, PROFILES_PAGE_FIXTURE } from "./import-fake.js";

const TOKEN = "chrly_org_import_s3cr3t_token_value";
const API = "https://api.example.com";
type Fake = ReturnType<typeof fakeProfilesServer>;
type Profile = { $distinct_id: string; $properties: Record<string, unknown> };

const pageText = () => readFile(PROFILES_PAGE_FIXTURE, "utf8");
const jsonlText = () => readFile(PROFILES_JSONL_FIXTURE, "utf8");

async function run(args: string[], fake: Fake, env: Record<string, string | undefined> = {}, limits?: ProfileLimits) {
  const { io, out, sleeps } = makeIo({ COHORLY_IMPORT_TOKEN: TOKEN, COHORLY_API_URL: API, ...env }, { fetch: fake.fetch });
  if (limits) {
    try {
      return { code: await importMixpanelProfiles(args, io, limits), out, sleeps };
    } catch (err) {
      out.stderr += `${err instanceof Error ? err.message : String(err)}\n`;
      return { code: 1, out, sleeps };
    }
  }
  const code = await main(["import", "mixpanel-profiles", ...args], io);
  return { code, out, sleeps };
}

const sent = (fake: Fake) => fake.requests.flatMap((r) => r.profiles as Profile[]);
const progressOf = async (file: string) => JSON.parse(await readFile(`${file}.cohorly-import.json`, "utf8"));

async function inputFile(content: string | Uint8Array, name = "profiles.jsonl") {
  const dir = await tempDir();
  const file = path.join(dir, name);
  await writeFile(file, content);
  return { dir, file };
}

function csvRows(csv: string) {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => {
      const [reason, read, applied, refused] = l.split(",");
      return { reason, read: Number(read), applied: Number(applied), refused: Number(refused) };
    });
}

describe("import mixpanel-profiles: reading (T1-T3)", () => {
  it("sends exactly the file's profiles from a results page, ignoring page, session_id, status and total", async () => {
    const { file } = await inputFile(await pageText(), "page.json");
    const fake = fakeProfilesServer();
    const { code } = await run(["--project", "7", file], fake);

    expect(code).toBe(0);
    expect(sent(fake).map((p) => p.$distinct_id)).toEqual(["user-1", "user-2", "user-3", "user-4"]);
    expect(sent(fake)[0]).toEqual({
      $distinct_id: "user-1",
      $properties: {
        $email: "ada@example.com",
        $name: "Ada",
        $last_seen: "2024-03-01T10:00:00",
        $timezone: "America/Sao_Paulo",
        plan: "pro",
      },
    });
    expect(Object.keys(sent(fake)[0]!).sort()).toEqual(["$distinct_id", "$properties"]);
    expect(sent(fake)[2]).toEqual({ $distinct_id: "user-3", $properties: {} });

    const req = fake.requests[0]!;
    expect(req.url).toBe(`${API}/api/import/profiles?projectId=7`);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["content-encoding"]).toBe("gzip");
  });

  it("sends the same profiles from one profile per line, from a root array and from a pretty-printed or gzipped page", async () => {
    const expected = sent(await (async () => {
      const { file } = await inputFile(await pageText(), "page.json");
      const fake = fakeProfilesServer();
      await run(["--project", "7", file], fake);
      return fake;
    })());
    const array = JSON.stringify(JSON.parse(await pageText()).results, null, 2);
    const minified = JSON.stringify(JSON.parse(await pageText()));
    const cases: [string, string | Uint8Array, string][] = [
      ["jsonl", await jsonlText(), "profiles.jsonl"],
      ["array", array, "array.json"],
      ["minified page", minified, "min.json"],
      ["jsonl with a json extension", await jsonlText(), "lines.json"],
      ["gzipped page", gzipSync(await pageText()), "page.json.gz"],
    ];
    for (const [label, content, name] of cases) {
      const { file } = await inputFile(content, name);
      const fake = fakeProfilesServer();
      expect((await run(["--project", "7", file], fake)).code, label).toBe(0);
      expect(sent(fake), label).toEqual(expected);
    }
  });

  it("reads a directory in name order, each file in its own format", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "b.jsonl"), generatedProfileLines(2, 10).join("\n"));
    await writeFile(path.join(dir, "a.json"), await pageText());
    await writeFile(path.join(dir, "notes.txt"), "ignored");
    const fake = fakeProfilesServer();
    expect((await run(["--project", "7", dir], fake)).code).toBe(0);
    expect(sent(fake).map((p) => p.$distinct_id)).toEqual(["user-1", "user-2", "user-3", "user-4", "user-10", "user-11"]);
  });

  it("loses and duplicates nothing at batch boundaries, by count and by size", async () => {
    const lines = generatedProfileLines(12);
    const { file } = await inputFile(lines.join("\n"));
    for (const limits of [
      { maxProfiles: 5, maxBytes: 8 * 1024 * 1024 },
      { maxProfiles: 1, maxBytes: 8 * 1024 * 1024 },
      { maxProfiles: 5000, maxBytes: 300 },
    ]) {
      const fake = fakeProfilesServer();
      const { code } = await run(["--project", "7", "--restart", file], fake, {}, limits);
      expect(code).toBe(0);
      expect(fake.requests.length).toBeGreaterThan(1);
      for (const r of fake.requests) expect(r.profiles.length).toBeLessThanOrEqual(limits.maxProfiles);
      expect(sent(fake).map((p) => p.$distinct_id)).toEqual(Array.from({ length: 12 }, (_, i) => `user-${i + 1}`));
      expect(fake.stored.size).toBe(12);
    }
  });

  it("counts a bad line, a non-object and a missing $distinct_id as refused without aborting the file", async () => {
    const content = [
      JSON.stringify({ $distinct_id: "ok-1", $properties: { a: 1 } }),
      "this is not json",
      JSON.stringify([1, 2]),
      JSON.stringify({ $properties: { a: 1 } }),
      "",
      JSON.stringify({ $distinct_id: "ok-2" }),
      JSON.stringify({ $distinct_id: "ok-3", $properties: "nope" }),
    ].join("\n");
    const { dir, file } = await inputFile(content);
    const report = path.join(dir, "report.csv");
    const fake = fakeProfilesServer();
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);

    expect(code).toBe(0);
    expect(sent(fake).map((p) => p.$distinct_id)).toEqual(["ok-1", "ok-2"]);
    expect(out.stderr).toContain("profile 2: invalid_profile");
    expect(out.stderr).toContain("profile 4: missing_distinct_id");
    expect(csvRows(await readFile(report, "utf8"))).toEqual([
      { reason: "", read: 2, applied: 2, refused: 0 },
      { reason: "invalid_profile", read: 3, applied: 0, refused: 3 },
      { reason: "missing_distinct_id", read: 1, applied: 0, refused: 1 },
      { reason: "total", read: 6, applied: 2, refused: 4 },
    ]);
  });

  it("shows the server's own refusals by reason", async () => {
    const { dir, file } = await inputFile(generatedProfileLines(3).join("\n"));
    const report = path.join(dir, "report.csv");
    const fake = fakeProfilesServer({
      override: (req) => {
        const n = req.profiles.length;
        return json(200, { status: 1, received: n, applied: n - 1, refused: [{ index: 1, reason: "invalid_profile" }] });
      },
    });
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    expect(csvRows(await readFile(report, "utf8")).slice(0, 2)).toEqual([
      { reason: "", read: 2, applied: 2, refused: 0 },
      { reason: "invalid_profile", read: 1, applied: 0, refused: 1 },
    ]);
  });
});

describe("import mixpanel-profiles: ids, properties and format detection", () => {
  it("sends a numeric $distinct_id as it is and counts it as sent; a missing, empty or non-id one is missing_distinct_id", async () => {
    const content = [
      '{"$distinct_id": 42, "$properties": {"a": 1}}',
      '{"$distinct_id": "", "$properties": {}}',
      '{"$distinct_id": true}',
      '{"$distinct_id": null}',
      '{"$distinct_id": {"x": 1}}',
      '{"$properties": {}}',
    ].join("\n");
    const { dir, file } = await inputFile(content);
    const report = path.join(dir, "r.csv");
    const fake = fakeProfilesServer();
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body).toBe('[{"$distinct_id":42,"$properties":{"a":1}}]');
    expect((sent(fake)[0] as { $distinct_id: unknown }).$distinct_id).toBe(42);
    expect(csvRows(await readFile(report, "utf8"))).toEqual([
      { reason: "", read: 1, applied: 1, refused: 0 },
      { reason: "missing_distinct_id", read: 5, applied: 0, refused: 5 },
      { reason: "total", read: 6, applied: 1, refused: 5 },
    ]);
  });

  it("reads $properties null as absent ({}), and any other non-object $properties is invalid_profile", async () => {
    const content = [
      '{"$distinct_id": "n-1", "$properties": null}',
      '{"$distinct_id": "n-2", "$properties": [1]}',
      '{"$distinct_id": "n-3", "$properties": 5}',
      '{"$distinct_id": "n-4", "$properties": "x"}',
    ].join("\n");
    const { dir, file } = await inputFile(content);
    const report = path.join(dir, "r.csv");
    const fake = fakeProfilesServer();
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    expect(sent(fake)).toEqual([{ $distinct_id: "n-1", $properties: {} }]);
    expect(csvRows(await readFile(report, "utf8")).slice(0, 2)).toEqual([
      { reason: "", read: 1, applied: 1, refused: 0 },
      { reason: "invalid_profile", read: 3, applied: 0, refused: 3 },
    ]);
  });

  it("falls back to JSONL when a file that looks like one JSON document does not parse as a whole", async () => {
    const content = ["[this is not json", ...generatedProfileLines(2)].join("\n");
    const { dir, file } = await inputFile(content, "odd.json");
    const report = path.join(dir, "r.csv");
    const fake = fakeProfilesServer();
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);
    expect(code).toBe(0);
    expect(sent(fake).map((p) => p.$distinct_id)).toEqual(["user-1", "user-2"]);
    expect(out.stderr).toContain("profile 1: invalid_profile");
    expect(csvRows(await readFile(report, "utf8")).slice(0, 2)).toEqual([
      { reason: "", read: 2, applied: 2, refused: 0 },
      { reason: "invalid_profile", read: 1, applied: 0, refused: 1 },
    ]);
  });

  it("reads a pretty-printed document whose first line ends in a value, and a one-line root array", async () => {
    const one = { $distinct_id: "user-1", $properties: { plan: "free" } };
    const two = { $distinct_id: "user-2", $properties: {} };
    for (const [name, content] of [
      ["cut.json", `{"results":[${JSON.stringify(one)},${JSON.stringify(two)}]\n}`],
      ["minified.json", JSON.stringify([one, two])],
      ["cut-array.json", `[${JSON.stringify(one)},\n${JSON.stringify(two)}\n]`],
    ] as const) {
      const { file } = await inputFile(content, name);
      const fake = fakeProfilesServer();
      expect((await run(["--project", "7", file], fake)).code).toBe(0);
      expect(sent(fake)).toEqual([one, two]);
      expect(await progressOf(file)).toMatchObject({ lastLine: 2, complete: true });
    }
  });

  it("reads a JSONL file made of appended pages, one profile per unit, and resumes inside a page", async () => {
    const page = (ids: number[]) => JSON.stringify({ results: generatedProfileLines(ids.length, ids[0]).map((l) => JSON.parse(l)), page: 0, status: "ok" });
    const content = [page([1, 2]), "", page([3, 4, 5])].join("\n");
    const { file } = await inputFile(content, "pages.jsonl");
    const plain = fakeProfilesServer();
    expect((await run(["--project", "7", file], plain)).code).toBe(0);
    expect(sent(plain).map((p) => p.$distinct_id)).toEqual(["user-1", "user-2", "user-3", "user-4", "user-5"]);
    expect(await progressOf(file)).toMatchObject({ lastLine: 5, complete: true });

    const limits = { maxProfiles: 2, maxBytes: 8 * 1024 * 1024 };
    const fake = fakeProfilesServer({ override: (_req, n) => (n >= 2 ? json(500, { error: "down" }) : undefined) });
    expect((await run(["--project", "7", "--restart", file], fake, {}, limits)).code).toBe(1);
    expect(await progressOf(file)).toMatchObject({ lastLine: 2, complete: false });
    fake.setOverride(undefined);
    const before = fake.requests.length;
    expect((await run(["--project", "7", file], fake, {}, limits)).code).toBe(0);
    const resent = fake.requests.slice(before).flatMap((r) => (r.profiles as Profile[]).map((p) => p.$distinct_id));
    expect(resent).toEqual(["user-3", "user-4", "user-5"]);
  });

  it("does not abort a JSONL file whose first line is garbage: that line is one invalid_profile", async () => {
    const content = ["garbage", ...generatedProfileLines(2)].join("\n");
    const { dir, file } = await inputFile(content);
    const report = path.join(dir, "r.csv");
    const fake = fakeProfilesServer();
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);
    expect(code).toBe(0);
    expect(sent(fake).map((p) => p.$distinct_id)).toEqual(["user-1", "user-2"]);
    expect(out.stderr).toContain("profile 1: invalid_profile");
    expect(csvRows(await readFile(report, "utf8")).slice(0, 2)).toEqual([
      { reason: "", read: 2, applied: 2, refused: 0 },
      { reason: "invalid_profile", read: 1, applied: 0, refused: 1 },
    ]);
  });

  it("sends a __proto__ key in $properties without aborting or changing the counts", async () => {
    const content = ['{"$distinct_id":"p-1","$properties":{"__proto__":{"polluted":true},"a":1}}', ...generatedProfileLines(1)].join("\n");
    const { dir, file } = await inputFile(content);
    const report = path.join(dir, "r.csv");
    const fake = fakeProfilesServer();
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    expect(Object.hasOwn(sent(fake)[0]!.$properties, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(csvRows(await readFile(report, "utf8"))[0]).toEqual({ reason: "", read: 2, applied: 2, refused: 0 });
  });
});

describe("import mixpanel-profiles: transforms (T4)", () => {
  it("drops and hashes $properties keys, never creates a missing key, and hashes like the events command", async () => {
    const { file } = await inputFile(await jsonlText());
    const fake = fakeProfilesServer();
    const { code } = await run(["--project", "7", "--drop-prop", "ip", "--hash-prop", "$email", "--hash-prop", "absent", file], fake);

    expect(code).toBe(0);
    const [u1, u2, u3] = sent(fake);
    expect(u1!.$properties.$email).toBe(createHash("sha256").update("ada@example.com").digest("hex"));
    expect(u1!.$properties.$email).toBe(hashValue("ada@example.com"));
    expect(u2!.$properties).not.toHaveProperty("ip");
    expect(u2!.$properties.plan).toBe("free");
    expect(u3).toEqual({ $distinct_id: "user-3", $properties: {} });
    for (const p of sent(fake)) expect(p.$properties).not.toHaveProperty("absent");
    expect(sent(fake).map((p) => p.$distinct_id)).toEqual(["user-1", "user-2", "user-3", "user-4"]);
  });

  it("drops a name passed to both --drop-prop and --hash-prop", async () => {
    const { file } = await inputFile(await jsonlText());
    const fake = fakeProfilesServer();
    expect((await run(["--project", "7", "--drop-prop", "plan", "--hash-prop", "plan", file], fake)).code).toBe(0);
    for (const p of sent(fake)) expect(p.$properties).not.toHaveProperty("plan");
  });

  it("refuses to drop or hash $distinct_id and distinct_id as a usage error before reading or sending anything", async () => {
    const fake = fakeProfilesServer();
    for (const args of [
      ["--drop-prop", "$distinct_id"],
      ["--hash-prop", "$distinct_id"],
      ["--drop-prop", "distinct_id"],
      ["--hash-prop", "distinct_id"],
    ]) {
      const { code, out } = await run(["--project", "7", ...args, "/nonexistent/profiles.jsonl"], fake);
      expect(code).toBe(1);
      expect(out.stderr).toContain(`${args[0]} ${args[1]} is not allowed`);
      expect(out.stderr).not.toContain("no such file");
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("import mixpanel-profiles: retries and failures (T5, T8)", () => {
  it("waits Retry-After on 429, capped at one day, and resends the same batch", async () => {
    const { file } = await inputFile(generatedProfileLines(3).join("\n"));
    const fake = fakeProfilesServer({
      override: (_req, n) => (n === 1 ? json(429, { status: 0, error: "import busy" }, { "retry-after": "999999999" }) : n === 2 ? json(429, { status: 0 }, { "retry-after": "3" }) : undefined),
    });
    const { code, sleeps } = await run(["--project", "7", file], fake);
    expect(code).toBe(0);
    expect(sleeps).toEqual([86_400_000, 3000]);
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[2]!.body).toBe(fake.requests[0]!.body);
    expect(fake.stored.size).toBe(3);
  });

  it("retries a 500 with backoff and then succeeds", async () => {
    const { file } = await inputFile(generatedProfileLines(3).join("\n"));
    const fake = fakeProfilesServer({ override: (_req, n) => (n <= 2 ? json(500, { error: "boom" }) : undefined) });
    const { code, sleeps } = await run(["--project", "7", file], fake);
    expect(code).toBe(0);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("aborts with a clear message and exit 1 on 400, 401, 403 and keeps the token out of every output", async () => {
    for (const status of [400, 401, 403]) {
      const { dir, file } = await inputFile(generatedProfileLines(3).join("\n"));
      const report = path.join(dir, "r.csv");
      const fake = fakeProfilesServer({ override: () => json(status, { error: status === 400 ? "projectId required" : "forbidden" }) });
      const { code, out } = await run(["--project", "7", "--report", report, file], fake);
      expect(code, String(status)).toBe(1);
      expect(fake.requests, String(status)).toHaveLength(1);
      expect(out.stderr).toContain(`HTTP ${status}`);
      for (const text of [out.stdout, out.stderr, await readFile(report, "utf8"), await readFile(`${file}.cohorly-import.json`, "utf8").catch(() => "")]) {
        expect(text).not.toContain(TOKEN);
      }
    }
  });

  it("splits a batch answered 413 until each profile fits, and reports one that never does", async () => {
    const { dir, file } = await inputFile(generatedProfileLines(4).join("\n"));
    const report = path.join(dir, "r.csv");
    const fake = fakeProfilesServer({
      override: (req) => (req.profiles.length > 1 || (req.profiles[0] as Profile).$distinct_id === "user-3" ? json(413, {}) : undefined),
    });
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    expect(csvRows(await readFile(report, "utf8")).slice(0, 2)).toEqual([
      { reason: "", read: 3, applied: 3, refused: 0 },
      { reason: "profile_too_large", read: 1, applied: 0, refused: 1 },
    ]);
  });
});

describe("import mixpanel-profiles: progress and resume (T6, T7, T8)", () => {
  it("resumes after a failure in the middle without resending what was confirmed", async () => {
    const { dir, file } = await inputFile(generatedProfileLines(12).join("\n"));
    const report = path.join(dir, "report.csv");
    const limits = { maxProfiles: 5, maxBytes: 8 * 1024 * 1024 };
    const fake = fakeProfilesServer({ override: (_req, n) => (n >= 3 ? json(500, { error: "down" }) : undefined) });

    const first = await run(["--project", "7", "--report", report, file], fake, {}, limits);
    expect(first.code).toBe(1);
    expect(first.out.stderr).toContain("run the same command again to resume");
    const afterFirst = await progressOf(file);
    expect(afterFirst).toMatchObject({ version: 1, source: "mixpanel-profiles", projectId: "7", apiUrl: API, lastLine: 10, complete: false });
    expect(csvRows(await readFile(report, "utf8"))[0]).toEqual({ reason: "", read: 10, applied: 10, refused: 0 });
    const confirmedFirst = fake.requests.slice(0, 2).reduce((n, r) => n + r.profiles.length, 0);

    fake.setOverride(undefined);
    const before = fake.requests.length;
    const second = await run(["--project", "7", "--report", report, file], fake, {}, limits);
    expect(second.code).toBe(0);
    expect(second.out.stdout).toContain("resuming after profile 10");
    const resent = fake.requests.slice(before).flatMap((r) => (r.profiles as Profile[]).map((p) => p.$distinct_id));
    expect(resent).toEqual(["user-11", "user-12"]);
    expect(confirmedFirst + resent.length).toBe(12);
    expect(fake.stored.size).toBe(12);
    expect(csvRows(await readFile(report, "utf8"))[0]).toEqual({ reason: "", read: 12, applied: 12, refused: 0 });
    expect(await progressOf(file)).toMatchObject({ lastLine: 12, complete: true });
  });

  it("resumes in the middle of a results file, a root array and a JSONL file with blank lines, counting profiles and not physical lines", async () => {
    const profiles = generatedProfileLines(12).map((l) => JSON.parse(l));
    const cases: [string, string, string][] = [
      ["results", JSON.stringify({ results: profiles, page: 0 }, null, 2), "page.json"],
      ["array", JSON.stringify(profiles), "array.json"],
      ["jsonl with blank lines", generatedProfileLines(12).join("\n\n\n"), "blank.jsonl"],
    ];
    const limits = { maxProfiles: 5, maxBytes: 8 * 1024 * 1024 };
    for (const [label, content, name] of cases) {
      const { dir, file } = await inputFile(content, name);
      const report = path.join(dir, "report.csv");
      const fake = fakeProfilesServer({ override: (_req, n) => (n >= 3 ? json(500, { error: "down" }) : undefined) });
      expect((await run(["--project", "7", "--report", report, file], fake, {}, limits)).code, label).toBe(1);
      expect(await progressOf(file), label).toMatchObject({ lastLine: 10, complete: false });
      const confirmedFirst = fake.requests.slice(0, 2).reduce((n, r) => n + r.profiles.length, 0);

      fake.setOverride(undefined);
      const before = fake.requests.length;
      expect((await run(["--project", "7", "--report", report, file], fake, {}, limits)).code, label).toBe(0);
      const resent = fake.requests.slice(before).flatMap((r) => (r.profiles as Profile[]).map((p) => p.$distinct_id));
      expect(resent, label).toEqual(["user-11", "user-12"]);
      expect(confirmedFirst + resent.length, label).toBe(12);
      expect(csvRows(await readFile(report, "utf8"))[0], label).toEqual({ reason: "", read: 12, applied: 12, refused: 0 });
      expect(await progressOf(file), label).toMatchObject({ lastLine: 12, complete: true });
    }
  });

  it("aborts on a 400 in the second half of a batch split by 413 and a later run resends the first half without loss", async () => {
    const { dir, file } = await inputFile(generatedProfileLines(4).join("\n"));
    const report = path.join(dir, "report.csv");
    const fake = fakeProfilesServer({ override: (_req, n) => (n === 1 ? json(413, {}) : n === 3 ? json(400, { error: "bad batch" }) : undefined) });
    const first = await run(["--project", "7", file], fake);
    expect(first.code).toBe(1);
    expect(fake.requests.map((r) => r.profiles.length)).toEqual([4, 2, 2]);
    const saved = await progressOf(file).catch(() => null);
    expect(saved?.lastLine ?? 0).toBe(0);

    fake.setOverride(undefined);
    const before = fake.requests.length;
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    const resent = fake.requests.slice(before).flatMap((r) => (r.profiles as Profile[]).map((p) => p.$distinct_id));
    expect(resent).toEqual(["user-1", "user-2", "user-3", "user-4"]);
    expect(csvRows(await readFile(report, "utf8"))[0]).toEqual({ reason: "", read: 4, applied: 4, refused: 0 });
  });

  it("counts a results page's profiles, not lines, in lastLine", async () => {
    const { file } = await inputFile(await pageText(), "page.json");
    const fake = fakeProfilesServer();
    await run(["--project", "7", file], fake);
    expect(await progressOf(file)).toMatchObject({ lastLine: 4, complete: true });
  });

  it("skips a complete file, and --restart sends everything again without changing what the server holds", async () => {
    const { file } = await inputFile(generatedProfileLines(3).join("\n"));
    const fake = fakeProfilesServer();
    await run(["--project", "7", file], fake);
    const expected = generatedProfileLines(3).map((l) => JSON.parse(l) as Profile);
    expect(sent(fake)).toEqual(expected);

    const again = await run(["--project", "7", file], fake);
    expect(again.code).toBe(0);
    expect(again.out.stdout).toContain("already imported");
    expect(fake.requests).toHaveLength(1);

    const restart = await run(["--project", "7", "--restart", file], fake);
    expect(restart.code).toBe(0);
    expect(fake.requests).toHaveLength(2);
    // The CLI sends the same bodies again; what the server keeps is the server's concern.
    expect(fake.requests[1]!.body).toBe(fake.requests[0]!.body);
    expect(sent(fake)).toEqual([...expected, ...expected]);
  });

  it("needs --restart for another project or another server", async () => {
    const { file } = await inputFile(generatedProfileLines(3).join("\n"));
    const fake = fakeProfilesServer();
    await run(["--project", "7", file], fake);

    const otherProject = await run(["--project", "8", file], fake);
    expect(otherProject.code).toBe(1);
    expect(otherProject.out.stderr).toContain("--restart");
    const otherServer = await run(["--project", "7", "--api-url", "https://other.example.com", file], fake);
    expect(otherServer.code).toBe(1);
    expect(otherServer.out.stderr).toContain("--restart");
    expect(fake.requests).toHaveLength(1);
  });

  it("refuses a progress file of another kind of import as a usage error, and --restart overrides it", async () => {
    const { file } = await inputFile(generatedProfileLines(3).join("\n"));
    await writeFile(
      `${file}.cohorly-import.json`,
      `${JSON.stringify({ version: 1, source: path.basename(file), projectId: "7", apiUrl: API, lastLine: 3, complete: true, report: [] })}\n`,
    );
    const fake = fakeProfilesServer();
    const refused = await run(["--project", "7", file], fake);
    expect(refused.code).toBe(1);
    expect(refused.out.stderr).toContain("another kind of import");
    expect(refused.out.stderr).toContain("--restart");
    expect(fake.requests).toHaveLength(0);

    const restart = await run(["--project", "7", "--restart", file], fake);
    expect(restart.code).toBe(0);
    expect(sent(fake)).toHaveLength(3);
    expect(await progressOf(file)).toMatchObject({ source: "mixpanel-profiles", complete: true });
  });

  it("never lets --report point at an input or a progress file", async () => {
    const { file } = await inputFile(generatedProfileLines(3).join("\n"));
    const fake = fakeProfilesServer();
    for (const target of [file, `${file}.cohorly-import.json`]) {
      const { code, out } = await run(["--project", "7", "--report", target, file], fake);
      expect(code).toBe(1);
      expect(out.stderr).toContain("would overwrite");
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("import mixpanel-profiles: summary and usage (T7, T8)", () => {
  it("prints the summary and writes the CSV with reason,read,applied,refused", async () => {
    const { dir, file } = await inputFile(await jsonlText());
    const report = path.join(dir, "report.csv");
    const fake = fakeProfilesServer();
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);
    expect(code).toBe(0);
    expect(await readFile(report, "utf8")).toBe("reason,read,applied,refused\n,4,4,0\ntotal,4,4,0\n");
    expect(out.stdout).toContain("Import report:");
    expect(out.stdout).toContain("reason  read  applied  refused");
    expect(out.stdout).toContain(`report written to ${report}`);
  });

  it("prints the help, lists the command, and refuses a missing project or credential before any request", async () => {
    const fake = fakeProfilesServer();
    const help = await run(["-h"], fake);
    expect(help.code).toBe(0);
    for (const text of ["Usage: cohorly import mixpanel-profiles", "--project", "--token", "--api-url", "--drop-prop", "--hash-prop", "--restart", "--report", "$set_once", "COHORLY_IMPORT_TOKEN", "Exit codes"]) {
      expect(help.out.stdout).toContain(text);
    }
    const group = makeIo({});
    expect(await main(["import", "-h"], group.io)).toBe(0);
    expect(group.out.stdout).toContain("mixpanel-profiles <path>");

    const { file } = await inputFile(generatedProfileLines(1).join("\n"));
    const noProject = await run([file], fake);
    expect(noProject.code).toBe(1);
    expect(noProject.out.stderr).toContain("missing required option --project");
    const noToken = await run(["--project", "7", file], fake, { COHORLY_IMPORT_TOKEN: undefined });
    expect(noToken.code).toBe(1);
    expect(noToken.out.stderr).toContain("set COHORLY_IMPORT_TOKEN or pass --token");
    expect(fake.requests).toHaveLength(0);
  });
});
