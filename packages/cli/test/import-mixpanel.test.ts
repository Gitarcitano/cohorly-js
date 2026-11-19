import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type Io, main } from "../src/cli.js";
import { SECONDS_THRESHOLD_MS } from "../src/import-mixpanel.js";
import { ImportReport, renderReport } from "../src/import-report.js";
import { makeIo, tempDir } from "./helpers.js";
import { countByName, fakeImportServer, fixtureText, generatedLines, json, MAX_BYTES } from "./import-fake.js";

const TOKEN = "chrly_org_import_s3cr3t_token_value";
const API = "https://api.example.com";
type Fake = ReturnType<typeof fakeImportServer>;

async function run(args: string[], fake: Fake, extra: Partial<Io> = {}, env: Record<string, string | undefined> = {}) {
  const { io, out, sleeps } = makeIo({ COHORLY_IMPORT_TOKEN: TOKEN, COHORLY_API_URL: API, ...env }, { fetch: fake.fetch, ...extra });
  const code = await main(["import", "mixpanel", ...args], io);
  return { code, out, sleeps };
}

const sent = (requests: Fake["requests"]) => requests.flatMap((r) => r.events as Array<{ event: string; properties: Record<string, unknown> }>);
const insertIds = (requests: Fake["requests"]) => sent(requests).map((e) => e.properties.$insert_id);
const progressOf = async (file: string) => JSON.parse(await readFile(`${file}.cohorly-import.json`, "utf8"));
const fixtureEvents = () =>
  fixtureText()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

async function exportFile(content: string | Uint8Array, name = "export.jsonl") {
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
    .filter((l) => !l.startsWith("total,"))
    .map((l) => {
      const [day, reason, read, inserted, duplicates, refused] = l.split(",");
      return { day, reason, read: Number(read), inserted: Number(inserted), duplicates: Number(duplicates), refused: Number(refused) };
    });
}

describe("import mixpanel: what reaches the server (T1)", () => {
  it("sends every event with the file's count per name, times in ms, $insert_id untouched", async () => {
    const { file } = await exportFile(fixtureText());
    const fake = fakeImportServer();
    const { code } = await run(["--project", "7", file], fake);

    expect(code).toBe(0);
    expect(countByName(sent(fake.requests))).toEqual(countByName(fixtureEvents()));
    expect(countByName(sent(fake.requests))).toEqual({ "Signed Up": 3, "Viewed Page": 5, Purchase: 2 });
    for (const e of sent(fake.requests)) expect(e.properties.time as number).toBeGreaterThanOrEqual(SECONDS_THRESHOLD_MS);
    expect(sent(fake.requests)[0]!.properties.time).toBe(1_700_000_000_000);
    expect(insertIds(fake.requests)).toEqual(fixtureEvents().map((e) => e.properties.$insert_id));
    expect(fake.stored.size).toBe(10);

    const req = fake.requests[0]!;
    expect(req.url).toBe(`${API}/api/import/events?projectId=7`);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["content-encoding"]).toBe("gzip");
  });

  it("reads a .jsonl.gz file the same way", async () => {
    const { file } = await exportFile(gzipSync(fixtureText()), "export.jsonl.gz");
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    expect(countByName(sent(fake.requests))).toEqual(countByName(fixtureEvents()));
    expect(existsSync(`${file}.cohorly-import.json`)).toBe(true);
  });

  it("reads a directory's supported files in name order, not recursively, ignoring everything else", async () => {
    const dir = await tempDir();
    const line = (id: string) => `${JSON.stringify({ event: "E", properties: { time: 1_700_000_000, distinct_id: id, $insert_id: id } })}\n`;
    await writeFile(path.join(dir, "b.jsonl"), line("b"));
    await writeFile(path.join(dir, "a.ndjson.gz"), gzipSync(line("a")));
    await writeFile(path.join(dir, "c.json"), line("c"));
    await writeFile(path.join(dir, "notes.txt"), line("txt"));
    await writeFile(path.join(dir, "readme.md"), "# notes\n");
    await writeFile(path.join(dir, "z.jsonl.cohorly-import.json"), "{ not a progress file }");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "d.jsonl"), line("d"));
    const fake = fakeImportServer();

    expect((await run(["--project", "7", dir], fake)).code).toBe(0);
    expect(sent(fake.requests).map((e) => e.properties.distinct_id)).toEqual(["a", "b", "c"]);
  });
});

