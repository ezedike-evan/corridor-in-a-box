import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  createMockSubmitter,
  emitTransition,
  execute,
  reconcileUntil,
  type CheckResult,
  type EngineDeps,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "obs-1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

describe("audit trail", () => {
  it("records one immutable entry per state transition, in order", async () => {
    const audit = new InMemoryAuditLog();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      now: () => 1700000000000,
      trustManifestWithoutAttestation: true,
    };
    const r = await execute(intent, corridor(), deps);
    expect(r.ok).toBe(true);

    // created -> quoted -> compliant -> opened -> settling -> settled
    //   -> reconciled -> completed = 7 transitions
    expect(audit.entries.map((e) => e.to)).toEqual([
      "quoted",
      "compliant",
      "opened",
      "settling",
      "settled",
      "reconciled",
      "completed",
    ]);
    expect(audit.entries[0]).toMatchObject({
      idempotencyKey: "obs-1",
      corridorId: "test",
      from: "created",
      to: "quoted",
      at: 1700000000000,
      routeTrust: "manifest",
    });
    // versions are monotonic
    const versions = audit.entries.map((e) => e.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it("records the error on a failing transition", async () => {
    const audit = new InMemoryAuditLog();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ kyc: "rejected" }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      trustManifestWithoutAttestation: true,
    };
    const r = await execute(intent, corridor(), deps);
    expect(r.ok).toBe(false);
    const failed = audit.entries.find((e) => e.to === "failed");
    expect(failed?.error).toContain("KYC_REJECTED");
  });
});

describe("reconcile polling observability", () => {
  it("emits a debug log and metric increment on every poll", async () => {
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      log(level: string, msg: string, fields?: Record<string, unknown>) {
        logs.push({ level, msg, fields });
      },
    };
    const metrics = new InMemoryMetrics();

    // Adapter returns pending twice before settled
    let pollCount = 0;
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async (_id: string) => {
        pollCount += 1;
        if (pollCount < 3) {
          return {
            ok: true as const,
            value: {
              status: "pending_sender",
              settled: false,
              terminalFailure: false,
            },
          };
        }
        return {
          ok: true as const,
          value: {
            status: "success",
            settled: true,
            terminalFailure: false,
          },
        };
      },
    };

    let clock = 1000;
    const r = await reconcileUntil(adapter, "tx-123", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      deadlineMs: 50000,
      pollMs: 1000,
      corridorId: "test-corridor",
      logger,
      metrics,
    });

    expect(r.ok).toBe(true);
    expect(pollCount).toBe(3);

    // Exactly 3 logs emitted, all debug level
    const pollLogs = logs.filter((l) => l.msg === "corridor.reconcile.poll");
    expect(pollLogs).toHaveLength(3);
    expect(pollLogs.every((l) => l.level === "debug")).toBe(true);

    expect(pollLogs[0].fields).toEqual({
      transactionId: "tx-123",
      status: "pending_sender",
      poll: 1,
      elapsedMs: 0,
    });
    expect(pollLogs[1].fields).toEqual({
      transactionId: "tx-123",
      status: "pending_sender",
      poll: 2,
      elapsedMs: 1000,
    });
    expect(pollLogs[2].fields).toEqual({
      transactionId: "tx-123",
      status: "success",
      poll: 3,
      elapsedMs: 2000,
    });

    // Exactly 3 metric increments tagged with corridor and status
    const pollCounters = metrics.counters.filter((c) => c.name === "corridor.reconcile.poll");
    expect(pollCounters).toHaveLength(3);
    expect(pollCounters[0].tags).toEqual({
      corridor: "test-corridor",
      status: "pending_sender",
    });
    expect(pollCounters[1].tags).toEqual({
      corridor: "test-corridor",
      status: "pending_sender",
    });
    expect(pollCounters[2].tags).toEqual({ corridor: "test-corridor", status: "success" });
  });

  it("remains silent and does not throw when no logger or metrics are provided", async () => {
    const adapter = createMockAdapter();
    const r = await reconcileUntil(adapter, "tx-999", {
      now: () => 100,
      sleep: async () => {},
      deadlineMs: 500,
      pollMs: 50,
    });
    expect(r.ok).toBe(true);
  });

  it("passes logger and metrics through engine.execute during reconcile", async () => {
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      log(level: string, msg: string, fields?: Record<string, unknown>) {
        logs.push({ level, msg, fields });
      },
    };
    const metrics = new InMemoryMetrics();

    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      logger,
      metrics,
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent, corridor(), deps);
    expect(r.ok).toBe(true);

    const pollLogs = logs.filter((l) => l.msg === "corridor.reconcile.poll");
    expect(pollLogs.length).toBeGreaterThanOrEqual(1);
    expect(pollLogs[0].level).toBe("debug");
    expect(pollLogs[0].fields?.transactionId).toBeDefined();

    const pollMetrics = metrics.counters.filter((c) => c.name === "corridor.reconcile.poll");
    expect(pollMetrics.length).toBeGreaterThanOrEqual(1);
    expect(pollMetrics[0].tags?.corridor).toBe("test");
  });
});

