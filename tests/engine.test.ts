import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  hasRequestedRefund,
  canTransition,
  createMockSubmitter,
  execute,
  reconcileUntil,
  type CorridorState,
  type EngineDeps,
  type PreSettleGate,
  type SettlementSubmitter,
} from "@corridor/engine";
import type { TransactionStatus } from "@corridor/adapter-kit";
import { fail, ok, type Outcome, type PaymentIntent } from "@corridor/types";

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
    recovery: { max_retries: 2 },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function intent(key = "k1"): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

function deps(adapterOpts = {}, trustManifestWithoutAttestation = true): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    trustManifestWithoutAttestation,
  };
}

describe("engine.execute", () => {
  it("walks a payment to completed", async () => {
    const r = await execute(intent(), corridor(), deps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.stellarTxHash).toBeTruthy();
      expect(r.value.trail).toEqual([
        "created",
        "quoted",
        "compliant",
        "opened",
        "verifying",
        "settling",
        "settled",
        "reconciled",
        "completed",
      ]);
    }
  });

  it("fails closed on an expired quote", async () => {
    const r = await execute(intent(), corridor(), deps({ expireQuoteImmediately: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUOTE_EXPIRED");
  });

  it("does not settle against a quote that expired during a retry", async () => {
    // The quote was VALID when execute() started (unlike the test above) —
    // it expires only partway through the settle/retry loop, e.g. because a
    // slow anchor or a couple of retries ran out the clock. Without a fresh
    // expiry check inside the loop, the second settle attempt would submit
    // at a stale, no-longer-honoured rate.
    let clock = Date.now();
    const now = () => clock;
    // Stands in for a retry backoff that, combined with real-world latency,
    // runs well past the quote's ~60s validity window.
    const sleep = async (ms: number) => {
      clock += ms + 65_000;
    };

    let submitCalls = 0;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalls++;
        return fail("SETTLEMENT_FAILED", "simulated transient failure", { retryable: true });
      },
      async refund() {
        return fail("SETTLEMENT_FAILED", "not reached", { retryable: false });
      },
    };

    const r = await execute(intent(), corridor(), {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: new InMemoryIdempotencyStore(),
      now,
      sleep,
      trustManifestWithoutAttestation: true,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUOTE_EXPIRED");
    // Exactly one settle attempt: the retry loop's fresh expiry check catches
    // the stale quote before ever calling submit() a second time.
    expect(submitCalls).toBe(1);
  });

  it("a public-network corridor with manifest trust and no opt-in ends failed before settling", async () => {
    let submitCalled = false;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalled = true;
        return ok({ stellarTxHash: "hash", ledger: 1 });
      },
      async refund() {
        return ok({ stellarTxHash: "refund-hash", ledger: 2 });
      },
    };
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: store,
      audit,
      // No trustManifestWithoutAttestation on deps or opts
    };

    const c = corridor(); // network: "public"
    const i = intent("manifest-refuse-1");
    const r = await execute(i, c, d);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("MANIFEST_INVALID");
      expect(r.error.message).toContain("refusing manifest route trust on public network");
    }

    const stored = await store.get(i.idempotencyKey);
    expect(stored?.state).toBe("failed");
    expect(submitCalled).toBe(false);

    const trail = audit.entries.map((e) => e.to);
    expect(trail).toContain("failed");
    expect(trail).not.toContain("settling");
    expect(trail).not.toContain("settled");
    expect(trail).not.toContain("completed");
  });

  it("fails closed when KYC is rejected", async () => {
    const r = await execute(intent(), corridor(), deps({ kyc: "rejected" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("KYC_REJECTED");
  });

  it("is idempotent: a second in-flight run with the same key conflicts", async () => {
    const sharedDeps = deps();
    const c = corridor();
    const a = await execute(intent("dup"), c, sharedDeps);
    expect(a.ok).toBe(true);
    // completed run with same key returns idempotently rather than re-settling
    const b = await execute(intent("dup"), c, sharedDeps);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value.state).toBe("completed");
  });

  it("rejects a malformed source amount before touching the chain", async () => {
    const bad: PaymentIntent = {
      ...intent(),
      sourceAmount: { asset: "USDC", amount: "1,000" },
    };
    const r = await execute(bad, corridor(), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AMOUNT_INVALID");
  });

  it("reuses an existing on-chain settlement without calling submit()", async () => {
    let submitCalls = 0;
    const existingRef = { stellarTxHash: "existing-tx-hash-123", ledger: 777 };
    const submitter = createMockSubmitter({ existingRef });
    const originalSubmit = submitter.submit;
    submitter.submit = async (req) => {
      submitCalls++;
      return originalSubmit(req);
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent("existing-settle"), corridor(), d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.stellarTxHash).toBe("existing-tx-hash-123");
    }
    expect(submitCalls).toBe(0);
  });
});