describe("import mixpanel: months per batch (VEL-2075)", () => {
  // `perMonth` events in each of `months` consecutive UTC months from 2020-01, sorted by time like a real export.
  const monthlyLines = (months: number, perMonth: number) =>
    Array.from({ length: months }, (_, m) =>
      Array.from({ length: perMonth }, (_, i) =>
        JSON.stringify({
          event: "Hist",
          properties: { time: Date.UTC(2020, m, 10 + i) / 1000, distinct_id: `u${m}-${i}`, $insert_id: `mo-${m}-${i}` },
        }),
      ),
    ).flat();
  const monthsOfBody = (events: unknown[]) =>
    new Set(events.map((e) => new Date((e as { properties: { time: number } }).properties.time).toISOString().slice(0, 7)));

  it("never sends a batch spanning more than 3 UTC months, and delivers every event exactly once", async () => {
    const { file } = await exportFile(`${monthlyLines(10, 4).join("\n")}\n`);
    const fake = fakeImportServer();
    const { code } = await run(["--project", "7", file], fake);

    expect(code).toBe(0);
    for (const req of fake.requests) expect(monthsOfBody(req.events).size).toBeLessThanOrEqual(3);
    expect(fake.requests).toHaveLength(4); // 3 + 3 + 3 + 1 months
    expect(insertIds(fake.requests).sort()).toEqual(
      monthlyLines(10, 4)
        .map((l) => JSON.parse(l).properties.$insert_id)
        .sort(),
    );
    expect(fake.stored.size).toBe(40);
    const progress = await progressOf(file);
    expect(progress.complete).toBe(true);
    expect(progress.report.filter((r: { reason: string }) => r.reason === "too_many_months")).toEqual([]);
  });

  it("sends events of 3 months in a single request", async () => {
    const { file } = await exportFile(`${monthlyLines(3, 4).join("\n")}\n`);
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.events).toHaveLength(12);
  });
});

describe("import mixpanel: importing again (T2)", () => {
  it("sends identical bodies on a second run and the server counts them as duplicates", async () => {
    const { dir, file } = await exportFile(fixtureText());
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    const firstBodies = fake.requests.map((r) => r.body);

    await rm(`${file}.cohorly-import.json`);
    const report = path.join(dir, "second.csv");
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    const secondBodies = fake.requests.slice(firstBodies.length).map((r) => r.body);

    expect(secondBodies).toEqual(firstBodies);
    expect(fake.stored.size).toBe(10);
    expect((await readFile(report, "utf8")).trim().split("\n").at(-1)).toBe("total,,10,0,10,0");
  });
});

