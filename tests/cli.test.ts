import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { InMemoryIdempotencyStore } from "@corridor/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listHeldRuns,
  parseListArgs,
  parseResolveArgs,
  resolveHeldRun,
} from "../packages/cli/src/runs";

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
  it("requires held state for run listing", () => {
    const r = run(["runs", "list", "--state", "completed"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("corridor runs list --state held");
  });

  it("requires an outcome and note to resolve a run", () => {
    const r = run(["resolve", "some-key"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--outcome");
  });

  it("requires DATABASE_URL for run listing", () => {
    const r = spawnSync(TSX, [CLI, "runs", "list", "--state", "held"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL is required");
  });

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

  it("plan: prints limits min and max when set", () => {
    const r = run(["plan", "tests/fixtures/limits.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("limits:   min=10.00 max=500.00");
  });
});

describe("corridor runs (held-run operator commands)", () => {
  const seed = async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "held-1",
      corridorId: "ref",
      state: "held",
      version: 4,
      stellarTxHash: "abc123",
      lastError: "anchor stalled",
    });
    await store.put({
      idempotencyKey: "done-1",
      corridorId: "ref",
      state: "completed",
      version: 6,
    });
    return store;
  };
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m) => void err.push(String(m)));
    return { out, err };
  };
  afterEach(() => vi.restoreAllMocks());

  it("list prints a header and one tab-separated row per held run", async () => {
    const store = await seed();
    const { out } = capture();
    const code = await listHeldRuns(store, parseListArgs(["list", "--state", "held"])!);
    expect(code).toBe(0);
    expect(out).toEqual([
      "idempotency_key\tcorridor_id\tstate\tversion\tstellar_tx_hash\tlast_error",
      "held-1\tref\theld\t4\tabc123\tanchor stalled",
    ]);
  });

  it("resolve records the outcome for a held run and leaves the run held", async () => {
    const store = await seed();
    capture();
    const parsed = parseResolveArgs(["held-1", "--outcome", "written-off", "--note", "n"])!;
    expect(await resolveHeldRun(store, parsed, "op")).toBe(0);
    expect(await store.getResolution("held-1")).toMatchObject({
      outcome: "written-off",
      resolvedBy: "op",
    });
    expect((await store.get("held-1"))?.state).toBe("held");
  });

  it("resolve rejects a non-held run and an unknown key", async () => {
    const store = await seed();
    const { err } = capture();
    const parsed = (key: string) =>
      parseResolveArgs([key, "--outcome", "refunded-offchain", "--note", "n"])!;
    expect(await resolveHeldRun(store, parsed("done-1"), "op")).toBe(1);
    expect(await resolveHeldRun(store, parsed("missing"), "op")).toBe(1);
    expect(err.join("\n")).toContain("only an existing held run can be resolved");
    expect(await store.getResolution("done-1")).toBeUndefined();
  });

  it("resolve rejects a second resolution and keeps the first", async () => {
    const store = await seed();
    const { err } = capture();
    const first = parseResolveArgs([
      "held-1",
      "--outcome",
      "paid-out-manually",
      "--note",
      "a",
    ])!;
    const second = parseResolveArgs(["held-1", "--outcome", "written-off", "--note", "b"])!;
    expect(await resolveHeldRun(store, first, "op")).toBe(0);
    expect(await resolveHeldRun(store, second, "op2")).toBe(1);
    expect(err.join("\n")).toContain("already has an out-of-band resolution");
    expect(await store.getResolution("held-1")).toMatchObject({
      outcome: "paid-out-manually",
    });
  });
});
