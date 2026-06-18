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
} from "@corridor/types";
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
    return fail("QUOTE_EXPIRED", `quote ${q.value.id} expired before use`, { retryable: true });
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
//    Skeleton does a single status check; production polls until settled/timeout.
export async function reconcile(
  adapter: AnchorAdapter,
  transactionId: string,
): Promise<Outcome<TransactionStatus>> {
  const s = await adapter.getTransaction(transactionId);
  if (!s.ok) return s;
  if (!s.value.settled) {
    return fail("RECONCILE_MISMATCH", `tx ${transactionId} not settled (status=${s.value.status})`, {
      retryable: true,
    });
  }
  return s;
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