describe("import mixpanel: resume (T3)", () => {
  it("stops after a batch exhausts its retries and resumes after the last confirmed line", async () => {
    const { dir, file } = await exportFile(`${generatedLines(12_000).join("\n")}\n`);
    const seen: Array<number | null> = [];
    const fake = fakeImportServer({
      override: (_req, n) => {
        try {
          seen.push(JSON.parse(readFileSync(`${file}.cohorly-import.json`, "utf8")).lastLine);
        } catch {
          seen.push(null);
        }
        return n >= 3 ? json(500, { error: "boom" }) : undefined;
      },
    });

    const first = await run(["--project", "7", file], fake);
    expect(first.code).toBe(1);
    expect(first.out.stderr).toContain("gave up after 8 attempts");
    expect(first.out.stderr).toContain("run the same command again");
    // The progress only moved after each 200, never before, never on a failure.
    expect(seen).toEqual([null, 5000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000]);
    const stopped = await progressOf(file);
    expect(stopped).toMatchObject({ version: 1, source: "export.jsonl", projectId: "7", lastLine: 10000, complete: false });
    expect(stopped.report.reduce((sum: number, r: { read: number }) => sum + r.read, 0)).toBe(10000);
    const confirmedIds = new Set(insertIds(fake.requests.slice(0, 2)));
    expect(confirmedIds.size).toBe(10000);

    fake.setOverride(undefined);
    const before = fake.requests.length;
    const report = path.join(dir, "report.csv");
    const second = await run(["--project", "7", "--report", report, file], fake);
    expect(second.code).toBe(0);
    expect(second.out.stdout).toContain("resuming after line 10000");
    const resent = insertIds(fake.requests.slice(before));
    expect(resent).toHaveLength(2000);
    expect(resent.filter((id) => confirmedIds.has(id))).toEqual([]);
    expect(await progressOf(file)).toMatchObject({ lastLine: 12000, complete: true });
    // The resumed run reports on the whole file, nothing counted twice.
    expect((await readFile(report, "utf8")).trim().split("\n").at(-1)).toBe("total,,12000,12000,0,0");
  });

  it("skips a complete file, refuses another project's progress, and --restart sends everything again", async () => {
    const { dir, file } = await exportFile(`${generatedLines(12_000).join("\n")}\n`);
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);

    let before = fake.requests.length;
    const report = path.join(dir, "again.csv");
    const again = await run(["--project", "7", "--report", report, file], fake);
    expect(again.code).toBe(0);
    expect(fake.requests.length).toBe(before);
    expect(again.out.stdout).toContain("already imported");
    expect((await readFile(report, "utf8")).trim().split("\n").at(-1)).toBe("total,,12000,12000,0,0");

    const other = await run(["--project", "8", file], fake);
    expect(other.code).toBe(1);
    expect(other.out.stderr).toContain("--restart");
    expect(fake.requests.length).toBe(before);

    const restart = await run(["--project", "7", "--restart", "--report", report, file], fake);
    expect(restart.code).toBe(0);
    expect(fake.requests.length).toBe(before + 3);
    expect((await readFile(report, "utf8")).trim().split("\n").at(-1)).toBe("total,,12000,0,12000,0");

    await writeFile(`${file}.cohorly-import.json`, JSON.stringify({ ...(await progressOf(file)), version: 2 }));
    before = fake.requests.length;
    const unknown = await run(["--project", "7", file], fake);
    expect(unknown.code).toBe(1);
    expect(unknown.out.stderr).toContain("unknown version");
    expect(unknown.out.stderr).toContain("--restart");
    expect(fake.requests.length).toBe(before);
  });

  it("persists invalid lines only once the progress passes them, so a resumed report counts each once", async () => {
    const events = generatedLines(5003);
    // events 1..4999, invalid, event 5000, invalid, events 5001..5003 (lines 5003..5005)
    const lines = [...events.slice(0, 4999), "{broken", events[4999]!, "not json", ...events.slice(5000)];
    const { dir, file } = await exportFile(`${lines.join("\n")}\n`);
    const fake = fakeImportServer({ override: (_req, n) => (n >= 2 ? json(500, { error: "boom" }) : undefined) });

    const first = await run(["--project", "7", file], fake);
    expect(first.code).toBe(1);
    expect(first.out.stderr).toContain(`${file}:5000: invalid JSON`);
    expect(first.out.stderr).toContain(`${file}:5002: invalid JSON`);
    const stopped = await progressOf(file);
    expect(stopped.lastLine).toBe(5002);
    expect(stopped.report).toEqual(
      expect.arrayContaining([expect.objectContaining({ day: "unknown", reason: "invalid_json", read: 2, refused: 2 })]),
    );
    expect(stopped.report.reduce((sum: number, r: { read: number }) => sum + r.read, 0)).toBe(5002);

    fake.setOverride(undefined);
    const report = path.join(dir, "report.csv");
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    const rows = csvRows(await readFile(report, "utf8"));
    expect(rows.filter((r) => r.reason === "invalid_json")).toEqual([
      { day: "unknown", reason: "invalid_json", read: 2, inserted: 0, duplicates: 0, refused: 2 },
    ]);
    expect(rows.reduce((sum, r) => sum + r.read, 0)).toBe(lines.length);
  });
});

