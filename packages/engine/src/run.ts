// The orchestrator. execute() runs one payment across one corridor:
//   quote → comply → open → settle → reconcile → complete
// driving the state machine, persisting after each step (so it's resumable), and
// routing failures through recover(). It is corridor-AGNOSTIC: every corridor-
// specific fact arrives via the validated manifest, every anchor-specific fact via
// the injected RouteResolver/adapters. Add a corridor = add a manifest.

import { liveness, type Corridor, type LivenessState } from "@corridor/manifest";
import {
  compareAmounts,
  fail,
  isSettleableAmount,
  ok,
  type CorridorError,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import type { RouteResolver } from "@corridor/router";
import { canTransition, isTerminal, type CorridorState } from "./state";
import {
  InMemoryIdempotencyStore,
  hasRequestedRefund,
  type IdempotencyStore,
  type StoredRun,
} from "./idempotency";
import type { RefundRequest, SettlementSubmitter } from "./ports";
import { backoffMs, comply, open, quote, recover, reconcileUntil, settle } from "./verbs";
import {
  noopMetrics,
  silentLogger,
  type AuditSink,
  type Logger,
  type Metrics,
} from "./observability";

export interface EngineDeps {
  resolver: RouteResolver;
  submitter: SettlementSubmitter;
  idempotency?: IdempotencyStore;
  now?: () => number;
  /** Injectable sleep so tests don't wait on real backoff/poll delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay between reconcile polls (ms). Defaults to 2s. */
  reconcilePollMs?: number;
  /**
   * Consecutive polls with the same status before bailing with
   * `RECONCILE_STALLED`. Defaults to 10. Set to `0` to disable.
   */
  stallThreshold?: number;
  /** Structured logger. Defaults to a silent logger. */
  logger?: Logger;
  /** Append-only audit sink; receives one entry per state transition. */
  audit?: AuditSink;
  /** Counter/timing sink. Defaults to a no-op. */
  metrics?: Metrics;
  /** Maximum payment amount while a corridor has no fresh canary proof. Defaults to "10". */
  unprovenMaxAmount?: string;
  /**
   * Explicit opt-in allowing manifest-trusted routes on a public network without
   * on-chain attestation.
   */
  trustManifestWithoutAttestation?: boolean;
}

export interface RunResult {
  readonly idempotencyKey: string;
  readonly state: CorridorState;
  readonly transactionId?: string;
  readonly stellarTxHash?: string;
  /** Ordered list of states the run passed through — useful for the example/CLI. */
  readonly trail: readonly CorridorState[];
}

export interface ExecuteOptions {
  /**
   * Opaque tenant id recorded on the run so later reads can be scoped to their
   * creator. Callers must derive this from an already-VALIDATED credential (an
   * authenticated API key), never from the request body — otherwise a client
   * simply claims someone else's tenancy.
   */
  owner?: string;
  /**
   * Explicit opt-in allowing manifest-trusted routes on a public network without
   * on-chain attestation.
   */
  trustManifestWithoutAttestation?: boolean;
}

export async function execute(
  intent: PaymentIntent,
  corridor: Corridor,
  deps: EngineDeps,
  opts: ExecuteOptions = {},
): Promise<Outcome<RunResult>> {
  const store = deps.idempotency ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.reconcilePollMs ?? 2_000;
  const stallThreshold = deps.stallThreshold ?? 10;
  const externalStallMs = externalStallBudgetMs(corridor);
  const metrics = deps.metrics ?? noopMetrics;
  const startedAt = now();

  // Time a verb call and emit a `corridor.verb.<name>` histogram sample.
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const begin = now();
    const r = await fn();
    metrics.timing(`corridor.verb.${name}`, now() - begin, { corridor: corridor.id });
    return r;
  };

  // --- input guard: never let a malformed or non-positive amount reach the
  // chain. `isSettleableAmount` and not `isValidAmount`: the latter is a syntax
  // check that accepts a leading minus (subAmounts needs signed values), so it
  // happily passed "-100.00" all the way to the settlement submitter.
  if (!isSettleableAmount(intent.sourceAmount.amount)) {
    return fail(
      "AMOUNT_INVALID",
      `sourceAmount "${intent.sourceAmount.amount}" is not a positive decimal amount`,
    );
  }
  const verificationAt = now();
  const live = liveness(corridor, new Date(verificationAt));
  const unproven = live.state !== "proven";
  const canaryCap = corridor.proof?.canary_max_amount ?? deps.unprovenMaxAmount ?? "10";
  // Per-corridor ceiling. A manifest that declares max_amount caps any single
  // payment on that lane, including on a proven corridor.
  const max = corridor.limits?.max_amount;
  let effectiveCap = unproven ? canaryCap : max;
  if (unproven && max) {
    const compared = compareAmounts(max, canaryCap);
    if (!compared.ok) return compared;
    effectiveCap = compared.value <= 0 ? max : canaryCap;
  }
  await emitVerification(deps, intent, corridor, verificationAt, live.state, effectiveCap);

  if (
    corridor.settlement.network === "public" &&
    (live.state === "unverified" || live.state === "not-runnable")
  ) {
    return fail(
      "CORRIDOR_UNPROVEN",
      `corridor ${corridor.id} is ${live.state} on the public network and cannot accept payments`,
    );
  }

  if (max) {
    const cmp = compareAmounts(intent.sourceAmount.amount, max);
    if (!cmp.ok) return cmp;
    if (cmp.value > 0) {
      return fail(
        "AMOUNT_INVALID",
        `sourceAmount "${intent.sourceAmount.amount}" exceeds corridor ${corridor.id} max_amount ${max}`,
      );
    }
  }
  if (unproven && effectiveCap) {
    const cmp = compareAmounts(intent.sourceAmount.amount, effectiveCap);
    if (!cmp.ok) return cmp;
    if (cmp.value > 0) {
      return fail(
        "CORRIDOR_UNPROVEN",
        `sourceAmount "${intent.sourceAmount.amount}" exceeds corridor ${corridor.id} unproven canary cap ${effectiveCap}`,
      );
    }
  }

  // --- idempotency gate + crash resume ---------------------------------
  const existing = await store.get(intent.idempotencyKey);
  if (existing) {
    if (existing.state === "completed") {
      return ok(toResult(existing, [existing.state]));
    }
    if (!isTerminal(existing.state)) {
      return resumeRun(
        existing,
        intent,
        corridor,
        deps,
        store,
        now,
        sleep,
        pollMs,
        stallThreshold,
        opts,
      );
    }
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
    owner: opts.owner,
  };
  const trail: CorridorState[] = ["created"];

  // Atomically claim the key before doing any work. `get()` above can't be the
  // gate on its own: two concurrent callers can both see "no existing run" and
  // both proceed to settle. create() is a conditional insert — exactly one
  // caller wins the claim; the loser bails here rather than risk a duplicate
  // on-chain payment. (The put() version guard only stops the row going
  // backwards, not two runs executing.)
  if (!(await store.create(run))) {
    return fail(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey ${intent.idempotencyKey} already claimed by a concurrent run`,
    );
  }

  // --- pick the receiving anchor ---------------------------------------
  const route = await deps.resolver.resolve(intent, corridor);
  const routeTrust = route.trust;
  const adapter = route.receiving;
  const context = createRunContext(run, trail, corridor, deps, store, now, routeTrust);
  const { advance, die, finishFailure } = context;

  if (
    corridor.settlement.network === "public" &&
    route.trust === "manifest" &&
    !deps.trustManifestWithoutAttestation &&
    !opts.trustManifestWithoutAttestation
  ) {
    return die({
      code: "MANIFEST_INVALID",
      message:
        "refusing manifest route trust on public network without explicit { trustManifestWithoutAttestation: true }. Use RegistryRouteResolver for verified routing.",
      retryable: false,
    });
  }

  // --- 1. quote ---------------------------------------------------------
  const q = await timed("quote", () => quote(adapter, intent, corridor, now()));
  if (!q.ok) return die(q.error);
  run.quoteId = q.value.id;
  run.quoteExpiresAt = q.value.expiresAt;
  run.quoteFirm = q.value.firm;
  run.settlementAmount = q.value.sourceAmount.amount;
  {
    const t = await advance("quoted");
    if (!t.ok) return die(t.error);
  }

  // --- 2. comply --------------------------------------------------------
  const c = await timed("comply", () => comply(adapter, intent, corridor));
  if (!c.ok) return die(c.error);
  {
    const t = await advance("compliant");
    if (!t.ok) return die(t.error);
  }

  // --- 3a. open ---------------------------------------------------------
  const opened = await timed("open", () => open(adapter, intent, q.value, corridor));
  if (!opened.ok) return die(opened.error);
  run.transactionId = opened.value.transactionId;
  run.depositAddress = opened.value.depositAddress;
  run.memo = opened.value.memo;
  run.memoType = opened.value.memoType;
  {
    const t = await advance("opened");
    if (!t.ok) return die(t.error);
  }

  // The whole settle+reconcile phase must finish inside the corridor's timeout.
  const deadlineMs = now() + corridor.recovery.timeout_seconds * 1000;

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

    // Re-checked on every pass, not just once before the loop: quote() only
    // validates expiresAt before this loop starts, but a retry (backed off
    // between attempts) reuses the SAME q.value on every iteration. Without
    // this, a slow anchor or a couple of retries can settle at a stale firm
    // quote's price with no error. There's no "retry into a fresh quote"
    // step in this loop, so once expired there's nothing safe to retry into.
    if (q.value.firm && q.value.expiresAt <= now()) {
      return finishFailure({
        code: "QUOTE_EXPIRED",
        message: `quote ${q.value.id} expired during retry`,
        retryable: false,
      });
    }

    {
      const t = await advance("settling");
      if (!t.ok) return die(t.error);
    }

    const s = await timed("settle", () =>
      settle(deps.submitter, opened.value, q.value, corridor),
    );
    if (!s.ok) {
      const action = recover(corridor, s.error.retryable, attempt);
      if (action.kind === "retry") {
        attempt = action.attempt;
        // `retrying`, not `recovering`: this settle attempt failed BEFORE money
        // moved, so going round again is safe. `recovering` is terminal-bound
        // and cannot re-enter `settling` — see the note in state.ts.
        const back = await advance("retrying");
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
    const r = await timed("reconcile", () =>
      reconcileUntil(adapter, opened.value.transactionId, {
        now,
        sleep,
        deadlineMs,
        pollMs,
        stallThreshold,
        externalStallMs,
        corridorId: corridor.id,
        logger: deps.logger,
        metrics: deps.metrics,
      }),
    );
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
  metrics.timing("corridor.duration", now() - startedAt, { corridor: corridor.id });
  return ok(toResult(run, trail));
}

async function emitVerification(
  deps: EngineDeps,
  intent: PaymentIntent,
  corridor: Corridor,
  at: number,
  state: LivenessState,
  effectiveCap?: string,
): Promise<void> {
  const detail = { liveness: state, effectiveCap };
  const entry = {
    event: "verifying" as const,
    idempotencyKey: intent.idempotencyKey,
    corridorId: corridor.id,
    at,
    detail,
  };
  (deps.logger ?? silentLogger).log("info", "corridor.verifying", entry);
  await deps.audit?.recordDetail?.(entry);
}

type Err = { ok: false; error: CorridorError };

interface RunContext {
  advance(to: CorridorState): Promise<Outcome<void>>;
  die(error: CorridorError): Promise<Err>;
  finishFailure(error: CorridorError): Promise<Err>;
}

function createRunContext(
  run: StoredRun,
  trail: CorridorState[],
  corridor: Corridor,
  deps: EngineDeps,
  store: IdempotencyStore,
  now: () => number,
  routeTrust?: "attested" | "manifest",
): RunContext {
  const advance: RunContext["advance"] = async (to) => {
    if (!canTransition(run.state, to)) {
      return fail("SETTLEMENT_FAILED", `illegal transition ${run.state} -> ${to}`);
    }
    const from = run.state;
    run.state = to;
    run.version += 1;
    trail.push(to);
    await store.put(run);
    await emitTransition(deps, run, from, now(), undefined, routeTrust);
    return ok(undefined);
  };

  const die: RunContext["die"] = async (error) => {
    if (!canTransition(run.state, "failed")) return { ok: false, error };
    const from = run.state;
    run.lastError = `${error.code}: ${error.message}`;
    run.state = "failed";
    run.version += 1;
    trail.push("failed");
    await store.put(run);
    await emitTransition(deps, run, from, now(), run.lastError, routeTrust);
    return { ok: false, error };
  };

  const holdAndStop = async (error: CorridorError): Promise<Err> => {
    if (run.state !== "recovering" && run.state !== "refund_pending") {
      const back = await advance("recovering");
      if (!back.ok) return die(back.error);
    }
    run.lastError = `${error.code}: ${error.message}`;
    const held = await advance("held");
    if (!held.ok) return die(held.error);
    return { ok: false, error };
  };

  const refundAndStop = async (error: CorridorError): Promise<Err> => {
    if (run.state !== "recovering") {
      const back = await advance("recovering");
      if (!back.ok) return die(back.error);
    }
    if (run.stellarTxHash && !hasRequestedRefund(run)) {
      if (!run.settlementAmount) {
        return holdAndStop({
          code: "SETTLEMENT_FAILED",
          message: "cannot resume refund: stored settlement amount is missing",
          retryable: false,
        });
      }
      const req: RefundRequest = {
        original: { stellarTxHash: run.stellarTxHash },
        amount: {
          asset: corridor.settlement.bridge_asset,
          amount: run.settlementAmount,
        },
        corridor,
        reason: `${error.code}: ${error.message}`,
      };
      const refund = await deps.submitter.refund(req);
      if (!refund.ok) return holdAndStop(refund.error);
      run.refundId = refund.value.stellarTxHash;
    }
    run.lastError = `${error.code}: ${error.message}`;
    const refunded = await advance("refunded");
    if (!refunded.ok) return die(refunded.error);
    return { ok: false, error };
  };

  const finishFailure: RunContext["finishFailure"] = async (error) => {
    if (corridor.recovery.rollback === "refund_sender") return refundAndStop(error);
    if (corridor.recovery.rollback === "hold") return holdAndStop(error);
    return die(error);
  };

  return { advance, die, finishFailure };
}

function toResult(run: StoredRun, trail: readonly CorridorState[]): RunResult {
  return {
    idempotencyKey: run.idempotencyKey,
    state: run.state,
    transactionId: run.transactionId,
    stellarTxHash: run.stellarTxHash,
    trail,
  };
}

/** Log + audit a single transition. `run` must already be at its new state. */
async function emitTransition(
  deps: EngineDeps,
  run: StoredRun,
  from: CorridorState,
  at: number,
  error?: string,
  routeTrust?: "attested" | "manifest",
): Promise<void> {
  const entry = {
    idempotencyKey: run.idempotencyKey,
    corridorId: run.corridorId,
    from,
    to: run.state,
    version: run.version,
    at,
    error,
    ...(routeTrust && { routeTrust }),
  };
  (deps.logger ?? silentLogger).log(error ? "error" : "info", "corridor.transition", entry);
  const metrics = deps.metrics ?? noopMetrics;
  metrics.increment("corridor.transition", { to: run.state, corridor: run.corridorId });
  if (isTerminal(run.state)) {
    metrics.increment("corridor.terminal", { state: run.state, corridor: run.corridorId });
  }
  await deps.audit?.record(entry);
}

/**
 * Resume a persisted run only when its prior settlement can be proved or safely
 * excluded. An ambiguous `settling` miss remains an operator conflict.
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
  stallThreshold: number,
  opts: ExecuteOptions,
): Promise<Outcome<RunResult>> {
  const run: StoredRun = { ...existing };
  const trail: CorridorState[] = [run.state];
  let context = createRunContext(run, trail, corridor, deps, store, now);
  const conflict = (detail: string) =>
    fail(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey ${run.idempotencyKey} cannot resume state=${run.state}: ${detail}`,
    );

  if (run.state === "created" || run.state === "quoted" || run.state === "compliant") {
    return context.die({
      code: "IDEMPOTENCY_CONFLICT",
      message: `RESUME_STALE: run stopped in ${run.state} before opening a receiving transaction; retry with a new idempotency key`,
      retryable: false,
    });
  }

  const route = await deps.resolver.resolve(intent, corridor);
  context = createRunContext(run, trail, corridor, deps, store, now, route.trust);

  if (run.state === "opened" || run.state === "retrying" || run.state === "settling") {
    if (
      !run.transactionId ||
      !run.depositAddress ||
      !run.settlementAmount ||
      run.quoteExpiresAt === undefined ||
      run.quoteFirm === undefined
    ) {
      return conflict("persisted quote/open data is incomplete");
    }
    if (!deps.submitter.findExisting) {
      return conflict("settlement submitter does not support findExisting");
    }
    const request = {
      to: run.depositAddress,
      memo: run.memo,
      memoType: run.memoType,
      amount: { asset: corridor.settlement.bridge_asset, amount: run.settlementAmount },
      corridor,
    };
    const found = await deps.submitter.findExisting(request);
    if (!found.ok) return found;
    if (found.value) {
      run.stellarTxHash = found.value.stellarTxHash;
      const settled = await context.advance("settled");
      if (!settled.ok) return settled;
    } else if (run.state === "settling") {
      return conflict("Horizon found no matching payment, but settlement may still be in flight");
    } else {
      if (run.quoteFirm && run.quoteExpiresAt <= now()) {
        return context.die({
          code: "QUOTE_EXPIRED",
          message: `stored quote ${run.quoteId ?? "(unknown)"} expired before resumed settlement`,
          retryable: false,
        });
      }
      if (
        corridor.settlement.network === "public" &&
        route.trust === "manifest" &&
        !deps.trustManifestWithoutAttestation &&
        !opts.trustManifestWithoutAttestation
      ) {
        return context.die({
          code: "MANIFEST_INVALID",
          message: "refusing manifest route trust on public network without explicit opt-in",
          retryable: false,
        });
      }
      const compliance = await comply(route.receiving, intent, corridor);
      if (!compliance.ok) return context.die(compliance.error);
      const settling = await context.advance("settling");
      if (!settling.ok) return context.die(settling.error);
      const submitted = await deps.submitter.submit(request);
      if (!submitted.ok) return context.finishFailure(submitted.error);
      run.stellarTxHash = submitted.value.stellarTxHash;
      const settled = await context.advance("settled");
      if (!settled.ok) return context.die(settled.error);
    }
  }

  if (run.state === "settled") {
    if (!run.transactionId) return conflict("settled run has no transactionId");
    const reconciled = await reconcileUntil(route.receiving, run.transactionId, {
      now,
      sleep,
      deadlineMs: now() + corridor.recovery.timeout_seconds * 1000,
      pollMs,
      stallThreshold,
      externalStallMs: externalStallBudgetMs(corridor),
      corridorId: corridor.id,
      logger: deps.logger,
      metrics: deps.metrics,
    });
    if (!reconciled.ok) return context.finishFailure(reconciled.error);
    const advanced = await context.advance("reconciled");
    if (!advanced.ok) return advanced;
  }

  if (run.state === "reconciled") {
    const done = await context.advance("completed");
    if (!done.ok) return done;
    return ok(toResult(run, trail));
  }

  if (run.state === "recovering" || run.state === "refund_pending") {
    if (!run.transactionId) return conflict("refund recovery has no receiving transactionId");
    if (run.state === "recovering") {
      const pending = await context.advance("refund_pending");
      if (!pending.ok) return pending;
    }
    const deadlineMs = now() + corridor.recovery.timeout_seconds * 1000;
    for (;;) {
      const status = await route.receiving.getTransaction(run.transactionId);
      if (!status.ok && !status.error.retryable) return status;
      if (
        status.ok &&
        (status.value.refunds !== undefined || status.value.status.toLowerCase() === "refunded")
      ) {
        run.lastError = undefined;
        const refunded = await context.advance("refunded");
        if (!refunded.ok) return refunded;
        return fail("RECONCILE_MISMATCH", `receiving transaction ${run.transactionId} was refunded`);
      }
      if (now() >= deadlineMs) {
        const timeout = {
          code: "SETTLEMENT_TIMEOUT" as const,
          message: `refund for receiving transaction ${run.transactionId} was not confirmed before timeout`,
          retryable: false,
        };
        run.lastError = `${timeout.code}: ${timeout.message}`;
        const held = await context.advance("held");
        if (!held.ok) return held;
        return { ok: false, error: timeout };
      }
      await sleep(Math.min(pollMs, Math.max(0, deadlineMs - now())));
    }
  }

  return conflict("state is not supported by the resume handler");
}

function externalStallBudgetMs(corridor: Corridor): number {
  return (
    Math.min(
      corridor.recovery.reconcile.external_stall_seconds,
      corridor.recovery.timeout_seconds,
    ) * 1000
  );
}
