// The five verbs. Each is a small, testable function over the AnchorAdapter /
// SettlementSubmitter ports. run.ts sequences them and drives the state machine.
// In a larger codebase each of these becomes its own folder; one file is the
// right size while there's a single corridor exercising them.

import type { Corridor } from "@corridor/manifest";
import {
  fail,
  ok,
  type Outcome,
  type PaymentIntent,
  isSettleableAmount,
  STROS_SCALE,
} from "@corridor/types";
import type {
  AnchorAdapter,
  QuoteProvider,
  KycResult,
  OpenTransaction,
  Quote,
  TransactionStatus,
} from "@corridor/adapter-kit";
import type { SettlementRef, SettlementRequest, SettlementStrategy } from "./ports";
import type { Logger, Metrics } from "./observability";

// 1. QUOTE — SEP-38. Get a price and verify the firm-quote window hasn't already
//    closed. who_holds_risk in the manifest records who eats slippage if it does.
export async function quote(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  corridor: Corridor,
  now: number,
  provider?: QuoteProvider,
): Promise<Outcome<Quote>> {
  const q = provider
    ? await provider.quote(intent, corridor)
    : await adapter.requestQuote(intent, corridor);
  if (!q.ok) return q;
  if (q.value.firm && q.value.expiresAt <= now) {
    return fail("QUOTE_EXPIRED", `quote ${q.value.id} expired before use`, {
      retryable: true,
    });
  }
  return q;
}

// 2. COMPLY — SEP-10 auth + KYC handoff. Reject hard on rejection.
//    The compliance method is selected by the corridor manifest:
//    - "sep12"       SEP-12 GET /customer via the adapter (default)
//    - "sep6_fields"  SEP-6 KYC fields inline on the transfer request
//    - "bespoke"      anchor-specific onboarding, out-of-band
//    - "none"         no KYC handoff
export async function comply(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  corridor: Corridor,
): Promise<Outcome<KycResult>> {
  // A corridor whose compliance method is "none" has no KYC handoff to perform.
  // Return an accepted result so the engine proceeds without a customer reference.
  if (corridor.compliance?.method === "none") {
    return ok({ status: "accepted" } as KycResult);
  }
  // "bespoke" anchors onboard out-of-band; the engine cannot perform their KYC.
  // Fail closed unless the intent already carries an anchor-issued customer ref.
  if (corridor.compliance?.method === "bespoke") {
    const ref = intent.party?.anchorCustomerId ?? intent.party?.sep12Id;
    if (!ref) {
      return fail("KYC_REQUIRED", "bespoke compliance requires an anchor customer reference");
    }
    return ok({ status: "accepted" } as KycResult);
  }
  // "sep6_fields" and "sep12" both route through the adapter's ensureCompliance.
  // The SEP-6 adapter reuses the shared SEP-12 status check from adapter-kit.
  const c = await adapter.ensureCompliance(intent, corridor);
  if (!c.ok) return c;
  if (c.value.status === "rejected") {
    return fail("KYC_REJECTED", "receiving anchor rejected the customer");
  }
  if (c.value.status === "pending") {
    return fail("KYC_REQUIRED", "KYC pending at receiving anchor", { retryable: true });
  }
  return c;
}

// 3a. OPEN — SEP-31 POST /transactions. Get the deposit address + memo.
export async function open(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  q: Quote,
  corridor: Corridor,
): Promise<Outcome<OpenTransaction>> {
  return adapter.openTransaction(intent, q, corridor);
}

/**
 * The exact settlement request `settle()` submits, factored out (#148) so the
 * `anchor.tx.match` gate check verifies the very request that will be built —
 * not a parallel reconstruction that could drift from it.
 */
export function buildSettlementRequest(
  opened: OpenTransaction,
  q: Quote,
  corridor: Corridor,
): SettlementRequest {
  return {
    to: opened.depositAddress,
    memo: opened.memo,
    memoType: opened.memoType,
    amount: { asset: corridor.settlement.bridge_asset, amount: q.sourceAmount.amount },
    corridor,
    validUntil: q.firm ? r.expiresAt : undefined,
  };
}

/**
 * Why a quote must NOT be settled as-is, or null when it can be. `Quote.sourceAmount.asset` is the intent's
 * asset, while the on-chain leg pays the corridor's bridge asset: that relabel is only legitimate when the two
 * are the same asset, and the amount has to be exactly representable at 7 decimal places (stroops).
 */