describe("import mixpanel: server answers (T4)", () => {
  it("waits Retry-After on 429 and 503 and resends the same batch", async () => {
    const { file } = await exportFile(fixtureText());
    const fake = fakeImportServer({
      override: (_req, n) =>
        n === 1
          ? json(429, { status: 0, error: "import busy" }, { "Retry-After": "1" })
          : n === 2
            ? json(503, { status: 0, error: "partitions busy" }, { "Retry-After": "3" })
            : undefined,
    });
    const { code, sleeps } = await run(["--project", "7", file], fake);
    expect(code).toBe(0);
    expect(sleeps).toEqual([1000, 3000]);
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[1]!.body).toBe(fake.requests[0]!.body);
    expect(fake.requests[2]!.wire.equals(fake.requests[0]!.wire)).toBe(true);
  });

  it("splits a batch answered 413 into contiguous halves until it fits, delivering every event once", async () => {
    const { file } = await exportFile(fixtureText());
    const fake = fakeImportServer({ override: (req) => (req.events.length > 2 ? json(413, { status: 0, error: "payload too large" }) : undefined) });
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    const accepted = fake.requests.filter((r) => r.events.length <= 2);
    expect(insertIds(accepted)).toEqual(fixtureEvents().map((e) => e.properties.$insert_id));
    expect(fake.stored.size).toBe(10);
    expect(await progressOf(file)).toMatchObject({ lastLine: 10, complete: true });
  });

  it("reports a single event answered 413 as event_too_large and imports the rest", async () => {
    const { dir, file } = await exportFile(fixtureText());
    const fake = fakeImportServer({
      override: (req) =>
        req.events.some((e) => (e as { properties: { distinct_id: string } }).properties.distinct_id === "user-2")
          ? json(413, { status: 0, error: "payload too large" })
          : undefined,
    });
    const report = path.join(dir, "r.csv");
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);
    expect(code).toBe(0);
    expect(out.stderr).toContain(`${file}:3:`);
    expect(fake.stored.size).toBe(9);
    expect(csvRows(await readFile(report, "utf8"))).toContainEqual({
      day: "2023-11-14",
      reason: "event_too_large",
      read: 1,
      inserted: 0,
      duplicates: 0,
      refused: 1,
    });
  });

  it("stops on 401 with the server's message, exit 1, never printing the token", async () => {
    const { file } = await exportFile(fixtureText());
    const fake = fakeImportServer({ override: () => json(401, { error: `invalid credential ${TOKEN}` }) });
    const { code, out } = await run(["--project", "7", file], fake);
    expect(code).toBe(1);
    expect(fake.requests).toHaveLength(1);
    expect(out.stderr).toContain("invalid credential");
    expect(out.stderr + out.stdout).not.toContain(TOKEN);
    expect(existsSync(`${file}.cohorly-import.json`)).toBe(false);
  });

  it("stops on 400 naming the file and the lines of the batch", async () => {
    const { file } = await exportFile(fixtureText());
    const fake = fakeImportServer({ override: () => json(400, { status: 0, error: "invalid json" }) });
    const { code, out } = await run(["--project", "7", file], fake);
    expect(code).toBe(1);
    expect(out.stderr).toContain(`${file} lines 1-10`);
    expect(out.stderr).toContain("invalid json");
  });

  it("backs off on 5xx and network errors, then stops with the progress kept", async () => {
    const { file } = await exportFile(fixtureText());
    const fake = fakeImportServer({ override: (_req, n) => (n % 2 === 0 ? "network-error" : json(502, { error: "bad gateway" })) });
    const { code, sleeps, out } = await run(["--project", "7", file], fake);
    expect(code).toBe(1);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
    expect(fake.requests).toHaveLength(8);
    expect(out.stderr).toContain("run the same command again");
  });
});