// `verifying` (#138) is not a CorridorState yet and execute() does not run the
// gate yet (#141), so these drive emitTransition directly. Drop the
// `as never` casts once #138 lands, and assert through execute() after #141.
describe("pre-settle gate results in the audit trail", () => {
  const passing: CheckResult = {
    name: "chain.balance",
    passed: true,
    detail: "GSENDER holds 250.00 USDC, needs 100.00",
    durationMs: 12,
  };
  const failing: CheckResult = {
    name: "sep31.info.asset",
    passed: false,
    code: "SETTLEMENT_FAILED",
    detail: "anchor /info does not list USDC:GISSUER",
    durationMs: 40,
  };
  const run = (state: "settling" | "failed") => ({
    idempotencyKey: "obs-gate",
    corridorId: "test",
    state,
    version: 4,
  });
  const capture = () => {
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    return {
      logs,
      logger: {
        log(level: string, msg: string, fields?: Record<string, unknown>) {
          logs.push({ level, msg, fields });
        },
      },
    };
  };

  it("records one result per configured check on verifying -> settling", async () => {
    const audit = new InMemoryAuditLog();
    const { logs, logger } = capture();
    const checks = [passing, { ...passing, name: "stellar.toml.hash", detail: "match" }];

    await emitTransition({ audit, logger }, run("settling"), "verifying" as never, 1, {
      checks,
    });

    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0]!;
    expect(entry).toMatchObject({ from: "verifying", to: "settling" });
    expect(entry.checks).toHaveLength(checks.length);
    expect(entry.checks).toEqual(checks);

    const gateLogs = logs.filter((l) => l.msg === "corridor.gate.check");
    expect(gateLogs.map((l) => l.level)).toEqual(["info", "info"]);
  });

  it("records failed checks with passed:false, code and detail on verifying -> failed", async () => {
    const audit = new InMemoryAuditLog();
    const { logs, logger } = capture();

    await emitTransition({ audit, logger }, run("failed"), "verifying" as never, 1, {
      error: "SETTLEMENT_FAILED: pre-settle gate refused",
      checks: [passing, failing],
    });

    const entry = audit.entries[0]!;
    expect(entry.error).toContain("SETTLEMENT_FAILED");
    expect(entry.checks).toHaveLength(2);
    expect(entry.checks?.find((c) => !c.passed)).toEqual({
      name: "sep31.info.asset",
      passed: false,
      code: "SETTLEMENT_FAILED",
      detail: "anchor /info does not list USDC:GISSUER",
      durationMs: 40,
    });

    // info for the pass, warn for the failure — one line each.
    const gateLogs = logs.filter((l) => l.msg === "corridor.gate.check");
    expect(gateLogs.map((l) => [l.level, l.fields?.check])).toEqual([
      ["info", "chain.balance"],
      ["warn", "sep31.info.asset"],
    ]);
    expect(gateLogs[1]!.fields).toMatchObject({
      idempotencyKey: "obs-gate",
      passed: false,
      code: "SETTLEMENT_FAILED",
      detail: "anchor /info does not list USDC:GISSUER",
    });
    // The transition line stays flat; the results live on the per-check lines.
    const transition = logs.find((l) => l.msg === "corridor.transition");
    expect(transition?.fields).not.toHaveProperty("checks");
  });

  it("does not snapshot a caller's later mutation of the checks array", async () => {
    const audit = new InMemoryAuditLog();
    const checks = [passing];
    await emitTransition({ audit }, run("settling"), "verifying" as never, 1, { checks });
    checks.push(failing);
    expect(audit.entries[0]!.checks).toHaveLength(1);
  });

  it("leaves checks off every transition that is not leaving verifying", async () => {
    const audit = new InMemoryAuditLog();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      trustManifestWithoutAttestation: true,
    };
    const r = await execute({ ...intent, idempotencyKey: "obs-nochecks" }, corridor(), deps);
    expect(r.ok).toBe(true);
    expect(audit.entries.every((e) => !("checks" in e))).toBe(true);
  });
});
