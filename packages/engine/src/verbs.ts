// The five verbs. Each is a small, testable function over the AnchorAdapter /
// SettlementSubmitter ports. run.ts sequences them and drives the state machine.
// In a larger codebase each of these becomes its own folder; one file is the
// right size while there's a single corridor exercising them.

import type { Corridor } from "@corridor/manifest";
import { fail, ok, type Outcome, type PaymentIntent } from "@corridor/types";
import type {
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  TransactionStatus,
} from "@corridor/adapter-kit";
import type { SettlementRef, SettlementRequest, SettlementSubmitter } from "./ports";

// 1. QUOTE — SEP-38. Get a price and verify the firm-quote window hasn't already
//    closed. who_holds_risk in the manifest records who eats slippage if it does.
export async function quote(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  corridor: Corridor,
  now: number,
): Promise<Outcome<Quote>> {
  const q = await adapter.requestQuote(intent, corridor);
  if (!q.ok) return q;
  if (q.value.firm && q.value.expiresAt <= now) {
    return fail("QUOTE_EXPIRED", `quote ${q.value.id} expired before use`, {
      retryable: true,
    });
  }
  return q;
}

// 2. COMPLY — SEP-10 auth + SEP-12 KYC handoff. Reject hard on rejection.
export async function comply(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  corridor: Corridor,
): Promise<Outcome<KycResult>> {
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

// 3b. SETTLE — the native on-chain payment of the bridge asset to the anchor.
export async function settle(
  submitter: SettlementSubmitter,
  opened: OpenTransaction,
  q: Quote,
  corridor: Corridor,
): Promise<Outcome<SettlementRef>> {
  const req: SettlementRequest = {
    to: opened.depositAddress,
    memo: opened.memo,
    amount: { asset: corridor.settlement.bridge_asset, amount: q.sourceAmount.amount },
    corridor,
  };
  return submitter.submit(req);
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
}

// 4'. RECONCILE (production) — poll the anchor until the payout settles or the
//     corridor's timeout elapses. Returns a NON-retryable error on timeout so the
//     engine routes straight to refund/hold instead of re-sending the payment.
export async function reconcileUntil(
  adapter: AnchorAdapter,
  transactionId: string,
  opts: PollOptions,
): Promise<Outcome<TransactionStatus>> {
  let lastStatus = "unknown";
  for (;;) {
    const s = await adapter.getTransaction(transactionId);
    if (s.ok && s.value.settled) return s;
    // A terminal non-success at the anchor (error/expired/refunded): stop polling
    // now and let the engine recover, rather than waiting out the timeout. Non-
    // retryable so we never re-settle a payment that already terminally failed.
    if (s.ok && s.value.terminalFailure) {
      return fail(
        "RECONCILE_MISMATCH",
        `tx ${transactionId} terminally failed at anchor (status=${s.value.status})`,
        { retryable: false },
      );
    }
    if (s.ok) lastStatus = s.value.status;
    if (opts.now() >= opts.deadlineMs) {
      // On a transient anchor error, surface it; otherwise it's a settle timeout.
      if (!s.ok) return s;
      return fail(
        "SETTLEMENT_TIMEOUT",
        `tx ${transactionId} did not settle before timeout (last status=${lastStatus})`,
        { retryable: false },
      );
    }
    await opts.sleep(opts.pollMs);
  }
}

/** Exponential backoff with a cap, used between settlement retries. */
export function backoffMs(attempt: number, baseMs = 250, capMs = 5_000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, capMs);
}

// 5. RECOVER — decide what to do with a failed step, per the manifest policy.
export type RecoveryAction =
  | { kind: "retry"; attempt: number }
  | { kind: "refund" }
  | { kind: "hold" }
  | { kind: "give_up" };

export function recover(
  corridor: Corridor,
  retryable: boolean,
  attempt: number,
): RecoveryAction {
  if (retryable && attempt < corridor.recovery.max_retries) {
    return { kind: "retry", attempt: attempt + 1 };
  }
  switch (corridor.recovery.rollback) {
    case "refund_sender":
      return { kind: "refund" };
    case "hold":
      return { kind: "hold" };
    case "manual":
    default:
      return { kind: "give_up" };
  }
}

export { ok };
