import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("operations runbook coverage", () => {
  it("mentions every PRESETTLE_* and CORRIDOR_* error code", () => {
    const types = readFileSync(resolve(process.cwd(), "packages/types/src/index.ts"), "utf8");
    const docs = readFileSync(resolve(process.cwd(), "docs/operations.md"), "utf8");
    const codes = [...types.matchAll(/\| "((?:PRESETTLE|CORRIDOR)_[A-Z0-9_]+)"/g)].map(
      (match) => match[1],
    );
    // CORRIDOR_HALTED is supplied by the breaker package when it is enabled;
    // keep its runbook entry visible even before that package lands in types.
    const documentedBreakerCode = "CORRIDOR_HALTED";
    expect(docs).toContain(documentedBreakerCode);
    for (const code of [...new Set([...codes, documentedBreakerCode])]) {
      expect(docs, `${code} is missing from docs/operations.md`).toContain(code);
    }
  });
});
