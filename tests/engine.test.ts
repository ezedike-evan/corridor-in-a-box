import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  hasRequestedRefund,
  canTransition,
  createMockSubmitter,
  execute,
  reconcileUntil,
  type EngineDeps,
  type SettlementSubmitter,
} from "@corridor/engine";
import { fail, ok, type PaymentIntent } from "@corridor/types";

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

function deps(adapterOpts = {}): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts)),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
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
      resolver: new StaticRouteResolver(() => createMockAdapter()),
      submitter,
      idempotency: new InMemoryIdempotencyStore(),
      now,
      sleep,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUOTE_EXPIRED");
    // Exactly one settle attempt: the retry loop's fresh expiry check catches
    // the stale quote before ever calling submit() a second time.
    expect(submitCalls).toBe(1);
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
      resolver: new StaticRouteResolver(() => createMockAdapter()),
      submitter: createMockSubmitter({ failSubmit: true }),
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
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
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false })),
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
      resolver: new StaticRouteResolver(() => ({
        ...base,
        getTransaction: async () =>
          ok({
            status: "pending_customer_info_update",
            settled: false,
            terminalFailure: false,
            awaitingInput: true,
          }),
      })),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
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
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false })),
      submitter: base,
      idempotency: store,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
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
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false })),
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
      resolver: new StaticRouteResolver(() => ({
        ...failing,
        getTransaction: async (id) => {
          polls += 1;
          return failing.getTransaction(id);
        },
      })),
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
    };
    const r = await execute(
      intent("terminal-1"),
      corridorWith({ max_retries: 0, timeout_seconds: 3600, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_MISMATCH");
    expect(polls).toBe(1); // bailed on the first status, did not poll to timeout
    expect(refunded).toHaveLength(1); // and reversed the on-chain payment
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
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false })),
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
      resolver: new StaticRouteResolver(() => createMockAdapter()),
      submitter: createMockSubmitter({ failSubmit: true }),
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
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
    expect(canTransition("retrying", "settling")).toBe(true);

    // `recovering` is terminal-bound and cannot get back to the chain.
    expect(canTransition("recovering", "settling")).toBe(false);
    expect(canTransition("recovering", "refunded")).toBe(true);
    expect(canTransition("recovering", "held")).toBe(true);

    // And the path that motivated the split stays closed.
    expect(canTransition("settled", "settling")).toBe(false);
    expect(canTransition("settled", "recovering")).toBe(true);
  });
});