export function settleQuoteProblem(q: Quote, corridor: Corridor): string | null {
  const bridge = corridor.settlement.bridge_asset;
  const sellAsset = q.sourceAmount.asset;
  const isMatch =
    sellAsset === bridge ||
    sellAsset === `stellar:${bridge}:${corridor.settlement.asset_issuer}` ||
    (bridge.toUpperCase() === "XLM" &&
      (sellAsset === "native" || sellAsset === "stellar:native"));
  if (!isMatch) {
    return `quote source asset "${sellAsset}" does not match settlement bridge asset "${bridge}"`;
  }
  if (!isSettleableAmount(q.sourceAmount.amount, STROS_SCALE)) {
    return `settle amount "${q.sourceAmount.amount}" is not a valid settleable amount at ${STROP_SCALE} decimal places`;
  }
  return null;
}

// 3b. SETTLE — the native on-chain payment of the bridge asset to the anchor.
//     Dispatches to the first strategy whose `kind` matches the deposit
//     instructions kind on the opened transaction. Today only "stellar_payment"
//     is issued by the adapters, so the dispatch always routes to
//     StellarPaymentStrategy. When issue #183 lands and adapters return
//     additional kinds, add a strategy — no engine changes required.
//
//     Unknown kind → non-retryable SETTLEMENT_FAILED so no money moves on an
//     unhandled path.
export async function settle(
  strategies: readonly SettlementStrategy[],
  opened: OpenTransaction,
  q: Quote,
  corridor: Corridor,
): Promise<Outcome<SettlementRef>> {
  // Refuse before anything is submitted: never relabel an asset or round an amount silently.
  const problem = settleQuoteProblem(q, corridor);
  if (problem) return fail("AMOUNT_INVALID", problem);
  // The current OpenTransaction shape has a flat depositAddress field (pre-#183).
  // We resolve the kind conservatively: if the adapter sets it explicitly we
  // respect it; otherwise we assume stellar_payment (the only kind today).
  const kind = (opened as { kind?: string }).kind ?? "stellar_payment";
  const strategy = strategies.find((s) => s.kind === kind);
  if (!strategy) {
    return fail(
      "SETTLEMENT_FAILED",
      `no settlement strategy registered for kind "${kind}" — add a SettlementStrategy with kind="${kind}" to EngineDeps.strategies`,
      { retryable: false },
    );
  }
  return strategy.settle({ opened, quote: q, corridor });
}

// 4. RECONCILE — match the on-chain leg against the anchor's view of the payout.
//    A single status check (kept for tests / direct use).
export async function reconcile(
  adapter: AnchorAdapter,
  transactionId: string,
): Promise<Outcome<TransactionStatus>> {
  const s = await adapter.getTransaction(transactionId);
  if (!s.ok) return s;
  if (!s.value.settled) {
    return fail(
      "RECONCILE_MISMATCH",
      `tx ${transactionId} not settled (status=${s.value.status})`,
      { retryable: true },
    );
  }
  return s;
}

export interface PollOptions {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Absolute epoch-ms after which we stop polling and time out. */
  deadlineMs: number;
  /** Delay between polls. */
  pollMs: number;
  /**
   * Number of consecutive polls returning the same status before we conclude
   * the anchor is stuck rather than legitimately slow. External phases use
   * `externalStallMs` instead. Once crossed,
   * `reconcileUntil` returns a non-retryable `RECONCILE_STALLED` carrying the
   * stuck status and the consecutive count.
   *
   * Omitted or `0` disables stall detection at this layer: `reconcileUntil`
   * reads `opts.stallThreshold ?? 0` (legacy behaviour).
   *
   * **Default here:** none (disabled). `execute()` in `run.ts` applies
   * `deps.stallThreshold ?? 10` and passes it down, so the production default
   * is `10`. With a typical `pollMs` of 2 s that is ≈ 20 s — well below the
   * corridor timeout but long enough that a legitimately slowanchor
   * transitioning through intermediate states won't be misdiagnosed.
   */
  stallThreshold?: number;
  /** Signal to cut the sleep short and poll immediately. */
  wake?: {
    readonly aborted: boolean;
    addEventListener(type: "abort", cb: () => void): void;
    removeEventListener(type: "abort", cb: () => void): void;
    reset?(): void;
  };
  /** Maximum elapsed time in an external phase before declaring a stall. */
  externalStallMs?: number;
  /** Corridor ID for metric tagging. Optional. */
  corridorId?: string;
  /** Logger for per-poll debug logs. Optional. */
  logger?: Logger;
  /** Metrics sink for per-poll counter. Optional. */
  metrics?: Metrics;
}