describe("engine pre-settle gate", () => {
  it("terminates in failed with check code and 0 submit calls when gate check fails", async () => {
    let submitCalls = 0;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalls++;
        return ok({ stellarTxHash: "tx-123", ledger: 100 });
      },
      async refund() {
        return ok({ stellarTxHash: "refund-123", ledger: 101 });
      },
    };

    const metrics = new InMemoryMetrics();
    const failingGate: PreSettleGate = {
      async evaluate() {
        return {
          passed: false,
          results: [
            {
              name: "chain.balance",
              passed: false,
              code: "PRESETTLE_INSUFFICIENT_FUNDS",
              detail: "insufficient bridge asset balance",
              durationMs: 5,
            },
          ],
        };
      },
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      gate: failingGate,
      idempotency: new InMemoryIdempotencyStore(),
      metrics,
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent(), corridor(), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(r.error.message).toBe("insufficient bridge asset balance");
    }
    expect(submitCalls).toBe(0);
    const gateCounters = metrics.counters.filter((c) => c.name === "corridor.gate.check");
    expect(gateCounters).toHaveLength(1);
    expect(gateCounters[0].tags).toEqual({ name: "chain.balance", passed: "false" });
  });

  it("re-evaluates gate after retrying (attempt 1 fails submit, attempt 2 fails gate)", async () => {
    let submitCalls = 0;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalls++;
        return fail("SETTLEMENT_FAILED", "transient network error", { retryable: true });
      },
      async refund() {
        return ok({ stellarTxHash: "refund-123", ledger: 101 });
      },
    };

    const evaluatedAttempts: number[] = [];
    const gate: PreSettleGate = {
      async evaluate(ctx) {
        evaluatedAttempts.push(ctx.attempt);
        if (ctx.attempt === 0) {
          return {
            passed: true,
            results: [
              {
                name: "chain.balance",
                passed: true,
                detail: "sufficient",
                durationMs: 2,
              },
            ],
          };
        }
        return {
          passed: false,
          results: [
            {
              name: "chain.balance",
              passed: false,
              code: "PRESETTLE_INSUFFICIENT_FUNDS",
              detail: "balance depleted on retry",
              durationMs: 2,
            },
          ],
        };
      },
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      gate,
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent(), corridorWith({ max_retries: 2 }), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(r.error.message).toBe("balance depleted on retry");
    }
    expect(evaluatedAttempts).toEqual([0, 1]);
    expect(submitCalls).toBe(1); // attempt 0 called submit; attempt 1 died at gate before submit
  });

  it("ends failed without entering settling when gate evaluation throws", async () => {
    let submitCalled = false;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalled = true;
        return ok({ stellarTxHash: "tx-123", ledger: 100 });
      },
      async refund() {
        return ok({ stellarTxHash: "refund-123", ledger: 101 });
      },
    };

    const audit = new InMemoryAuditLog();
    const throwingGate: PreSettleGate = {
      async evaluate() {
        throw new Error("unexpected gate crash");
      },
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      gate: throwingGate,
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent(), corridor(), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_FAILED");
      expect(r.error.message).toContain("unexpected gate crash");
    }
    expect(submitCalled).toBe(false);

    const states = audit.entries.map((e) => e.to);
    expect(states).toContain("verifying");
    expect(states).toContain("failed");
    expect(states).not.toContain("settling");
  });
});

