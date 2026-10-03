import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveness, loadCorridor, type Corridor } from "@corridor/manifest";
import type { RunResult, SettlementRequest } from "@corridor/engine";
import { fail, ok } from "@corridor/types";
import { finalizeCanary, type PaymentVerifier } from "../packages/cli/src/proof";

// packages/cli/src/index.ts calls process.exit(main(...)) at module top level
// and has no vitest path alias, so importing it directly would kill the test
// worker. Spawn it as a child process instead — also a more honest way to
// test a CLI's actual argv/exit-code/stdio contract.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const CLI = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));

function run(args: string[]) {
  return spawnSync(TSX, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function completedCanary(corridor: Corridor) {
  const result: RunResult = {
    idempotencyKey: "canary-test",
    state: "completed",
    transactionId: "anchor-tx-1",
    stellarTxHash: "a".repeat(64),
    trail: ["created", "completed"],
  };
  const settlement: SettlementRequest = {
    to: "GDESTINATION",
    memo: "memo-1",
    memoType: "text",
    amount: { asset: corridor.settlement.bridge_asset, amount: "1.00" },
    corridor,
  };
  return { result, settlement };
}

const verifier: PaymentVerifier = {
  verifyPayment: async () =>
    ok({
      hash: "a".repeat(64),
      successful: true,
      operations: [],
    }),
};

/** A throwaway copy of the comment-carrying fixture; --write mutates in place. */
function fixtureCopy(): string {
  const directory = mkdtempSync(join(tmpdir(), "corridor-canary-"));
  const manifestPath = join(directory, "verified.corridor.yaml");
  copyFileSync(join(REPO_ROOT, "tests/fixtures/verified.corridor.yaml"), manifestPath);
  return manifestPath;
}

describe("corridor CLI", () => {
  it("prints usage and exits 2 with no args", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor <validate|plan|canary>");
  });

  it("exits 2 on an unknown subcommand", () => {
    const r = run(["frobnicate"]);
    expect(r.status).toBe(2);
  });

  it("prints usage and exits 2 when the file arg is missing", () => {
    const r = run(["validate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor validate");
  });

  it("validate: exits 0 for a valid manifest", () => {
    const r = run(["validate", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('id="reference-testnet"');
  });

  it("validate: exits 1 for a structurally invalid manifest", () => {
    const r = run(["validate", "tests/fixtures/invalid.corridor.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MANIFEST_INVALID");
    expect(r.stderr).toContain("source");
  });

  it("validate: exits 1 for a nonexistent path", () => {
    const r = run(["validate", "corridors/does-not-exist.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read or parse");
  });

  // Liveness has three states. The distinction that matters: a corridor whose
  // endpoints are merely PRESENT must never be reported as runnable — that is
  // how tooling ends up certifying a lane nobody has checked.

  it("plan: reports VERIFIED with proof: none when endpoints_verified_at is set without proof", () => {
    const r = run(["plan", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-01-01");
    expect(r.stdout).toContain("proof:    none — amounts capped at default");
  });

  it("plan: reports PROVEN with canary hash and completion age for proven lane", () => {
    const r = run(["plan", "tests/fixtures/proven.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓✓ PROVEN");
    expect(r.stdout).toContain("canary a1b2c3d4 completed 2026-09-20");
    expect(r.stdout).toContain("days ago, expires in");
  });

  it("plan: reports VERIFIED with warning when proof is stale", () => {
    const r = run(["plan", "tests/fixtures/stale-proof.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    // A stale proof exists, so the plan must not claim there is none.
    expect(r.stdout).toContain("proof:    not current — canary a1b2c3d4 completed 2025-01-01");
    expect(r.stdout).not.toContain("proof:    none");
    expect(r.stdout).toContain("liveness warnings:");
    expect(r.stdout).toContain("proof is stale");
  });

  it("plan: reports UNVERIFIED for a fully-specified but unchecked corridor", () => {
    const r = run(["plan", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ? UNVERIFIED");
    expect(r.stdout).toContain("NOT runnable");
    // Regression guard for the claim that got the project rejected: a corridor
    // with unconfirmed endpoints must never carry the green marker.
    expect(r.stdout).not.toContain("✓ VERIFIED");
    expect(r.stdout).not.toContain("✓✓ PROVEN");
  });

  it("plan: never reports a placeholder-endpoint corridor as runnable", () => {
    const r = run(["plan", "corridors/mx-example.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNVERIFIED");
    expect(r.stdout).not.toContain("✓ VERIFIED");
    expect(r.stdout).not.toContain("✓✓ PROVEN");
  });

  it("plan: reports all three liveness warnings for a corridor missing dest endpoints", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.status).toBe(0); // warnings don't fail the command
    expect(r.stdout).toContain("NOT RUNNABLE");
    expect(r.stdout).toContain("quotes will fail");
    expect(r.stdout).toContain("no per-customer KYC");
  });

  it("plan: reports VERIFIED for ng-cowrie", () => {
    const r = run(["plan", "corridors/ng-cowrie.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-08-11");
  });

  it("plan: prints the status_note when present", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.stdout).toContain("PENDING");
  });

  it("canary: requires an explicit amount", () => {
    const r = run(["canary", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--amount");
  });

  it("canary --write preserves comments and records a re-parsable PROVEN proof", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const canary = completedCanary(loaded.value);
    const finalized = await finalizeCanary({
      ...canary,
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;

    const written = readFileSync(manifestPath, "utf8");
    // Every hand-written comment in the fixture survives the rewrite.
    expect(written).toContain("# Fixture: a corridor whose dest endpoints carry");
    expect(written).toContain("# anchor's data or live network reachability.");
    expect(written).toContain("proof:");
    expect(written).toContain('canary_completed_at: "2026-01-01"');
    expect(written).toContain(`stellar_tx_hash: ${"a".repeat(64)}`);

    const reparsed = loadCorridor(manifestPath);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(liveness(reparsed.value, new Date("2026-01-01T12:00:00.000Z")).state).toBe(
        "proven",
      );
    }
  });

  it("canary --write refreshes the existing proof instead of appending a second block", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");

    await finalizeCanary({
      ...completedCanary(loaded.value),
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });

    const afterFirst = loadCorridor(manifestPath);
    if (!afterFirst.ok) throw new Error("fixture invalid");
    const second = await finalizeCanary({
      ...completedCanary(afterFirst.value),
      result: { ...completedCanary(afterFirst.value).result, stellarTxHash: "b".repeat(64) },
      corridor: afterFirst.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-20T12:00:00.000Z"),
    });
    expect(second.ok).toBe(true);

    const written = readFileSync(manifestPath, "utf8");
    expect(written.match(/^proof:/gm)).toHaveLength(1);
    expect(written).toContain(`stellar_tx_hash: ${"b".repeat(64)}`);
    expect(written).not.toContain("a".repeat(64));
    const reparsed = loadCorridor(manifestPath);
    if (!reparsed.ok) throw new Error("written manifest did not re-parse");
    expect(reparsed.value.proof?.canary_completed_at).toBe("2026-01-20");
  });

  it("canary refuses to write when the chain read contradicts the run", async () => {
    const manifestPath = fixtureCopy();
    const before = readFileSync(manifestPath, "utf8");
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");

    const mismatched: PaymentVerifier = {
      verifyPayment: async () => fail("SETTLEMENT_FAILED", "memo mismatch"),
    };
    const finalized = await finalizeCanary({
      ...completedCanary(loaded.value),
      corridor: loaded.value,
      verifier: mismatched,
      manifestPath,
      write: true,
    });
    expect(finalized.ok).toBe(false);
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("canary refuses a payment above the recorded proof ceiling", async () => {
    const manifestPath = fixtureCopy();
    const before = readFileSync(manifestPath, "utf8");
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");
    const canary = completedCanary(loaded.value);

    const finalized = await finalizeCanary({
      ...canary,
      settlement: {
        ...canary.settlement,
        amount: { asset: canary.settlement.amount.asset, amount: "25.00" },
      },
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
    });
    expect(finalized.ok).toBe(false);
    if (!finalized.ok) expect(finalized.error.message).toContain("ceiling");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  // Every non-completed terminal state must leave the file byte-identical, and
  // must not even reach the chain read: the guard is the first thing that runs.
  for (const state of ["failed", "held", "refunded"] as const) {
    it(`canary never writes a proof for a run that ended ${state}`, async () => {
      const manifestPath = fixtureCopy();
      const before = readFileSync(manifestPath, "utf8");
      const loaded = loadCorridor(manifestPath);
      if (!loaded.ok) throw new Error("fixture invalid");

      const canary = completedCanary(loaded.value);
      const exploding: PaymentVerifier = {
        verifyPayment: async () => {
          throw new Error("chain read must not happen for a non-completed run");
        },
      };
      const finalized = await finalizeCanary({
        ...canary,
        result: { ...canary.result, state },
        corridor: loaded.value,
        verifier: exploding,
        manifestPath,
        write: true,
      });
      expect(finalized.ok).toBe(false);
      if (!finalized.ok) expect(finalized.error.message).toContain("manifest was not changed");
      expect(readFileSync(manifestPath, "utf8")).toBe(before);
    });
  }
});