describe("import mixpanel: report (T6)", () => {
  it("writes per-day rows by reason that add up to the lines of the file", async () => {
    const lines = [...fixtureText().trim().split("\n"), "{not json", '{"event":"X","properties":{"time":1700100000000}}', ""];
    const { dir, file } = await exportFile(`${lines.join("\n")}\n`);
    const fake = fakeImportServer({ retentionCutoffMs: Date.UTC(2023, 10, 15) });
    const report = path.join(dir, "report.csv");
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);

    expect(code).toBe(0);
    const csv = await readFile(report, "utf8");
    expect(csv).toBe(
      [
        "day,reason,read,inserted,duplicates,refused",
        "2023-11-14,older_than_retention,3,0,0,3",
        "2023-11-15,,1,1,0,0",
        "2023-11-16,,6,6,0,0",
        "2023-11-16,missing_distinct_id,1,0,0,1",
        "unknown,invalid_json,1,0,0,1",
        "total,,12,7,0,5",
        "",
      ].join("\n"),
    );
    // The terminal shows the same rows.
    expect(out.stdout).toContain(renderReport(ImportReport.fromRows(csvRows(csv))));
  });

  it("puts a refusal whose index is outside the batch on the unknown day", async () => {
    const { dir, file } = await exportFile(fixtureText());
    const fake = fakeImportServer({
      override: () => json(200, { status: 1, received: 10, inserted: 9, duplicates: 0, refused: [{ index: 99, reason: "invalid_event" }] }),
    });
    const report = path.join(dir, "report.csv");
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    const csv = await readFile(report, "utf8");
    expect(csv).toContain("unknown,invalid_event,1,0,0,1\n");
    expect(csv.trim().split("\n").at(-1)).toBe("total,,10,9,0,1");
  });
});

describe("import mixpanel: reading and batching (T7)", () => {
  it("never sends more than 5000 events in a batch", async () => {
    const { file } = await exportFile(`${generatedLines(12_000).join("\n")}\n`);
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    expect(fake.requests.map((r) => r.events.length)).toEqual([5000, 5000, 2000]);
  });

  it("keeps each body within 8 MiB and reports an event too large for any batch without sending it", async () => {
    const blob = "x".repeat(1024 * 1024);
    const big = (k: number, size = blob) =>
      JSON.stringify({ event: "Big", properties: { time: 1_700_000_000 + k, distinct_id: "u", $insert_id: `big-${k}`, blob: size } });
    const lines = Array.from({ length: 21 }, (_, i) => (i === 4 ? big(i, "y".repeat(9 * 1024 * 1024)) : big(i)));
    const { dir, file } = await exportFile(`${lines.join("\n")}\n`);
    const fake = fakeImportServer();
    const report = path.join(dir, "r.csv");
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);

    expect(code).toBe(0);
    expect(fake.requests.map((r) => r.events.length)).toEqual([7, 7, 6]);
    for (const r of fake.requests) expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(MAX_BYTES);
    expect(insertIds(fake.requests)).not.toContain("big-4");
    expect(out.stderr).toContain(`${file}:5:`);
    expect(csvRows(await readFile(report, "utf8"))).toContainEqual({
      day: "2023-11-14",
      reason: "event_too_large",
      read: 1,
      inserted: 0,
      duplicates: 0,
      refused: 1,
    });
  });

  it("goes on past invalid JSON, skips blank lines and reads CRLF files", async () => {
    const lines = fixtureText().trim().split("\n");
    const content = [...lines.slice(0, 5), "", "{oops", "   ", ...lines.slice(5)].join("\r\n");
    const { dir, file } = await exportFile(`${content}\r\n`);
    const fake = fakeImportServer();
    const report = path.join(dir, "r.csv");
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);

    expect(code).toBe(0);
    expect(fake.stored.size).toBe(10);
    expect(out.stderr).toContain(`${file}:7: invalid JSON`);
    const csv = await readFile(report, "utf8");
    expect(csv).toContain("unknown,invalid_json,1,0,0,1\n");
    expect(csv.trim().split("\n").at(-1)).toBe("total,,11,10,0,1");
    expect(await progressOf(file)).toMatchObject({ lastLine: 13, complete: true });
  });

  it("prints the first 20 invalid lines and counts all of them", async () => {
    const lines = [...Array.from({ length: 25 }, (_, i) => `{bad ${i}`), ...generatedLines(1)];
    const { dir, file } = await exportFile(`${lines.join("\n")}\n`);
    const fake = fakeImportServer();
    const report = path.join(dir, "r.csv");
    const { code, out } = await run(["--project", "7", "--report", report, file], fake);

    expect(code).toBe(0);
    expect(out.stderr.match(/invalid JSON, not imported/g)).toHaveLength(20);
    expect(out.stderr).toContain("counted in the report");
    expect(await readFile(report, "utf8")).toContain("unknown,invalid_json,25,0,0,25\n");
  });
});

