import { describe, expect, it } from "vitest";
import { parsePgMapId } from "../src/r8.js";

describe("parsePgMapId", () => {
  it("reads pg_map_id from the R8 header", () => {
    expect(parsePgMapId("# compiler: R8\r\n# pg_map_id: 3e7c1e3\r\n# pg_map_hash: SHA-256 abc\r\na.b -> c:\r\n")).toBe("3e7c1e3");
  });

  it("only looks at the leading comment block", () => {
    expect(parsePgMapId("# compiler: R8\na.b -> c:\n# pg_map_id: late\n")).toBeNull();
    expect(parsePgMapId("a.b -> c:\n")).toBeNull();
    expect(parsePgMapId("")).toBeNull();
  });
});
