import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

  describe("canary subcommand", () => {
    it("prints usage and exits 2 when the file arg is missing", () => {
      const r = run(["canary"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage: corridor canary");
    });

    it("argument validation: exits 2 when --amount is missing", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--amount <amount> is required");
    });

    it("argument validation: exits 2 when --amount has no value", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml", "--amount"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--amount requires a value");
    });

    it("argument validation: exits 2 when --amount is non-positive or malformed", () => {
      const r1 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "abc"]);
      expect(r1.status).toBe(2);
      expect(r1.stderr).toContain("positive decimal amount");

      const r2 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "-1.00"]);
      expect(r2.status).toBe(2);
      expect(r2.stderr).toContain("positive decimal amount");

      const r3 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "0"]);
      expect(r3.status).toBe(2);
      expect(r3.stderr).toContain("positive decimal amount");
    });

    it("argument validation: exits 2 when --network is invalid", () => {
      const r = run([
        "canary",
        "corridors/reference.corridor.yaml",
        "--amount",
        "1.00",
        "--network",
        "regtest",
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--network must be "public" or "testnet"');
    });

    it("mainnet refusal without flag: exits 3 when --network public is omitted", () => {
      const r = run(["canary", "corridors/ng-cowrie.corridor.yaml", "--amount", "1.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("settles on MAINNET");
      expect(r.stderr).toContain("Pass --network public explicitly");
    });

    it("over-cap refusal: exits 3 when amount exceeds default canary cap", () => {
      const r = run(["canary", "tests/fixtures/verified.corridor.yaml", "--amount", "25.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("exceeds canary cap");
    });

    it("over-cap refusal: exits 3 when amount exceeds proof.canary_max_amount", () => {
      const r = run([
        "canary",
        "tests/fixtures/canary-capped.corridor.yaml",
        "--amount",
        "6.00",
      ]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('exceeds canary cap "5.00"');
    });

    it("liveness refusal: exits 3 when corridor endpoints are UNVERIFIED", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml", "--amount", "1.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("liveness is UNVERIFIED");
      expect(r.stderr).toContain("must be VERIFIED to run canary");
    });
  });
});
