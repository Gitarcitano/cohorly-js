import { describe, expect, it } from "vitest";
import { isSecretKey, MAX_SCRUB_DEPTH, scrubDeep, scrubText } from "./scrub.js";

// The same cases as the server's copy (apps/server/src/errors/fingerprint.test.ts
// "PII scrub and truncation" and apps/server/src/errors.test.ts), so the two
// copies cannot drift apart unnoticed.

describe("scrubText (same cases as the server)", () => {
  it("replaces e-mails, secrets and Luhn-valid card numbers, and leaves other numbers", () => {
    expect(scrubText("user jane.doe+x@example.co.uk failed")).toBe("user [email] failed");
    expect(scrubText("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [token]");
    expect(scrubText("GET /cb?token=s3cr3t&x=1")).toBe("GET /cb?token=[token]&x=1");
    expect(scrubText("jwt eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl here")).toBe("jwt [token] here");
    expect(scrubText("card 4111 1111 1111 1111 declined")).toBe("card [card] declined");
    expect(scrubText("order 4111111111111112 failed")).toBe("order 4111111111111112 failed");
  });
});

describe("scrubDeep (same cases as the server)", () => {
  it("redacts values under secret-looking keys, at any depth", () => {
    expect(
      scrubDeep({ token: "secret-value", password: "hunter2", nested: { apiKey: "k1" }, status: 200 }),
    ).toEqual({ token: "[token]", password: "[token]", nested: { apiKey: "[token]" }, status: 200 });
  });

  it("scrubs strings nested in arrays and objects", () => {
    const out = scrubDeep({ nested: [{ who: "dave@example.com" }], note: "POST carol@example.com" });
    expect(out).toEqual({ nested: [{ who: "[email]" }], note: "POST [email]" });
  });

  it("keeps a null under a secret key, and does not mutate the input", () => {
    const input = { password: null, authorization: "Bearer x", list: ["a@b.co"] };
    expect(scrubDeep(input)).toEqual({ password: null, authorization: "[token]", list: ["[email]"] });
    expect(input).toEqual({ password: null, authorization: "Bearer x", list: ["a@b.co"] });
  });

  it("replaces what is nested past the depth bound", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < MAX_SCRUB_DEPTH; i++) deep = { child: deep };
    let node = scrubDeep(deep) as Record<string, unknown>;
    for (let i = 0; i < MAX_SCRUB_DEPTH - 1; i++) node = node.child as Record<string, unknown>;
    expect(node.child).toBe("[truncated]");
    expect(scrubDeep({ a: { b: [1] } }, 2)).toEqual({ a: { b: "[truncated]" } });
  });
});

describe("isSecretKey", () => {
  it("matches secret names whatever the case or separators", () => {
    for (const key of ["password", "apiKey", "api_key", "X-Api-Key", "Authorization", "set-cookie", "sessionId"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ["status", "tokens", "username", "email", "keyboard"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
  it("scrubs a long run with no @ in linear time, and still finds an e-mail at its end", () => {
    const started = performance.now();
    expect(scrubText("x".repeat(200_000))).toHaveLength(200_000);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(scrubText(`${"y".repeat(5_000)} jane@example.com`)).toBe(`${"y".repeat(5_000)} [email]`);
  });
});