// 4'. RECONCILE (production) — poll the anchor until the payout settles or the
//     corridor's timeout elapses. Returns a NON-retryable error on timeout so the
//     engine routes straight to refund/hold instead of re-sending the payment.
//
//     Stall detection: when `stallThreshold` is set and the anchor returns the
//     same status for that many consecutive polls, we bail early with
//     `RECONCILE_STALLED` — the anchor is stuck, not slow. This lets the engine
//     recover (refund/hold) long before the corridor deadline expires.
export async function reconcileUntil(
  adapter: AnchorAdapter,
  transactionId: string,
  opts: PollOptions,
): Promise<Outcome<TransactionStatus>> {
  let firstStatus: string | undefined;
  let lastStatus = "unknown";
  let sameCount = 0;
  // Omitted or 0 disables stall detection at this layer; execute() applies the
  // production default of 10 one level up (run.ts) and passes it down.
  const threshold = opts.stallThreshold ?? 0;
  const externalStallMs = opts.externalStallMs ?? 6 * 60 * 60 * 1000;
  let poll = 0;
  const startedAt = opts.now();
  let lastAwaitingInput = false;
  let lastPhase: TransactionStatus["phase"];
  let externalStartedAt: number | undefined;
  let nextPollMs = opts.pollMs;
  for (;;) {
    poll += 1;
    const s = await adapter.getTransaction(transactionId);
    const rawStatus = s.ok ? s.value.status : "error";
    const elapsedMs = opts.now() - startedAt;

    opts.logger?.log("debug", "corridor.reconcile.poll", {
      transactionId,
      status: rawStatus,
      poll,
      elapsedMs,
    });

    opts.metrics?.increment("corridor.reconcile.poll", {
      ...(opts.corridorId ? { corridor: opts.corridorId } : {}),
      status: rawStatus,
    });

    // Recorded before the settled/terminal returns so `firstStatus` sees the
    // very first thing the anchor said, which is what makes an identical
    // first/last pair readable as a stalled observer.
    if (s.ok) {
      if (firstStatus === undefined) firstStatus = s.value.status;
      const statusChanged = s.value.status !== lastStatus;
      // A status identical to the previous poll's is what a stuck observer
      // looks like; any change resets the run of sameness.
      sameCount = s.value.status === lastStatus ? sameCount + 1 : 0;
      lastStatus = s.value.status;
      lastAwaitingInput = s.value.awaitingInput === true;
      lastPhase = s.value.phase;
      if (lastPhase === "external") {
        if (externalStartedAt === undefined) externalStartedAt = opts.now();
        if (statusChanged) nextPollMs = opts.pollMs;
      } else {
        externalStartedAt = undefined;
        nextPollMs = opts.pollMs;
      }
    }
    if (s.ok && s.value.settled) return s;
    // A terminal non-success at the anchor (error/expired/refunded): stop polling
    // now and let the engine recover, rather than waiting out the timeout. Non-
    // retryable so we never re-settle a payment that already terminally failed.
    if (s.ok && s.value.terminalFailure) {
      return fail(
        "RECONCILE_MISMATCH",
        `tx ${transactionId} terminally failed (status=${s.value.status})`,
        { retryable: false },
      );
    }
    // Awaiting on user input is not a stall — the anchor is waiting on us, not vice
    // versa. Reset the same-status run so we don't declare a stall against it.
    if (lastAwaitingInput) {
      sameCount = 0;
    } else if (threshold > 0 && sameCount >= threshold) {
      return fail(
        "RECONCILE_STALLED",
        `tx ${transactionId} stuck at status="${lastStatus}" for ${sameCount} polls`,
        { retryable: false },
      );
    }
    // External phases have their own (longer) stall budget.
    if (lastPhase === "external" && externalStartedAt !== undefined) {
      if (opts.now() - externalStartedAt >= externalStallMs) {
        return fail(
          "RECONCILE_STALLED",
          `tx ${transactionId} stuck in external phase at status="${lastStatus}"`,
          { retryable: false },
        );
      }
    }
    // Deadline: stop polling and let the engine recover. Non-retryable so we
    // never re-settle a payment that may still land.
    if (opts.now() >= opts.deadlineMs) {
      return fail(
        "RECONCILE_TIMED_OUT",
        `tx ${transactionId} did not settle before deadline (last status=${lastStatus})`,
        { retryable: false },
      );
    }
    await opts.sleep(nextPollMs);
  }
}
