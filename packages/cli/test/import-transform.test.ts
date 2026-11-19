import { describe, expect, it } from "vitest";
import { eventDay, SECONDS_THRESHOLD_MS, toMilliseconds, transformEvent } from "../src/import-mixpanel.js";

const none = { dropProps: new Set<string>(), hashProps: new Set<string>() };
const opts = (drop: string[] = [], hash: string[] = []) => ({ dropProps: new Set(drop), hashProps: new Set(hash) });

// sha256 hex computed outside the implementation (sha256sum).
const SHA256_EMAIL = "80305c9bb1bb2480e03894350e0a8a366dcbdeb302e69e0817aa0743abd77054"; // "a@b.co"
const SHA256_42 = "73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049"; // "42"
const SHA256_OBJECT = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"; // '{"a":1}'

describe("time conversion (G1)", () => {
  it("converts a positive integer below the threshold from seconds to ms, exactly", () => {
    expect(toMilliseconds(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMilliseconds(1)).toBe(1000);
    expect(toMilliseconds(SECONDS_THRESHOLD_MS - 1)).toBe(99_999_999_999_000);
    expect(Number.isSafeInteger(toMilliseconds(SECONDS_THRESHOLD_MS - 1))).toBe(true);
  });

  it("passes a value at or above the threshold, and anything the server calls invalid_time, untouched", () => {
    for (const value of [SECONDS_THRESHOLD_MS, 1_700_000_000_000, 1_700_000_000.5, 0, -1_700_000_000, Number.NaN, "1700000000", null, true]) {
      expect(toMilliseconds(value)).toBe(value);
    }
  });

  it("leaves an event without time, or with a non-numeric time, exactly as it was", () => {
    const noTime = { event: "A", properties: { distinct_id: "u", $insert_id: "i" } };
    expect(transformEvent(noTime, none)).toEqual(noTime);
    const textTime = { event: "A", properties: { time: "yesterday", distinct_id: "u" } };
    expect(transformEvent(textTime, none)).toEqual(textTime);
  });

  it("gives the same bytes for the same input", () => {
    const line = '{"event":"A","properties":{"time":1700000000,"distinct_id":"u","mp_lib":"web","email":"a@b.co"}}';
    const once = JSON.stringify(transformEvent(JSON.parse(line), opts(["x"], ["email"])));
    const twice = JSON.stringify(transformEvent(JSON.parse(line), opts(["x"], ["email"])));
    expect(once).toBe(twice);
    expect(once).toBe(
      `{"event":"A","properties":{"time":1700000000000,"distinct_id":"u","mp_lib":"web","email":"${SHA256_EMAIL}","$lib":"web"}}`,
    );
  });
});

describe("mp_lib to $lib (G2)", () => {
  it("copies mp_lib to $lib only when $lib is absent, keeping mp_lib", () => {
    expect(transformEvent({ event: "A", properties: { mp_lib: "android" } }, none)).toEqual({
      event: "A",
      properties: { mp_lib: "android", $lib: "android" },
    });
    expect(transformEvent({ event: "A", properties: { mp_lib: "android", $lib: "cohorly-android" } }, none)).toEqual({
      event: "A",
      properties: { mp_lib: "android", $lib: "cohorly-android" },
    });
    expect(transformEvent({ event: "A", properties: { $lib: null, mp_lib: "web" } }, none)).toEqual({
      event: "A",
      properties: { $lib: null, mp_lib: "web" },
    });
    expect(transformEvent({ event: "A", properties: { distinct_id: "u" } }, none)).toEqual({ event: "A", properties: { distinct_id: "u" } });
  });
});

describe("--drop-prop and --hash-prop (G3)", () => {
  const event = {
    event: "Signed Up",
    email: "top-level stays",
    properties: {
      time: 1_700_000_000_000,
      distinct_id: "user-1",
      $insert_id: "ins-1",
      email: "a@b.co",
      age: 42,
      address: { a: 1 },
      phone: null,
      $ip: "203.0.113.9",
      nested: { email: "nested stays" },
    },
  };

  it("changes only the named properties", () => {
    expect(transformEvent(event, opts(["$ip"], ["email", "age", "address", "phone"]))).toEqual({
      event: "Signed Up",
      email: "top-level stays",
      properties: {
        time: 1_700_000_000_000,
        distinct_id: "user-1",
        $insert_id: "ins-1",
        email: SHA256_EMAIL,
        age: SHA256_42,
        address: SHA256_OBJECT,
        phone: null,
        nested: { email: "nested stays" },
      },
    });
  });

  it("matches the exact name only, and drop wins over hash", () => {
    const out = transformEvent(event, opts(["email", "Email"], ["email"])) as { properties: Record<string, unknown> };
    expect(out.properties).not.toHaveProperty("email");
    expect(out.properties.age).toBe(42);
  });

  it("does not modify the input", () => {
    const copy = structuredClone(event);
    transformEvent(event, opts(["$ip"], ["email"]));
    expect(event).toEqual(copy);
  });
});

describe("what the CLI never does (G4)", () => {
  it("never adds or changes $insert_id", () => {
    expect(transformEvent({ event: "A", properties: { time: 1_700_000_000 } }, none)).toEqual({
      event: "A",
      properties: { time: 1_700_000_000_000 },
    });
    expect((transformEvent({ event: "A", properties: { $insert_id: "x-1" } }, none) as { properties: object }).properties).toEqual({
      $insert_id: "x-1",
    });
  });

  it("returns anything that is not an object with object properties as it is", () => {
    for (const value of [5, "text", null, [1, 2], { event: "A" }, { event: "A", properties: [1] }, { event: "A", properties: "x" }]) {
      expect(transformEvent(value, opts(["x"], ["y"]))).toEqual(value);
    }
  });
});

describe("eventDay", () => {
  it("is the UTC day of a valid ms time, else unknown", () => {
    expect(eventDay({ event: "A", properties: { time: 1_700_000_000_000 } })).toBe("2023-11-14");
    expect(eventDay({ event: "A", properties: { time: 1_700_100_000_000 } })).toBe("2023-11-16");
    expect(eventDay({ event: "A", properties: { time: "x" } })).toBe("unknown");
    expect(eventDay({ event: "A", properties: { time: 1.5 } })).toBe("unknown");
    expect(eventDay({ event: "A", properties: {} })).toBe("unknown");
    expect(eventDay([1])).toBe("unknown");
  });
});
