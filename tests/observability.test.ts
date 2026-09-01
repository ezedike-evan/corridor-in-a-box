import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  createMockSubmitter,
  execute,
  reconcileUntil,
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
      resolver: new StaticRouteResolver(() => createMockAdapter()),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      now: () => 1700000000000,
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
    });
    // versions are monotonic
    const versions = audit.entries.map((e) => e.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it("records the error on a failing transition", async () => {
    const audit = new InMemoryAuditLog();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ kyc: "rejected" })),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
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
      resolver: new StaticRouteResolver(() => createMockAdapter()),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      logger,
      metrics,
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
