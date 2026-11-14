import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as react from "@cohorly/react";
import { describe, expect, it } from "vitest";
import * as nextjs from "../src/index.js";

const REACT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../sdk-react");
const REACT_SRC = resolve(REACT_ROOT, "src");
const REACT_DIST = resolve(REACT_ROOT, "dist");

describe("@cohorly/nextjs client exports", () => {
  it("re-exports the very same CohorlyErrorBoundary as @cohorly/react", () => {
    expect(typeof nextjs.CohorlyErrorBoundary).toBe("function");
    expect(nextjs.CohorlyErrorBoundary).toBe(react.CohorlyErrorBoundary);
    expect(nextjs.CohorlyProvider).toBe(react.CohorlyProvider);
  });

  it("keeps the client boundary where the components are defined", () => {
    // The entry files re-export without a directive; Next.js decides per module,
    // so each file that holds a component must start with "use client" itself.
    for (const file of ["CohorlyErrorBoundary.tsx", "CohorlyProvider.tsx"]) {
      const source = readFileSync(resolve(REACT_SRC, file), "utf8");
      expect(source.trimStart().startsWith('"use client"')).toBe(true);
    }
  });

  it("keeps the directive in the built files too, when the package is built", () => {
    // tsc keeps a leading "use client"; a dist without it would break Server Components.
    for (const file of ["CohorlyErrorBoundary.js", "CohorlyProvider.js"]) {
      const built = resolve(REACT_DIST, file);
      if (!existsSync(built)) continue;
      expect(readFileSync(built, "utf8").trimStart().startsWith('"use client"')).toBe(true);
    }
  });
});