describe("import mixpanel: terminal (G14)", () => {
  const progressLines = (stdout: string) => stdout.split("\n").filter((l) => / \d+ read, \d+ inserted, \d+ duplicates, \d+ refused$/.test(l));

  it("prints at most one progress line per second, plus one at the end of each file, never an event", async () => {
    const { file } = await exportFile(`${generatedLines(12_000).join("\n")}\n`);
    const still = await run(["--project", "7", file], fakeImportServer(), { now: () => 5_000 });
    expect(still.out.stdout).toContain(`${file}: importing`);
    expect(progressLines(still.out.stdout)).toEqual([
      `${file}: 5000 read, 5000 inserted, 0 duplicates, 0 refused`,
      `${file}: 12000 read, 12000 inserted, 0 duplicates, 0 refused`,
    ]);
    expect(still.out.stdout + still.out.stderr).not.toMatch(/gen-\d|user-\d/);

    await rm(`${file}.cohorly-import.json`);
    let clock = 0;
    const moving = await run(["--project", "7", file], fakeImportServer(), { now: () => (clock += 1500) });
    expect(progressLines(moving.out.stdout)).toHaveLength(4);
  });
});

describe("import mixpanel: resume edge cases and protected ids", () => {
  it("keeps the first half confirmed when the second half of a 413 split fails, then resumes after it", async () => {
    const events = generatedLines(4);
    // lines: 1 e1, 2 e2, 3 invalid, 4 e3, 5 e4
    const lines = [events[0]!, events[1]!, "{broken", events[2]!, events[3]!];
    const { dir, file } = await exportFile(`${lines.join("\n")}\n`);
    let failSecondHalf = true;
    const fake = fakeImportServer({
      override: (req) => {
        if (req.events.length > 2) return json(413, { status: 0, error: "payload too large" });
        if (failSecondHalf && req.events.some((e) => (e as { properties: { $insert_id: string } }).properties.$insert_id === "gen-3")) {
          return json(500, { error: "boom" });
        }
        return undefined;
      },
    });

    const first = await run(["--project", "7", file], fake);
    expect(first.code).toBe(1);
    // Only the first half is confirmed: the invalid line after it waits for the second.
    const stopped = await progressOf(file);
    expect(stopped).toMatchObject({ lastLine: 2, complete: false });
    expect(stopped.report.reduce((sum: number, r: { read: number }) => sum + r.read, 0)).toBe(2);
    expect(stopped.report.some((r: { reason: string }) => r.reason === "invalid_json")).toBe(false);
    expect(fake.stored.size).toBe(2);

    failSecondHalf = false;
    const before = fake.requests.length;
    const report = path.join(dir, "report.csv");
    const second = await run(["--project", "7", "--report", report, file], fake);
    expect(second.code).toBe(0);
    expect(insertIds(fake.requests.slice(before))).toEqual(["gen-3", "gen-4"]);
    expect(fake.stored.size).toBe(4);
    expect(await progressOf(file)).toMatchObject({ lastLine: 5, complete: true });
    expect((await readFile(report, "utf8")).trim().split("\n").at(-1)).toBe("total,,5,4,0,1");
  });

  it("a --restart that stops before its first confirmation leaves nothing complete behind", async () => {
    const { file } = await exportFile(`${generatedLines(12_000).join("\n")}\n`);
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    expect(await progressOf(file)).toMatchObject({ lastLine: 12000, complete: true });

    fake.setOverride(() => json(500, { error: "boom" }));
    expect((await run(["--project", "7", "--restart", file], fake)).code).toBe(1);
    expect(await progressOf(file)).toMatchObject({ lastLine: 0, complete: false, report: [] });

    fake.setOverride(undefined);
    const before = fake.requests.length;
    const again = await run(["--project", "7", file], fake);
    expect(again.code).toBe(0);
    expect(again.out.stdout).not.toContain("already imported");
    expect(insertIds(fake.requests.slice(before))).toHaveLength(12_000);
  });

  it("handles an empty file and a file of only invalid lines: nothing sent, file complete", async () => {
    const empty = await exportFile("", "empty.jsonl");
    const bad = await exportFile("{a\n{b\n", "bad.jsonl");
    const fake = fakeImportServer();

    const reportEmpty = path.join(empty.dir, "r.csv");
    expect((await run(["--project", "7", "--report", reportEmpty, empty.file], fake)).code).toBe(0);
    expect(await progressOf(empty.file)).toMatchObject({ lastLine: 0, complete: true });
    expect((await readFile(reportEmpty, "utf8")).trim().split("\n")).toEqual(["day,reason,read,inserted,duplicates,refused", "total,,0,0,0,0"]);

    const reportBad = path.join(bad.dir, "r.csv");
    expect((await run(["--project", "7", "--report", reportBad, bad.file], fake)).code).toBe(0);
    expect(await progressOf(bad.file)).toMatchObject({ lastLine: 2, complete: true });
    expect((await readFile(reportBad, "utf8")).trim().split("\n")).toEqual([
      "day,reason,read,inserted,duplicates,refused",
      "unknown,invalid_json,2,0,0,2",
      "total,,2,0,0,2",
    ]);
    expect(fake.requests).toHaveLength(0);
  });

  it("imports a file without trailing newline, and events without $insert_id are duplicates the second time", async () => {
    const lines = [1, 2].map((k) => JSON.stringify({ event: "E", properties: { time: 1_700_000_000 + k, distinct_id: `u${k}`, z: 1, a: { y: 2, x: 3 } } }));
    const { file } = await exportFile(lines.join("\n"));
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    expect(fake.stored.size).toBe(2);
    expect(await progressOf(file)).toMatchObject({ lastLine: 2, complete: true });
    await rm(`${file}.cohorly-import.json`);
    const report = path.join(path.dirname(file), "r.csv");
    expect((await run(["--project", "7", "--report", report, file], fake)).code).toBe(0);
    expect(fake.stored.size).toBe(2);
    expect((await readFile(report, "utf8")).trim().split("\n").at(-1)).toBe("total,,2,0,2,0");
    // The CLI never adds an $insert_id of its own.
    expect(sent(fake.requests).every((e) => !("$insert_id" in e.properties))).toBe(true);
  });

  it("does not reuse progress written for another API URL, even for the same project id", async () => {
    const { file } = await exportFile(`${generatedLines(12_000).join("\n")}\n`);
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    const before = fake.requests.length;

    const moved = await run(["--project", "7", "--api-url", "https://other.example.com", file], fake);
    expect(moved.code).toBe(1);
    expect(moved.out.stderr).toContain("https://other.example.com");
    expect(moved.out.stderr).toContain("--restart");
    expect(fake.requests.length).toBe(before);

    // A trailing slash is the same server.
    const same = await run(["--project", "7", "--api-url", `${API}/`, file], fake);
    expect(same.code).toBe(0);
    expect(same.out.stdout).toContain("already imported");
  });

  it("refuses a --report that would overwrite an input, a progress file or a link to one, before any request", async () => {
    const { dir, file } = await exportFile(fixtureText());
    const original = await readFile(file, "utf8");
    const fake = fakeImportServer();
    expect((await run(["--project", "7", file], fake)).code).toBe(0);
    const before = fake.requests.length;
    const link = path.join(dir, "report-link.csv");
    await symlink(file, link);

    for (const target of [file, `${file}.cohorly-import.json`, link, path.join(dir, ".", "export.jsonl")]) {
      const result = await run(["--project", "7", "--report", target, file], fake);
      expect(result.code).toBe(1);
      expect(result.out.stderr).toContain("would overwrite");
    }
    expect(await readFile(file, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(`${file}.cohorly-import.json`, "utf8"))).toMatchObject({ complete: true });
    expect(fake.requests.length).toBe(before);
  });

  it("refuses --drop-prop and --hash-prop on $insert_id before any request", async () => {
    const { file } = await exportFile(fixtureText());
    const fake = fakeImportServer();
    for (const flag of ["--drop-prop", "--hash-prop"]) {
      const result = await run(["--project", "7", flag, "$insert_id", file], fake);
      expect(result.code).toBe(1);
      expect(result.out.stderr).toContain(`${flag} $insert_id is not allowed`);
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("import mixpanel: usage (T8)", () => {
  it("prints the command help and lists it under import and in the main help", async () => {
    const fake = fakeImportServer();
    const sub = await run(["-h"], fake);
    expect(sub.code).toBe(0);
    expect(sub.out.stdout).toContain("Usage: cohorly import mixpanel");
    for (const flag of ["--project", "--token", "--api-url", "--drop-prop", "--hash-prop", "--restart", "--report", "COHORLY_IMPORT_TOKEN", "Exit codes"]) {
      expect(sub.out.stdout).toContain(flag);
    }

    const group = makeIo({});
    expect(await main(["import", "-h"], group.io)).toBe(0);
    expect(group.out.stdout).toContain("mixpanel <path>");

    const top = makeIo({});
    expect(await main(["--help"], top.io)).toBe(0);
    expect(top.out.stdout).toContain("import mixpanel <path>");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a missing --project, a missing credential and a path that does not exist, before any request", async () => {
    const { dir, file } = await exportFile(fixtureText());
    const fake = fakeImportServer();

    const noProject = await run([file], fake);
    expect(noProject.code).toBe(1);
    expect(noProject.out.stderr).toContain("missing required option --project");

    const badProject = await run(["--project", "abc", file], fake);
    expect(badProject.code).toBe(1);
    expect(badProject.out.stderr).toContain("invalid --project");

    const noToken = await run(["--project", "7", file], fake, {}, { COHORLY_IMPORT_TOKEN: undefined });
    expect(noToken.code).toBe(1);
    expect(noToken.out.stderr).toContain("set COHORLY_IMPORT_TOKEN or pass --token");

    const missing = await run(["--project", "7", path.join(dir, "nope.jsonl")], fake);
    expect(missing.code).toBe(1);
    expect(missing.out.stderr).toContain("no such file or directory");

    const empty = await tempDir();
    await writeFile(path.join(empty, "notes.txt"), "x");
    const nothing = await run(["--project", "7", empty], fake);
    expect(nothing.code).toBe(1);
    expect(nothing.out.stderr).toContain("no file to import");

    expect(fake.requests).toHaveLength(0);
  });

  it("takes the credential from --token too", async () => {
    const { file } = await exportFile(fixtureText());
    const fake = fakeImportServer();
    expect((await run(["--project", "7", "--token", "other-key", file], fake, {}, { COHORLY_IMPORT_TOKEN: undefined })).code).toBe(0);
    expect(fake.requests[0]!.headers.authorization).toBe("Bearer other-key");
  });
});
