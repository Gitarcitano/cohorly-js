import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Io, main } from "../src/cli.js";
import { mapMixpanelSchemas, planPut } from "../src/import-mixpanel-lexicon.js";
import { makeIo, tempDir } from "./helpers.js";
import { json } from "./import-fake.js";
import { fakeLexiconServer, type LexiconOverride, lexiconFixture, putsOf } from "./lexicon-fake.js";

const TOKEN = "chrly_org_import_s3cr3t_token_value";
const API = "https://api.example.com";

async function schemasFile(content: unknown = lexiconFixture()) {
  const dir = await tempDir();
  const file = path.join(dir, "schemas.json");
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

async function run(args: string[], fake: ReturnType<typeof fakeLexiconServer>, env: Record<string, string | undefined> = {}, extra: Partial<Io> = {}) {
  const { io, out, sleeps } = makeIo({ COHORLY_IMPORT_TOKEN: TOKEN, COHORLY_API_URL: API, ...env }, { fetch: fake.fetch, ...extra });
  const code = await main(["import", "mixpanel-lexicon", ...args], io);
  return { code, out, sleeps };
}

const GOVERNANCE = ["dropped", "mergedInto", "verified", "reviewStatus", "objective", "owner", "adoptionStatus"];
const ALLOWED_FIELDS = ["displayName", "description", "tags", "hidden"];

describe("mapMixpanelSchemas (pure)", () => {
  it("maps events, event properties and profile properties, and counts the unsupported kinds", () => {
    const { entries, skippedUnsupported } = mapMixpanelSchemas(lexiconFixture());
    expect(skippedUnsupported).toBe(4);
    expect(entries).toEqual([
      { type: "event", name: "Signed Up", displayName: "Account created", description: "A visitor finished the sign-up form", tags: ["growth", "activation"], hidden: false },
      { type: "event_property", name: "plan", displayName: "Plan", description: "Plan chosen at sign-up", tags: ["billing"] },
      { type: "event_property", name: "referrer", hidden: true },
      { type: "event", name: "Purchase", description: "An order was paid", tags: ["revenue"], hidden: true },
      { type: "event_property", name: "amount", description: "Order total in cents" },
      { type: "event", name: "Viewed Page", description: "A page was shown" },
      { type: "profile_property", name: "$email", displayName: "E-mail", description: "Contact e-mail", tags: ["pii"] },
      { type: "profile_property", name: "company", description: "Company name" },
    ]);
  });

  it("accepts a bare array like the envelope", () => {
    expect(mapMixpanelSchemas(lexiconFixture().results)).toEqual(mapMixpanelSchemas(lexiconFixture()));
  });

  it("never carries a governance field, even when the Mixpanel metadata has them", () => {
    for (const entry of mapMixpanelSchemas(lexiconFixture()).entries) {
      for (const k of Object.keys(entry)) expect([...ALLOWED_FIELDS, "type", "name"]).toContain(k);
    }
  });

  it("tolerates missing fields and leaves empty values out", () => {
    const { entries, skippedUnsupported } = mapMixpanelSchemas([
      { entityType: "event", name: "A" },
      { entityType: "event", name: "B", schemaJson: { description: "  ", metadata: { "com.mixpanel": { tags: [], displayName: "" } } } },
      { entityType: "event", schemaJson: {} },
      { entityType: "event", name: "C", schemaJson: { metadata: { "com.mixpanel": { hidden: false } } } },
      null,
      { name: "no kind" },
    ]);
    expect(entries).toEqual([]);
    expect(skippedUnsupported).toBe(3);
  });

  it("rejects a JSON that is not a list of schemas", () => {
    expect(() => mapMixpanelSchemas({ nope: 1 })).toThrow(/not a list of schemas/);
  });
});

describe("planPut (pure)", () => {
  const entry = { type: "event" as const, name: "E", displayName: "New", description: "New d", tags: ["t"], hidden: true };
  const filled = { display_name: "Old", description: "Old d", tags: ["x"], hidden: true };

  it("sends everything to a new entry", () => {
    expect(planPut(entry, undefined, false)).toEqual({ displayName: "New", description: "New d", tags: ["t"], hidden: true });
  });

  it("sends only the empty fields, nothing when all are filled, everything with overwrite", () => {
    expect(planPut(entry, { display_name: "Old", description: null, tags: [], hidden: true }, false)).toEqual({ description: "New d", tags: ["t"] });
    expect(planPut(entry, filled, false)).toBeNull();
    expect(planPut(entry, filled, true)).toEqual({ displayName: "New", description: "New d", tags: ["t"], hidden: true });
  });

  it("an explicit hidden false un-hides a hidden entry only with overwrite, and is never sent otherwise", () => {
    const visible = { type: "event" as const, name: "E", hidden: false };
    const hiddenNow = { display_name: null, description: null, tags: [], hidden: true };
    expect(planPut(visible, hiddenNow, true)).toEqual({ hidden: false });
    expect(planPut(visible, hiddenNow, false)).toBeNull();
    expect(planPut(visible, { ...hiddenNow, hidden: false }, true)).toBeNull();
    expect(planPut(visible, undefined, true)).toBeNull();
    expect(planPut({ type: "event", name: "E", description: "D", hidden: false }, undefined, false)).toEqual({ description: "D" });
  });

  it("never sends a field Mixpanel has no value for, with or without overwrite", () => {
    expect(planPut({ type: "event", name: "E", description: "D" }, filled, true)).toEqual({ description: "D" });
    expect(planPut({ type: "event", name: "E" }, filled, true)).toBeNull();
  });
});

describe("import mixpanel-lexicon: what reaches the server", () => {
  it("sends one PUT per supported entry with the mapped fields only, project in the query", async () => {
    const fake = fakeLexiconServer();
    const { code } = await run(["--project", "7", await schemasFile()], fake);
    expect(code).toBe(0);

    const puts = putsOf(fake.requests);
    expect(puts.map((r) => r.path)).toEqual([
      "/api/lexicon/event/Signed%20Up",
      "/api/lexicon/event_property/plan",
      "/api/lexicon/event_property/referrer",
      "/api/lexicon/event/Purchase",
      "/api/lexicon/event_property/amount",
      "/api/lexicon/event/Viewed%20Page",
      "/api/lexicon/profile_property/%24email",
      "/api/lexicon/profile_property/company",
    ]);
    for (const p of puts) {
      expect(new URL(p.url).searchParams.get("projectId")).toBe("7");
      expect(p.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(p.headers["content-encoding"]).toBeUndefined();
    }
    expect(puts[0]!.body).toEqual({ displayName: "Account created", description: "A visitor finished the sign-up form", tags: ["growth", "activation"] });
    expect(puts[3]!.body).toEqual({ description: "An order was paid", tags: ["revenue"], hidden: true });
    expect(puts[2]!.body).toEqual({ hidden: true });
    expect(fake.requests[0]).toMatchObject({ method: "GET", url: `${API}/api/lexicon?projectId=7` });
  });

  it("never sends dropped, mergedInto, verified or any other governance field", async () => {
    const fake = fakeLexiconServer();
    await run(["--project", "7", "--overwrite", await schemasFile()], fake);
    const puts = putsOf(fake.requests);
    expect(puts.length).toBeGreaterThan(0);
    for (const p of puts) {
      for (const k of Object.keys(p.body ?? {})) expect(ALLOWED_FIELDS).toContain(k);
      for (const k of GOVERNANCE) expect(p.body).not.toHaveProperty(k);
    }
  });

  it("does not overwrite filled fields, fills the empty ones, and skips a fully filled entry", async () => {
    const fake = fakeLexiconServer([
      { entity_type: "event", name: "Signed Up", display_name: "Mine", description: null, tags: ["mine"], hidden: false },
      { entity_type: "event", name: "Purchase", display_name: "P", description: "Mine", tags: ["mine"], hidden: true },
    ]);
    const { code, out } = await run(["--project", "7", await schemasFile()], fake);
    expect(code).toBe(0);

    const bodyOf = (name: string) => putsOf(fake.requests).find((r) => r.path.endsWith(`/event/${name}`))?.body;
    expect(bodyOf("Signed%20Up")).toEqual({ description: "A visitor finished the sign-up form" });
    expect(bodyOf("Purchase")).toBeUndefined();
    expect(fake.entries.get("event/Signed Up")).toMatchObject({ display_name: "Mine", tags: ["mine"] });
    expect(fake.entries.get("event/Purchase")).toMatchObject({ description: "Mine", tags: ["mine"] });
    expect(out.stdout).toContain("created, new Lexicon entry: 6");
    expect(out.stdout).toContain("updated, existing entry: 1");
    expect(out.stdout).toContain("skipped, already filled: 1");
  });

  it("does not count an entry Mixpanel documented nothing for", async () => {
    const fake = fakeLexiconServer();
    const file = await schemasFile([{ entityType: "event", name: "Bare" }]);
    const { code, out } = await run(["--project", "7", file], fake);
    expect(code).toBe(0);
    expect(putsOf(fake.requests)).toHaveLength(0);
    expect(out.stdout).toContain("created, new Lexicon entry: 0");
    expect(out.stdout).toContain("skipped, already filled: 0");
  });

  it("counts a name of . or .. as failed and never requests it", async () => {
    const fake = fakeLexiconServer();
    const file = await schemasFile([
      { entityType: "event", name: "..", schemaJson: { description: "x" } },
      { entityType: "event", name: "Ok", schemaJson: { description: "y" } },
    ]);
    const { code, out } = await run(["--project", "7", file], fake);
    expect(code).toBe(1);
    expect(putsOf(fake.requests).map((r) => r.path)).toEqual(["/api/lexicon/event/Ok"]);
    expect(out.stdout).toContain("failed: 1");
    expect(out.stdout).toContain("created, new Lexicon entry: 1");
  });

  it("overwrites filled fields with --overwrite, and still never clears one Mixpanel has no value for", async () => {
    const fake = fakeLexiconServer([
      { entity_type: "event", name: "Purchase", display_name: "Keep me", description: "Old", tags: ["old"], hidden: false },
    ]);
    const { code } = await run(["--project", "7", "--overwrite", await schemasFile()], fake);
    expect(code).toBe(0);
    const body = putsOf(fake.requests).find((r) => r.path.endsWith("/event/Purchase"))?.body;
    expect(body).toEqual({ description: "An order was paid", tags: ["revenue"], hidden: true });
    expect(fake.entries.get("event/Purchase")).toMatchObject({ display_name: "Keep me", description: "An order was paid", tags: ["revenue"], hidden: true });
    for (const p of putsOf(fake.requests)) {
      for (const v of Object.values(p.body ?? {})) expect(v === null || v === "" || (Array.isArray(v) && v.length === 0)).toBe(false);
    }
  });

  it("makes a hidden entry visible again with --overwrite when the export says hidden false, and not without it", async () => {
    const hiddenSignedUp = { entity_type: "event", name: "Signed Up", display_name: "Account created", description: "A visitor finished the sign-up form", tags: ["growth", "activation"], hidden: true };
    const without = fakeLexiconServer([hiddenSignedUp]);
    await run(["--project", "7", await schemasFile()], without);
    expect(without.entries.get("event/Signed Up")?.hidden).toBe(true);

    const withOverwrite = fakeLexiconServer([hiddenSignedUp]);
    await run(["--project", "7", "--overwrite", await schemasFile()], withOverwrite);
    expect(withOverwrite.entries.get("event/Signed Up")?.hidden).toBe(false);
  });

  it("with --dry-run makes no write request, prints what would change and the summary", async () => {
    const fake = fakeLexiconServer([{ entity_type: "event", name: "Purchase", description: "Old" }]);
    const { code, out } = await run(["--project", "7", "--dry-run", await schemasFile()], fake);
    expect(code).toBe(0);
    expect(fake.requests.map((r) => r.method)).toEqual(["GET"]);
    expect(out.stdout).toContain("create event Signed Up:");
    expect(out.stdout).toContain("update event Purchase:");
    expect(out.stdout).toContain("dry run, nothing written");
    expect(out.stdout).toContain("created, new Lexicon entry (would be): 7");
    expect(fake.entries.size).toBe(1);
  });

  it("prints the five counters", async () => {
    const fake = fakeLexiconServer([
      { entity_type: "event", name: "Signed Up", display_name: "A", description: "B", tags: ["c"] },
      { entity_type: "event", name: "Viewed Page", description: "A page was shown" },
    ]);
    fake.entries.get("event/Signed Up")!.hidden = true;
    const { code, out } = await run(["--project", "7", await schemasFile()], fake, {}, {});
    expect(code).toBe(0);
    expect(out.stdout).toContain("created, new Lexicon entry: 6");
    expect(out.stdout).toContain("updated, existing entry: 0");
    expect(out.stdout).toContain("skipped, already filled: 2");
    expect(out.stdout).toContain("skipped, unsupported type: 4");
    expect(out.stdout).toContain("failed: 0");
  });

  it("never turns an unsupported kind into a request", async () => {
    const fake = fakeLexiconServer();
    await run(["--project", "7", await schemasFile()], fake);
    const paths = putsOf(fake.requests).map((r) => decodeURIComponent(r.path));
    for (const unsupported of ["Any Checkout Step", "Account", "Plans", "Revenue per order", "tier"]) {
      expect(paths.some((p) => p.endsWith(`/${unsupported}`))).toBe(false);
    }
  });
});

describe("import mixpanel-lexicon: failures and retries", () => {
  const failOne = (name: string, status: number): LexiconOverride => (req) =>
    req.method === "PUT" && req.path.endsWith(name) ? json(status, { error: "boom" }) : undefined;

  it("counts a non-retryable failure, keeps going, and exits 1", async () => {
    const fake = fakeLexiconServer([], failOne("/event_property/plan", 400));
    const { code, out } = await run(["--project", "7", await schemasFile()], fake);
    expect(code).toBe(1);
    expect(putsOf(fake.requests)).toHaveLength(8);
    expect(out.stdout).toContain("failed: 1");
    expect(out.stdout).toContain("created, new Lexicon entry: 7");
    expect(out.stderr).toContain("event_property plan: HTTP 400: boom");
  });

  it("waits out 429 with Retry-After and retries a 5xx, then writes the entry", async () => {
    let n = 0;
    const fake = fakeLexiconServer([], (req) => {
      if (req.method !== "PUT" || !req.path.endsWith("/event/Purchase")) return undefined;
      n++;
      if (n === 1) return json(429, { error: "slow" }, { "retry-after": "3" });
      if (n === 2) return json(503, { error: "busy" }, { "retry-after": "2" });
      if (n === 3) return json(500, { error: "oops" });
      if (n === 4) return "network-error";
      return undefined;
    });
    const { code, sleeps } = await run(["--project", "7", await schemasFile()], fake);
    expect(code).toBe(0);
    expect(sleeps).toEqual([3000, 2000, 1000, 2000]);
    expect(fake.entries.get("event/Purchase")?.description).toBe("An order was paid");
  });

  it("stops on a refused credential", async () => {
    const fake = fakeLexiconServer([], (req) => (req.method === "PUT" ? json(403, { error: "forbidden" }) : undefined));
    const { code, out } = await run(["--project", "7", await schemasFile()], fake);
    expect(code).toBe(1);
    expect(out.stderr).toMatch(/refused the credential/);
    expect(putsOf(fake.requests)).toHaveLength(1);
  });

  it("prints the partial summary when the credential is refused after some writes", async () => {
    const fake = fakeLexiconServer([], failOne("/event_property/plan", 401));
    const { code, out } = await run(["--project", "7", await schemasFile()], fake);
    expect(code).toBe(1);
    expect(out.stderr).toMatch(/refused the credential/);
    expect(out.stdout).toContain("created, new Lexicon entry: 1");
  });

  it("exits 1 without any write when the first read of the Lexicon is refused", async () => {
    const fake = fakeLexiconServer([], (req) => (req.method === "GET" ? json(403, { error: "forbidden" }) : undefined));
    const { code, out } = await run(["--project", "7", await schemasFile()], fake);
    expect(code).toBe(1);
    expect(out.stderr).toMatch(/cannot read the current Lexicon/);
    expect(putsOf(fake.requests)).toHaveLength(0);
  });
});

describe("import mixpanel-lexicon: usage", () => {
  const fake = () => fakeLexiconServer();

  it("needs a credential, a numeric --project and a readable JSON file", async () => {
    const file = await schemasFile();
    const fails = async (args: string[], message: RegExp, env: Record<string, string | undefined> = {}) => {
      const f = fake();
      const { code, out } = await run(args, f, env);
      expect(code, args.join(" ")).toBe(1);
      expect(out.stderr).toMatch(message);
      expect(f.requests).toHaveLength(0);
    };
    await fails(["--project", "7", file], /missing import credential/, { COHORLY_IMPORT_TOKEN: undefined });
    await fails([file], /missing required option --project/);
    await fails(["--project", "abc", file], /invalid --project/);
    await fails(["--project", "7", "/no/such/schemas.json"], /cannot read/);
    await fails(["--project", "7", await schemasFile("{ not json")], /not valid JSON/);
    await fails(["--project", "7", await schemasFile({ nope: 1 })], /not a list of schemas/);
    await fails(["--project", "7"], /exactly one path/);
    await fails(["--project", "7", "--api-url", "ftp://x", file], /invalid API URL/);
  });

  it("is listed in every help and has all its options", async () => {
    const f = fake();
    for (const argv of [[], ["--help"], ["import"], ["import", "--help"]]) {
      const { io, out } = makeIo({});
      await main(argv, io);
      expect(out.stdout, argv.join(" ")).toContain("mixpanel-lexicon");
    }
    const { out } = await run(["--help"], f);
    for (const opt of ["--project", "--token", "--api-url", "--overwrite", "--dry-run", "-h, --help", "COHORLY_IMPORT_TOKEN", "COHORLY_API_URL"]) {
      expect(out.stdout).toContain(opt);
    }
    expect(f.requests).toHaveLength(0);
  });
});