// Helper: build a corridor with custom recovery policy / timeout.
function corridorWith(recovery: Record<string, unknown>): Corridor {
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
    recovery,
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

describe("engine recovery", () => {
  it("refunds the sender when settlement fails and no payment went out", async () => {
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter({ failSubmit: true }),
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
      trustManifestWithoutAttestation: true,
    };
    const r = await execute(
      intent(),
      corridorWith({ max_retries: 1, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SETTLEMENT_FAILED");
  });

  it("reverses the on-chain payment when reconcile times out (refund path)", async () => {
    let t = 0;
    const refunded: string[] = [];
    const base = createMockSubmitter();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: {
        submit: base.submit,
        refund: async (req) => {
          refunded.push(req.original.stellarTxHash);
          return base.refund(req);
        },
      },
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
    };
    const r = await execute(
      intent(),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("polls=3");
      expect(r.error.message).toContain("elapsed=1000ms");
      expect(r.error.message).toContain("first status=pending_receiver");
      expect(r.error.message).toContain("last status=pending_receiver");
    }
    // a settlement went out, so the engine must have reversed it on-chain
    expect(refunded).toHaveLength(1);
  });

  it("SETTLEMENT_TIMEOUT carries poll count, elapsed ms, and first/last status in error message", async () => {
    let clock = 1000;
    let pollCount = 0;
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async () => {
        pollCount++;
        const status = pollCount === 1 ? "pending_sender" : "pending_receiver";
        return {
          ok: true as const,
          value: {
            status,
            settled: false,
            terminalFailure: false,
          },
        };
      },
    };

    const r = await reconcileUntil(adapter, "tx-stall", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      deadlineMs: 3000,
      pollMs: 1000,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("tx tx-stall did not settle before timeout");
      expect(r.error.message).toContain("polls=3");
      expect(r.error.message).toContain("elapsed=2000ms");
      expect(r.error.message).toContain("first status=pending_sender");
      expect(r.error.message).toContain("last status=pending_receiver");
    }
  });

  it("SETTLEMENT_TIMEOUT records identical first and last status for a stalled observer", async () => {
    let clock = 0;
    const adapter = createMockAdapter({ settled: false }); // returns pending_receiver

    const r = await reconcileUntil(adapter, "tx-never-moves", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      deadlineMs: 2000,
      pollMs: 500,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("polls=5");
      expect(r.error.message).toContain("first status=pending_receiver");
      expect(r.error.message).toContain("last status=pending_receiver");
    }
  });

  it("says so in the timeout when the anchor was blocked on someone's input", async () => {
    // An operator reading a SETTLEMENT_TIMEOUT needs to know who to chase. A run
    // that timed out on `pending_customer_info_update` was waiting on a party to
    // supply information, not on a slow anchor — the message must say which.
    let t = 0;
    const base = createMockAdapter({ settled: false });
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(
        () => ({
          ...base,
          getTransaction: async () =>
            ok({
              status: "pending_customer_info_update",
              settled: false,
              terminalFailure: false,
              awaitingInput: true,
            }),
        }),
        { trustManifestWithoutAttestation: true },
      ),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
    };
    const r = await execute(
      intent("awaiting-input"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "hold" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.message).toContain("pending_customer_info_update");
      expect(r.error.message).toContain("awaiting input from another party");
    }
  });

  it("persists the refund id so a resumed run has evidence it already refunded", async () => {
    // Without this, a run records that the payment went out but not that the
    // refund did — and a resumed process asks for a second one. Not settling
    // twice, but money moving twice.
    let t = 0;
    const store = new InMemoryIdempotencyStore();
    const base = createMockSubmitter();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: base,
      idempotency: store,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
    };
    const i = intent();
    await execute(
      i,
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      d,
    );

    const stored = await store.get(i.idempotencyKey);
    expect(stored?.state).toBe("refunded");
    expect(stored?.stellarTxHash).toBeTruthy();
    expect(stored?.refundId).toBeTruthy();
    expect(stored?.refundId).not.toBe(stored?.stellarTxHash);
    expect(hasRequestedRefund(stored!)).toBe(true);
  });

  it("does not issue a second refund for a key that already refunded", async () => {
    let t = 0;
    const refunded: string[] = [];
    const store = new InMemoryIdempotencyStore();
    const base = createMockSubmitter();
    const deps = (): EngineDeps => ({
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: {
        submit: base.submit,
        refund: async (req) => {
          refunded.push(req.original.stellarTxHash);
          return base.refund(req);
        },
      },
      idempotency: store,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
    });
    const c = corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" });
    const i = intent();

    await execute(i, c, deps());
    expect(refunded).toHaveLength(1);

    // Re-running the same key must not send the money back again.
    const again = await execute(i, c, deps());
    expect(again.ok).toBe(false);
    expect(refunded).toHaveLength(1);
  });

  it("bails out of reconcile immediately on a terminal anchor failure", async () => {
    let t = 0;
    let polls = 0;
    const refunded: string[] = [];
    const base = createMockSubmitter();
    const failing = createMockAdapter({ terminalFailure: true });
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(
        () => ({
          ...failing,
          getTransaction: async (id) => {
            polls += 1;
            return failing.getTransaction(id);
          },
        }),
        { trustManifestWithoutAttestation: true },
      ),
      submitter: {
        submit: base.submit,
        refund: async (req) => {
          refunded.push(req.original.stellarTxHash);
          return base.refund(req);
        },
      },
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      // A long timeout: if the engine waited it out instead of bailing, the test
      // would still pass on the error code — so assert it polled only once.
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
    };
    const r = await execute(
      intent("terminal-1"),
      corridorWith({ max_retries: 0, timeout_seconds: 3600, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_MISMATCH");
    expect(polls).toBe(1); // bailed on the first status, did not poll to timeout
    // The anchor already reports the failure, so the run waits for its refund
    // report (refund_pending) rather than asking the chain to reverse.
    expect(refunded).toHaveLength(0);
  });

  it("escalates a REFUND_UNSUPPORTED refund to held (fail-closed refund path)", async () => {
    // A settlement went out, recovery wants to refund, but the refund port
    // reports the operation is not supported at all (e.g. SEP-31 has no
    // sender-initiated refund endpoint). Non-retryable and non-actionable by
    // the engine: the only safe landing is `held`, for a human, with the
    // refusal recorded — never a retry loop, never an invented endpoint.
    let t = 0;
    const base = createMockSubmitter();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: {
        submit: base.submit,
        refund: async () =>
          fail("REFUND_UNSUPPORTED", "no sender-initiated refund endpoint", {
            retryable: false,
          }),
      },
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
    };
    const store = d.idempotency!;
    const r = await execute(
      intent("refund-unsupported"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("REFUND_UNSUPPORTED");
    const stored = await store.get("refund-unsupported");
    expect(stored?.state).toBe("held");
  });

  it("parks for manual intervention when rollback policy is hold", async () => {
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter({ failSubmit: true }),
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
      trustManifestWithoutAttestation: true,
    };
    const store = d.idempotency!;
    const r = await execute(
      intent("hold-1"),
      corridorWith({ max_retries: 0, rollback: "hold" }),
      d,
    );
    expect(r.ok).toBe(false);
    const stored = await store.get("hold-1");
    expect(stored?.state).toBe("held");
  });
});

describe("reconcile stall detection", () => {
  // Build a tiny AnchorAdapter whose getTransaction always (or consecutively)
  // returns the supplied status, while delegating everything else to the mock.
  const stalledAdapter = (status: string) => {
    let polls = 0;
    const adapter = {
      ...createMockAdapter({ settled: false }),
      getTransaction: async (): Promise<Outcome<TransactionStatus>> => {
        polls++;
        return ok<TransactionStatus>({
          status,
          settled: false,
          terminalFailure: false,
        });
      },
    };
    return { adapter, polls: () => polls };
  };

  it("returns RECONCILE_STALLED when status stays the same for stallThreshold polls", async () => {
    const { adapter, polls } = stalledAdapter("pending_receiver");
    let t = 0;
    const result = await reconcileUntil(adapter, "tx_stall", {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      deadlineMs: t + 600_000,
      pollMs: 100,
      stallThreshold: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RECONCILE_STALLED");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("pending_receiver");
      expect(result.error.message).toContain("3");
    }
    expect(polls()).toBe(4); // threshold + 1 (the poll that triggers the bail)
  });

  it("does NOT stall when the status advances between polls", async () => {
    let callIdx = 0;
    const adapter = {
      ...createMockAdapter({ settled: false }),
      getTransaction: async (): Promise<Outcome<TransactionStatus>> => {
        callIdx++;
        // Every poll returns a different status — sameCount never accumulates.
        return ok<TransactionStatus>({ status: `status_${callIdx}`, settled: false });
      },
    };
    let t = 0;
    const result = await reconcileUntil(adapter, "tx_no_stall", {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      deadlineMs: t + 100,
      pollMs: 10,
      stallThreshold: 3,
    });
    // Should time out, NOT stall — because the status keeps advancing,
    // resetting the consecutive counter on every poll.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SETTLEMENT_TIMEOUT");
    }
    expect(callIdx).toBeGreaterThan(3);
  });

  it("stalls exactly at threshold, not before", async () => {
    const { adapter, polls } = stalledAdapter("stuck");
    let t = 0;
    // First poll sets lastStatus="stuck" with sameCount=0; each subsequent poll
    // increments sameCount. So threshold=N means the stall fires on poll N+1.
    const result = await reconcileUntil(adapter, "tx_exact", {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      deadlineMs: t + 600_000,
      pollMs: 100,
      stallThreshold: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RECONCILE_STALLED");
    expect(polls()).toBe(6);
  });

  it("does NOT stall when stallThreshold is omitted (disabled at this layer)", async () => {
    const { adapter, polls } = stalledAdapter("stuck");
    let t = 0;
    // reconcileUntil reads `opts.stallThreshold ?? 0`, so omitting the option
    // disables stall detection here: an anchor stuck on one status forever has
    // to reach the deadline timeout rather than return RECONCILE_STALLED.
    // (execute() applies the production default of 10 one level up in run.ts.)
    const result = await reconcileUntil(adapter, "tx_omitted_threshold", {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      deadlineMs: t + 500,
      pollMs: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SETTLEMENT_TIMEOUT");
    expect(polls()).toBeGreaterThan(1);
  });
});

describe("state machine", () => {
  it("permits the forward path and forbids skips", () => {
    expect(canTransition("created", "quoted")).toBe(true);
    expect(canTransition("settling", "settled")).toBe(true);
    expect(canTransition("created", "settled")).toBe(false);
    expect(canTransition("completed", "settling")).toBe(false);
  });

  it("routes the settle retry loop through `retrying`, not `recovering`", () => {
    // These were one state, and this test used to assert
    // `canTransition("recovering", "settling") === true` — which, combined with
    // `settled -> recovering`, made `settled -> recovering -> settling` a legal
    // path: a re-submission of a payment that had already gone out. A property
    // test walking the graph found it. The two kinds of recovery are now
    // distinct so the double-spend is unreachable by construction.
    expect(canTransition("settling", "retrying")).toBe(true);
    expect(canTransition("retrying", "verifying")).toBe(true);
    expect(canTransition("retrying", "settling")).toBe(false);

    // `recovering` is terminal-bound and cannot get back to the chain.
    expect(canTransition("recovering", "settling")).toBe(false);
    expect(canTransition("recovering", "refunded")).toBe(true);
    expect(canTransition("recovering", "held")).toBe(true);

    // And the path that motivated the split stays closed.
    expect(canTransition("settled", "settling")).toBe(false);
    expect(canTransition("settled", "recovering")).toBe(true);
  });
});

// --- the refund path ------------------------------------------------------
//
// `refundAndStop` is the branch that runs after something has already gone
// wrong, which is exactly when it is least likely to have been exercised by
// hand. Every case below goes through the mock adapter and mock submitter — no
// network, per CONTRIBUTING.md — and reads the outcome from the store and the
// audit log rather than the return value, because a recovered run always
// returns an error: the interesting part is *where it stopped*.

interface RefundHarness {
  deps: EngineDeps;
  store: InMemoryIdempotencyStore;
  audit: InMemoryAuditLog;
  /** Every refund the engine asked for. Empty means it never touched the chain. */
  refundCalls: { stellarTxHash: string; reason?: string }[];
  /** The states the run passed through, in order, per the audit log. */
  trail: () => CorridorState[];
}

function refundHarness(
  opts: {
    /** Make the on-chain settlement itself fail, so no payment ever goes out. */
    failSubmit?: boolean;
    /** Make the refund fail, standing in for an anchor that refuses it. */
    refundError?: string;
    /** Anchor never reports the payment as settled, so reconcile times out. */
    settled?: boolean;
  } = {},
): RefundHarness {
  const base = createMockSubmitter({ failSubmit: opts.failSubmit ?? false });
  const refundCalls: RefundHarness["refundCalls"] = [];
  const store = new InMemoryIdempotencyStore();
  const audit = new InMemoryAuditLog();
  let t = 0;

  const submitter: SettlementSubmitter = {
    submit: base.submit,
    async refund(req) {
      refundCalls.push({ stellarTxHash: req.original.stellarTxHash, reason: req.reason });
      if (opts.refundError) {
        return fail("SETTLEMENT_FAILED", opts.refundError, { retryable: false });
      }
      return base.refund(req);
    },
  };

  return {
    store,
    audit,
    refundCalls,
    trail: () => audit.entries.map((e) => e.to),
    deps: {
      resolver: new StaticRouteResolver(
        () => createMockAdapter({ settled: opts.settled ?? true }),
        { trustManifestWithoutAttestation: true },
      ),
      submitter,
      idempotency: store,
      audit,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
    },
  };
}

describe("engine refund path", () => {
  it("reaches refunded when the anchor accepts the refund", async () => {
    const h = refundHarness({ settled: false });
    const r = await execute(
      intent("refund-ok"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      h.deps,
    );

    // A recovered run still reports the failure that caused it.
    expect(r.ok).toBe(false);

    const run = await h.store.get("refund-ok");
    expect(run?.state).toBe("refunded");
    expect(h.trail()).toEqual([
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "recovering",
      "refunded",
    ]);

    // The refund reversed the payment that actually went out, and carries the
    // reason so the anchor's own record says why.
    expect(h.refundCalls).toHaveLength(1);
    expect(h.refundCalls[0]?.stellarTxHash).toBe(run?.stellarTxHash);
    expect(h.refundCalls[0]?.reason).toContain("SETTLEMENT_TIMEOUT");
  });

  it("escalates to held when the refund is rejected, keeping the anchor's reason", async () => {
    const h = refundHarness({
      settled: false,
      refundError: "anchor refused the refund: destination account closed",
    });
    const r = await execute(
      intent("refund-rejected"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      h.deps,
    );

    expect(r.ok).toBe(false);

    const run = await h.store.get("refund-rejected");
    // Money left and could not be returned: a human has to look at it, and the
    // run must not look finished.
    expect(run?.state).toBe("held");
    expect(run?.lastError).toContain("destination account closed");
    expect(h.trail().at(-1)).toBe("held");
    expect(h.refundCalls).toHaveLength(1);
  });

  it("records the refund without touching the chain when no payment went out", async () => {
    const h = refundHarness({ failSubmit: true });
    const r = await execute(
      intent("refund-no-payment"),
      corridorWith({ max_retries: 1, rollback: "refund_sender" }),
      h.deps,
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SETTLEMENT_FAILED");

    const run = await h.store.get("refund-no-payment");
    expect(run?.state).toBe("refunded");
    expect(run?.stellarTxHash).toBeUndefined();
    // Nothing is on-chain to reverse — the sending anchor returns the sender's
    // funds off-chain — so the engine must not ask the submitter to reverse it.
    expect(h.refundCalls).toEqual([]);
  });

  it("never attempts a refund when the corridor says hold", async () => {
    const h = refundHarness({ settled: false });
    const r = await execute(
      intent("rollback-hold"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "hold" }),
      h.deps,
    );

    expect(r.ok).toBe(false);

    const run = await h.store.get("rollback-hold");
    expect(run?.state).toBe("held");
    expect(run?.lastError).toContain("SETTLEMENT_TIMEOUT");
    expect(h.refundCalls).toEqual([]);
    expect(h.trail().at(-1)).toBe("held");
  });

  it("fails without a refund when the corridor says manual", async () => {
    const h = refundHarness({ settled: false });
    const r = await execute(
      intent("rollback-manual"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "manual" }),
      h.deps,
    );

    expect(r.ok).toBe(false);

    const run = await h.store.get("rollback-manual");
    expect(run?.state).toBe("failed");
    expect(h.refundCalls).toEqual([]);
    expect(h.trail()).not.toContain("refunded");
  });

  it("never re-enters settling once the refund path has been taken", async () => {
    // The invariant, asserted on a real run rather than only on the table: a
    // run that has settled and then recovered must never submit again.
    const h = refundHarness({ settled: false });
    await execute(
      intent("no-resettle"),
      corridorWith({ max_retries: 2, timeout_seconds: 1, rollback: "refund_sender" }),
      h.deps,
    );

    const afterRecovering = h.trail().slice(h.trail().indexOf("recovering"));
    expect(afterRecovering).not.toContain("settling");
    expect(afterRecovering).not.toContain("retrying");
  });
});

describe("refund_pending producer", () => {
  it("parks in refund_pending, without calling submitter.refund, when the anchor errors after settle", async () => {
    const h = refundHarness();
    const d: EngineDeps = {
      ...h.deps,
      resolver: new StaticRouteResolver(() => createMockAdapter({ terminalFailure: true }), {
        trustManifestWithoutAttestation: true,
      }),
    };
    const r = await execute(
      intent("rp-1"),
      corridorWith({ max_retries: 0, timeout_seconds: 3600, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_MISMATCH");
    expect((await h.store.get("rp-1"))?.state).toBe("refund_pending");
    expect(h.trail()).toEqual([
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "recovering",
      "refund_pending",
    ]);
    expect(h.refundCalls).toHaveLength(0);
    expect((await h.store.get("rp-1"))?.refundId).toBeUndefined();
  });

  it("does not treat a reconcile timeout as an anchor refund: still reverses via the submitter", async () => {
    const h = refundHarness({ settled: false });
    await execute(
      intent("rp-2"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      h.deps,
    );
    expect((await h.store.get("rp-2"))?.state).toBe("refunded");
    expect(h.refundCalls).toHaveLength(1);
  });

  it("no-hash path (settle never succeeded) still ends refunded without touching the chain", async () => {
    const h = refundHarness({ failSubmit: true });
    await execute(
      intent("rp-3"),
      corridorWith({ max_retries: 0, timeout_seconds: 60, rollback: "refund_sender" }),
      h.deps,
    );
    expect((await h.store.get("rp-3"))?.state).toBe("refunded");
    expect(h.refundCalls).toHaveLength(0);
  });

  it("hold policy is unchanged: anchor error after settle ends held", async () => {
    const h = refundHarness();
    const d: EngineDeps = {
      ...h.deps,
      resolver: new StaticRouteResolver(() => createMockAdapter({ terminalFailure: true }), {
        trustManifestWithoutAttestation: true,
      }),
    };
    await execute(
      intent("rp-4"),
      corridorWith({ max_retries: 0, timeout_seconds: 3600, rollback: "hold" }),
      d,
    );
    expect((await h.store.get("rp-4"))?.state).toBe("held");
  });
});
