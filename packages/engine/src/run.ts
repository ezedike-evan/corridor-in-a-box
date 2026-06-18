// The orchestrator. execute() runs one payment across one corridor:
//   quote → comply → open → settle → reconcile → complete
// driving the state machine, persisting after each step (so it's resumable), and
// routing failures through recover(). It is corridor-AGNOSTIC: every corridor-
// specific fact arrives via the validated manifest, every anchor-specific fact via
// the injected RouteResolver/adapters. Add a corridor = add a manifest.

import type { Corridor } from "@corridor/manifest";
import {
  fail,
  isValidAmount,
  ok,
  type CorridorError,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import type { RouteResolver } from "@corridor/router";
import { canTransition, type CorridorState } from "./state";
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore,
  type StoredRun,
} from "./idempotency";
import type { RefundRequest, SettlementSubmitter } from "./ports";
import { backoffMs, comply, open, quote, recover, reconcileUntil, settle } from "./verbs";

export interface EngineDeps {
  resolver: RouteResolver;
  submitter: SettlementSubmitter;
  idempotency?: IdempotencyStore;
  now?: () => number;
  /** Injectable sleep so tests don't wait on real backoff/poll delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay between reconcile polls (ms). Defaults to 2s. */
  reconcilePollMs?: number;
}

export interface RunResult {
  readonly idempotencyKey: string;
  readonly state: CorridorState;
  readonly transactionId?: string;
  readonly stellarTxHash?: string;
  /** Ordered list of states the run passed through — useful for the example/CLI. */
  readonly trail: readonly CorridorState[];
}

