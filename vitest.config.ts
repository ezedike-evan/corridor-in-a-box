import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Flaky-test quarantine (tests/helpers/quarantine.ts). `pnpm test:quarantine`
// (--mode quarantine, or CORRIDOR_QUARANTINE=1) runs only the blocks tagged
// "[quarantine]", each retried up to 3 times. The plain run leaves the flag
// unset, so the helper skips those blocks there.
export default defineConfig(({ mode }) => {
  const quarantine = mode === "quarantine" || process.env.CORRIDOR_QUARANTINE === "1";
  return {
    resolve: {
      alias: {
        "@corridor/types": r("./packages/types/src/index.ts"),
        // Listed before the package root: a string alias also matches subpaths.
        "@corridor/manifest/liveness": r("./packages/manifest/src/liveness.ts"),
        "@corridor/manifest": r("./packages/manifest/src/index.ts"),
        "@corridor/probe": r("./packages/probe/src/index.ts"),
        "@corridor/registry": r("./packages/registry/src/index.ts"),
        "@corridor/attester": r("./packages/attester/src/index.ts"),
        "@corridor/adapter-kit": r("./packages/adapter-kit/src/index.ts"),
        "@corridor/sep31": r("./packages/sep31/src/index.ts"),
        "@corridor/sep6": r("./packages/sep6/src/index.ts"),
        "@corridor/router/testing": r("./packages/router/src/testing.ts"),
        "@corridor/router": r("./packages/router/src/index.ts"),
        "@corridor/engine": r("./packages/engine/src/index.ts"),
        "@corridor/stellar": r("./packages/stellar/src/index.ts"),
        "@corridor/service": r("./packages/service/src/index.ts"),
        "@corridor/otel": r("./packages/otel/src/index.ts"),
        "@corridor/cli/wire": r("./packages/cli/src/wire.ts"),
        "@corridor/cli": r("./packages/cli/src/index.ts"),
      },
    },
    test: {
      include: ["tests/**/*.test.ts"],
      // Only measured under `pnpm test:coverage` (--coverage); a plain `pnpm test` is unchanged.
      coverage: {
        provider: "v8",
        include: ["packages/*/src/**"],
        reporter: ["text-summary", "lcov"],
        reportsDirectory: "coverage",
        // Set a little below what the suite measures today (lines/statements 83.6,
        // branches 84.2, functions 91.9), so a regression fails CI but noise does not.
        // The money-moving files get their own, stricter floor. The numbers and how to
        // change them are in CONTRIBUTING.md.
        thresholds: {
          lines: 82,
          statements: 82,
          branches: 83,
          functions: 90,
          "packages/engine/src/run.ts": {
            lines: 90,
            statements: 90,
            branches: 79,
            functions: 95,
          },
          "packages/engine/src/verbs.ts": {
            lines: 88,
            statements: 88,
            branches: 85,
            functions: 91,
          },
          "packages/engine/src/state.ts": {
            lines: 99,
            statements: 99,
            branches: 99,
            functions: 99,
          },
          "packages/engine/src/idempotency.ts": {
            lines: 99,
            statements: 99,
            branches: 99,
            functions: 99,
          },
          "packages/types/src/money.ts": {
            lines: 99,
            statements: 99,
            branches: 87,
            functions: 99,
          },
        },
      },
      ...(quarantine && {
        env: { CORRIDOR_QUARANTINE: "1" },
        testNamePattern: /\[quarantine\]/,
        retry: 3,
        // An empty quarantine is the goal state, not a failure.
        passWithNoTests: true,
      }),
    },
  };
});
