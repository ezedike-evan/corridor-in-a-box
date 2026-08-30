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
  return spawnSync(TSX, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

describe("corridor CLI", () => {
  it("prints usage and exits 2 with no args", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor <validate|plan>");
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

  it("plan: reports VERIFIED only when endpoints_verified_at is set", () => {
    const r = run(["plan", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-01-01");
  });

  it("plan: reports UNVERIFIED for a fully-specified but unchecked corridor", () => {
    const r = run(["plan", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ? UNVERIFIED");
    expect(r.stdout).toContain("NOT runnable");
    // Regression guard for the claim that got the project rejected: a corridor
    // with unconfirmed endpoints must never carry the green marker.
    expect(r.stdout).not.toContain("✓ VERIFIED");
  });

  it("plan: never reports a placeholder-endpoint corridor as runnable", () => {
    const r = run(["plan", "corridors/mx-example.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNVERIFIED");
    expect(r.stdout).not.toContain("✓ VERIFIED");
  });

  it("plan: reports all three liveness warnings for a corridor missing dest endpoints", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.status).toBe(0); // warnings don't fail the command
    expect(r.stdout).toContain("NOT RUNNABLE");
    expect(r.stdout).toContain("quotes will fail");
    expect(r.stdout).toContain("no per-customer KYC");
  });

  it("plan: prints the status_note when present", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.stdout).toContain("PENDING");
  });
});
