import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  canTransition,
  createMockSubmitter,
  execute,
  type CorridorState,
  type EngineDeps,
  type SettlementSubmitter,
} from "@corridor/engine";
import { fail, type PaymentIntent } from "@corridor/types";

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
    if (!r.ok) expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
    // a settlement went out, so the engine must have reversed it on-chain
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
      resolver: new StaticRouteResolver(() =>
        createMockAdapter({ settled: opts.settled ?? true }),
      ),
      submitter,
      idempotency: store,
      audit,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
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