export async function execute(
  intent: PaymentIntent,
  corridor: Corridor,
  deps: EngineDeps,
): Promise<Outcome<RunResult>> {
  const store = deps.idempotency ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.reconcilePollMs ?? 2_000;

  // --- input guard: never let a malformed amount reach the chain --------
  if (!isValidAmount(intent.sourceAmount.amount)) {
    return fail(
      "AMOUNT_INVALID",
      `sourceAmount "${intent.sourceAmount.amount}" is not a valid decimal amount`,
    );
  }

  // --- idempotency gate + crash resume ---------------------------------
  // A persisted run lets a crashed process pick up where it left off. We only
  // auto-resume from states where resuming is provably safe — never from a state
  // where re-running could double-settle.
  const existing = await store.get(intent.idempotencyKey);
  if (existing) {
    if (existing.state === "completed") {
      return ok(toResult(existing, [existing.state]));
    }
    if (existing.state === "settled" || existing.state === "reconciled") {
      return resumeRun(existing, intent, corridor, deps, store, now, sleep, pollMs);
    }
    // settling / created / quoted / … : ambiguous (did the payment go out?) or
    // stale (quote may have expired). Surface for a fresh attempt or ops, rather
    // than risk a duplicate payment.
    return fail(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey ${intent.idempotencyKey} already in-flight (state=${existing.state})`,
    );
  }

  const run: StoredRun = {
    idempotencyKey: intent.idempotencyKey,
    corridorId: corridor.id,
    state: "created",
    version: 0,
  };
  const trail: CorridorState[] = ["created"];

  const advance = async (to: CorridorState): Promise<Outcome<void>> => {
    if (!canTransition(run.state, to)) {
      return fail("SETTLEMENT_FAILED", `illegal transition ${run.state} -> ${to}`);
    }
    run.state = to;
    run.version += 1;
    trail.push(to);
    await store.put(run);
    return ok(undefined);
  };

  const die = async (e: CorridorError): Promise<Err> => {
    run.lastError = `${e.code}: ${e.message}`;
    run.state = "failed";
    run.version += 1;
    trail.push("failed");
    await store.put(run);
    return { ok: false, error: e };
  };

  // --- pick the receiving anchor ---------------------------------------
  const route = await deps.resolver.resolve(intent, corridor);
  const adapter = route.receiving;

  // --- 1. quote ---------------------------------------------------------
  const q = await quote(adapter, intent, corridor, now());
  if (!q.ok) return die(q.error);
  run.quoteId = q.value.id;
  {
    const t = await advance("quoted");
    if (!t.ok) return die(t.error);
  }

  // --- 2. comply --------------------------------------------------------
  const c = await comply(adapter, intent, corridor);
  if (!c.ok) return die(c.error);
  {
    const t = await advance("compliant");
    if (!t.ok) return die(t.error);
  }

  // --- 3a. open ---------------------------------------------------------
  const opened = await open(adapter, intent, q.value, corridor);
  if (!opened.ok) return die(opened.error);
  run.transactionId = opened.value.transactionId;
  {
    const t = await advance("opened");
    if (!t.ok) return die(t.error);
  }

  // The whole settle+reconcile phase must finish inside the corridor's timeout.
  const deadlineMs = now() + corridor.recovery.timeout_seconds * 1000;

  // Terminal failure handling: reverse any on-chain settlement (refund), park for
  // manual intervention (hold), or give up — per the manifest's recovery policy.
  const finishFailure = async (e: CorridorError): Promise<Err> => {
    if (corridor.recovery.rollback === "refund_sender") {
      return refundAndStop(e);
    }
    if (corridor.recovery.rollback === "hold") {
      return holdAndStop(e);
    }
    return die(e);
  };

  const refundAndStop = async (e: CorridorError): Promise<Err> => {
    const back = await advance("recovering");
    if (!back.ok) return die(back.error);
    // Only reverse the chain if a payment actually went out. If settlement never
    // succeeded, there is nothing on-chain to undo — the sending anchor returns
    // the sender's funds off-chain — so we just record the refunded state.
    if (run.stellarTxHash) {
      const req: RefundRequest = {
        original: { stellarTxHash: run.stellarTxHash },
        amount: {
          asset: corridor.settlement.bridge_asset,
          amount: q.value.sourceAmount.amount,
        },
        corridor,
        reason: `${e.code}: ${e.message}`,
      };
      const rf = await deps.submitter.refund(req);
      if (!rf.ok) {
        // Couldn't reverse the chain payment — escalate to a manual hold.
        return holdAndStop(rf.error);
      }
    }
    run.lastError = `${e.code}: ${e.message}`;
    const done = await advance("refunded");
    if (!done.ok) return die(done.error);
    return { ok: false, error: e };
  };

  const holdAndStop = async (e: CorridorError): Promise<Err> => {
    if (run.state !== "recovering") {
      const back = await advance("recovering");
      if (!back.ok) return die(back.error);
    }
    run.lastError = `${e.code}: ${e.message}`;
    const held = await advance("held");
    if (!held.ok) return die(held.error);
    return { ok: false, error: e };
  };

  // --- 3b/4. settle + reconcile, with recover() retry loop --------------
  let attempt = 0;
  for (;;) {
    if (now() >= deadlineMs) {
      return finishFailure({
        code: "SETTLEMENT_TIMEOUT",
        message: `corridor ${corridor.id} exceeded ${corridor.recovery.timeout_seconds}s`,
        retryable: false,
      });
    }

    {
      const t = await advance("settling");
      if (!t.ok) return die(t.error);
    }

    const s = await settle(deps.submitter, opened.value, q.value, corridor);
    if (!s.ok) {
      const action = recover(corridor, s.error.retryable, attempt);
      if (action.kind === "retry") {
        attempt = action.attempt;
        const back = await advance("recovering");
        if (!back.ok) return die(back.error);
        await sleep(backoffMs(attempt));
        continue;
      }
      return finishFailure(s.error);
    }
    run.stellarTxHash = s.value.stellarTxHash;
    {
      const t = await advance("settled");
      if (!t.ok) return die(t.error);
    }

    // Poll until the anchor confirms payout or we hit the corridor timeout.
    // reconcileUntil returns a non-retryable error, so we never re-settle here.
    const r = await reconcileUntil(adapter, opened.value.transactionId, {
      now,
      sleep,
      deadlineMs,
      pollMs,
    });
    if (!r.ok) return finishFailure(r.error);
    {
      const t = await advance("reconciled");
      if (!t.ok) return die(t.error);
    }
    break;
  }

  // --- 5. complete ------------------------------------------------------
  {
    const t = await advance("completed");
    if (!t.ok) return die(t.error);
  }
  return ok(toResult(run, trail));
}

type Err = { ok: false; error: CorridorError };

function toResult(run: StoredRun, trail: readonly CorridorState[]): RunResult {
  return {
    idempotencyKey: run.idempotencyKey,
    state: run.state,
    transactionId: run.transactionId,
    stellarTxHash: run.stellarTxHash,
    trail,
  };
}

/**
 * Resume a persisted run that crashed after the money moved. From `settled` we
 * re-poll the anchor (the payment already went out — we must NOT re-settle) and,
 * once confirmed, complete. From `reconciled` we just finish. A failed re-poll is
 * surfaced for ops rather than auto-refunded, since funds are already in flight.
 */
async function resumeRun(
  existing: StoredRun,
  intent: PaymentIntent,
  corridor: Corridor,
  deps: EngineDeps,
  store: IdempotencyStore,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
): Promise<Outcome<RunResult>> {
  const run: StoredRun = { ...existing };
  const trail: CorridorState[] = [run.state];

  const advance = async (to: CorridorState): Promise<Outcome<void>> => {
    if (!canTransition(run.state, to)) {
      return fail("SETTLEMENT_FAILED", `illegal resume transition ${run.state} -> ${to}`);
    }
    run.state = to;
    run.version += 1;
    trail.push(to);
    await store.put(run);
    return ok(undefined);
  };

  if (run.state === "settled") {
    if (!run.transactionId) {
      return fail(
        "RECONCILE_MISMATCH",
        `resumed run ${run.idempotencyKey} has no transactionId`,
      );
    }
    const route = await deps.resolver.resolve(intent, corridor);
    const r = await reconcileUntil(route.receiving, run.transactionId, {
      now,
      sleep,
      deadlineMs: now() + corridor.recovery.timeout_seconds * 1000,
      pollMs,
    });
    if (!r.ok) {
      run.lastError = `${r.error.code}: ${r.error.message}`;
      run.state = "failed";
      run.version += 1;
      trail.push("failed");
      await store.put(run);
      return { ok: false, error: r.error };
    }
    const t = await advance("reconciled");
    if (!t.ok) return t;
  }

  const done = await advance("completed");
  if (!done.ok) return done;
  return ok(toResult(run, trail));
}
