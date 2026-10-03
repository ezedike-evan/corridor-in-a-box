// The circuit breaker: which failures count, when a lane trips, and what the
// engine does about it afterwards.
//
// The two halves are tested separately on purpose. `breakerOutcomeFor` decides
// what counts and is a pure function, so every classification question ("does a
// KYC rejection halt a lane?") is answered here as a table rather than inferred
// from an end-to-end run. The engine half then only has to prove it obeys.

import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryCorridorHealthStore,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  createMockSubmitter,
  execute,
  breakerOutcomeFor,
  justTripped,
  type CorridorHealthStore,
  type EngineDeps,
} from "@corridor/engine";
import type { CorridorErrorCode, PaymentIntent } from "@corridor/types";

function corridor(id = "test", breaker?: number): Corridor {
  const r = parseCorridor({
    id,
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
    recovery: breaker === undefined ? {} : { breaker: { consecutive_failures: breaker } },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function intent(key: string, id = "test"): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: id,
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

/** `failSubmit` makes the settlement leg refuse, which is a lane-level failure
 *  the run reaches without needing a real anchor to stall. Under the default
 *  `refund_sender` policy a run that never settled ends `refunded`, which the
 *  breaker counts — the money never moved, but the lane did fail to pay out. */
function deps(
  health: CorridorHealthStore,
  opts: { metrics?: InMemoryMetrics; failSubmit?: boolean } = {},
): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter({ failSubmit: opts.failSubmit ?? true }),
    idempotency: new InMemoryIdempotencyStore(),
    health,
    metrics: opts.metrics,
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
  };
}

describe("breakerOutcomeFor", () => {
  // The classification is the whole safety argument for the feature: a breaker
  // that counts the wrong failures halts healthy lanes, and one that misses the
  // right ones is the no-op it was meant to replace.
  it("counts a completed run as success", () => {
    expect(breakerOutcomeFor("completed")).toBe("success");
  });

  it("counts settlement and reconcile failures as lane failures", () => {
    const codes: CorridorErrorCode[] = [
      "SETTLEMENT_FAILED",
      "SETTLEMENT_TIMEOUT",
      "RECONCILE_MISMATCH",
      "RECONCILE_STALLED",
    ];
    for (const code of codes) {
      expect(breakerOutcomeFor("failed", code)).toBe("failure");
      expect(breakerOutcomeFor("held", code)).toBe("failure");
      expect(breakerOutcomeFor("refunded", code)).toBe("failure");
    }
  });

  it("counts the pre-settle checks that read the chain as lane failures", () => {
    // These are checked against the chain and the anchor, so a refusal says
    // something about the lane and not only about this request.
    const codes: CorridorErrorCode[] = [
      "PRESETTLE_INSUFFICIENT_FUNDS",
      "PRESETTLE_ANCHOR_DRIFT",
      "PRESETTLE_TX_MISMATCH",
      "PRESETTLE_DESTINATION_UNSAFE",
    ];
    for (const code of codes) {
      expect(breakerOutcomeFor("failed", code)).toBe("failure");
    }
  });

  it("does NOT count pre-settle refusals that are about the request", () => {
    // The counter-case, and the reason pre-settle codes are listed one by one
    // instead of matched on the `PRESETTLE_` prefix. A stale quote, an amount
    // the anchor will not take and a receiver whose SEP-12 status lapsed are all
    // true on a lane that is working perfectly well. If these counted, ordinary
    // payment errors would halt a healthy corridor and a human would have to
    // reopen it. Upstream added exactly these codes in #317/#358; a prefix test
    // would have silently turned all three into new ways to take a lane down.
    const codes: CorridorErrorCode[] = [
      "PRESETTLE_QUOTE_WINDOW",
      "PRESETTLE_AMOUNT_OUT_OF_RANGE",
      "PRESETTLE_RECEIVER_NOT_ACCEPTED",
      "CORRIDOR_UNPROVEN",
    ];
    for (const code of codes) {
      expect(breakerOutcomeFor("failed", code)).toBe("neutral");
    }
  });

  it("does NOT count quote, KYC or pre-open failures", () => {
    // A rejected KYC is one customer. Tripping the breaker on it would take a
    // working lane offline because of a single bad applicant.
    const codes: CorridorErrorCode[] = [
      "KYC_REJECTED",
      "KYC_REQUIRED",
      "QUOTE_UNAVAILABLE",
      "QUOTE_EXPIRED",
      "ANCHOR_UNAVAILABLE",
      "MANIFEST_INVALID",
      "AMOUNT_INVALID",
      "IDEMPOTENCY_CONFLICT",
    ];
    for (const code of codes) {
      expect(breakerOutcomeFor("failed", code)).toBe("neutral");
    }
  });

  it("does NOT count REFUND_UNSUPPORTED", () => {
    // The refund port refusing is a design invariant (on-chain payments are
    // final), not an outage — docs/operations.md §2 says as much. Every
    // corridor that has ever parked a payment would otherwise halt.
    expect(breakerOutcomeFor("held", "REFUND_UNSUPPORTED")).toBe("neutral");
  });

  it("treats an unknown cause as neutral rather than guessing", () => {
    // Fail closed on the *counting*: a code this build does not know about must
    // not be allowed to halt a lane on a guess.
    expect(breakerOutcomeFor("failed", undefined)).toBe("neutral");
    expect(breakerOutcomeFor("held", undefined)).toBe("neutral");
  });

  it("ignores non-terminal states", () => {
    for (const s of ["created", "settling", "settled", "reconciled", "recovering"] as const) {
      expect(breakerOutcomeFor(s, "SETTLEMENT_FAILED")).toBe("neutral");
    }
  });
});

describe("InMemoryCorridorHealthStore", () => {
  it("stays closed until the threshold, then trips", async () => {
    const s = new InMemoryCorridorHealthStore();
    const opts = { threshold: 3 };
    const a = await s.recordOutcome("c", "failure", 1000, opts);
    expect(a).toMatchObject({ state: "closed", consecutiveFailures: 1 });
    const b = await s.recordOutcome("c", "failure", 2000, opts);
    expect(b).toMatchObject({ state: "closed", consecutiveFailures: 2 });
    // K-1 failures still run; the Kth is the one that trips.
    const c = await s.recordOutcome("c", "failure", 3000, opts);
    expect(c).toMatchObject({ state: "open", consecutiveFailures: 3, trippedAt: 3000 });
  });

  it("clears the count on a success, so the breaker counts CONSECUTIVE failures", async () => {
    const s = new InMemoryCorridorHealthStore();
    const opts = { threshold: 3 };
    await s.recordOutcome("c", "failure", 1000, opts);
    await s.recordOutcome("c", "failure", 2000, opts);
    await s.recordOutcome("c", "success", 3000, opts);
    const after = await s.recordOutcome("c", "failure", 4000, opts);
    // Two failures, a success, one failure: nowhere near the threshold.
    expect(after).toMatchObject({ state: "closed", consecutiveFailures: 1 });
  });

  it("is sticky: more failures on an open lane do not re-trip it", async () => {
    const s = new InMemoryCorridorHealthStore();
    const opts = { threshold: 1 };
    const first = await s.recordOutcome("c", "failure", 1000, opts);
    expect(justTripped(first, 1000)).toBe(true);
    const second = await s.recordOutcome("c", "failure", 2000, opts);
    // Already open, so `tripped_at` keeps its original stamp: a trip is one
    // event and the metric fires once, not once per failure.
    expect(justTripped(second, 2000)).toBe(false);
    expect(second.trippedAt).toBe(1000);
  });

  it("is per corridor: tripping one leaves another open for business", async () => {
    const s = new InMemoryCorridorHealthStore();
    await s.recordOutcome("a", "failure", 1000, { threshold: 1 });
    expect((await s.get("a"))?.state).toBe("open");
    expect(await s.get("b")).toBeUndefined();
    await s.recordOutcome("b", "failure", 1000, { threshold: 5 });
    expect((await s.get("b"))?.state).toBe("closed");
  });

  it("reset() closes the lane and records who did it and why", async () => {
    const s = new InMemoryCorridorHealthStore();
    await s.recordOutcome("c", "failure", 1000, { threshold: 1 });
    const after = await s.reset("c", "ezedike", "anchor confirmed healthy", 5000);
    expect(after).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      resetBy: "ezedike",
      resetReason: "anchor confirmed healthy",
      resetAt: 5000,
    });
    // The old trip time is cleared: a lane that is running again must not render
    // as "open since last Tuesday".
    expect(after.trippedAt).toBeUndefined();
  });

  it("reset() on a lane that never failed is not an error", async () => {
    const s = new InMemoryCorridorHealthStore();
    await expect(s.reset("c", "ezedike", "fixed by hand")).resolves.toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("list() returns every lane with a row", async () => {
    const s = new InMemoryCorridorHealthStore();
    await s.recordOutcome("b", "failure", 1000, { threshold: 3 });
    await s.recordOutcome("a", "failure", 1000, { threshold: 3 });
    expect((await s.list()).map((r) => r.corridorId).sort()).toEqual(["a", "b"]);
  });
});

describe("execute() breaker gate", () => {
  it("refuses a new run once the lane is halted, and leaves no run row", async () => {
    const health = new InMemoryCorridorHealthStore();
    const store = new InMemoryIdempotencyStore();
    const d = { ...deps(health), idempotency: store };

    // Threshold 1, and this run's settle leg fails, so the very next run is
    // refused.
    const c = corridor("test", 1);
    const first = await execute(intent("run-1"), c, d);
    expect(first.ok).toBe(false);
    expect((await health.get("test"))?.state).toBe("open");

    const second = await execute(intent("run-2"), c, d);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CORRIDOR_HALTED");
      // The message must say how to get out of it, not just that it is stuck.
      expect(second.error.message).toContain("corridor breaker reset test --reason");
    }
    // No run row for the refused attempt: nothing to reconcile, and the caller
    // can reuse the same idempotency key once the lane is reset.
    expect(await store.get("run-2")).toBeUndefined();
  });

  it("does not count a KYC failure, so a lane stays open for business", async () => {
    const health = new InMemoryCorridorHealthStore();
    const d: EngineDeps = {
      ...deps(health),
      resolver: new StaticRouteResolver(() => createMockAdapter({ kyc: "rejected" }), {
        trustManifestWithoutAttestation: true,
      }),
    };
    // Threshold 1: one failure is enough to trip IF the failure counted.
    for (const key of ["k1", "k2", "k3"]) {
      const r = await execute(intent(key), corridor("test", 1), d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("KYC_REJECTED");
    }
    // No row at all: a rejected applicant is not a fact about the lane.
    expect(await health.get("test")).toBeUndefined();
  });

  it("still resumes a run whose money already left, even on a halted lane", async () => {
    // The gate is on NEW work. Blocking a resume would strand a payment that
    // reached `settled` behind the very mechanism meant to protect the lane.
    const health = new InMemoryCorridorHealthStore();
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "resume-1",
      corridorId: "test",
      state: "settled",
      version: 5,
      transactionId: "tx_crashed",
      stellarTxHash: "mocktx0001",
    });
    // Halt the lane out of band, as a series of live failures would have.
    await health.recordOutcome("test", "failure", 1000, { threshold: 1 });

    const d: EngineDeps = {
      ...deps(health),
      idempotency: store,
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
    };
    const r = await execute(intent("resume-1"), corridor("test", 1), d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.state).toBe("completed");
  });

  it("reopens after a reset, and the reused idempotency key then runs", async () => {
    const health = new InMemoryCorridorHealthStore();
    const d = deps(health);
    const c = corridor("test", 1);
    await execute(intent("run-1"), c, d);
    expect((await execute(intent("run-2"), c, d)).ok).toBe(false);

    await health.reset("test", "ezedike", "anchor restored", 9000);
    const third = await execute(intent("run-2"), c, d);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      // Same key, but the lane is taking work again: this is a real settlement
      // failure now, not CORRIDOR_HALTED.
      expect(third.error.code).toBe("SETTLEMENT_FAILED");
    }
  });

  it("trips only after K consecutive failures, not on the first", async () => {
    const health = new InMemoryCorridorHealthStore();
    const d = deps(health);
    const c = corridor("test", 3);
    for (const key of ["f1", "f2"]) {
      const r = await execute(intent(key), c, d);
      expect(r.ok).toBe(false);
      // Ran: it failed on its own merits, not because the lane was halted.
      if (!r.ok) expect(r.error.code).toBe("SETTLEMENT_FAILED");
    }
    expect((await health.get("test"))?.state).toBe("closed");
    await execute(intent("f3"), c, d);
    expect((await health.get("test"))?.state).toBe("open");
  });

  it("leaves the breaker absent (and the engine unchanged) with no health store", async () => {
    // Opt-in like every other store: not wiring one must not change a run.
    const d = deps(new InMemoryCorridorHealthStore());
    const r = await execute(intent("run-1"), corridor("test", 1), { ...d, health: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SETTLEMENT_FAILED");
  });
});
