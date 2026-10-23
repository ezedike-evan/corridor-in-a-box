// @corridor/adapter-kit — the seam between the engine and any anchor.
//
// The engine knows ONLY this interface. It never knows whether the thing on the
// other side is Anclap, Bitso, a testnet reference server, or a bespoke OTC desk.
// Standards-compliant anchors are served by one generic adapter (@corridor/sep31);
// bespoke integrations implement this same interface and (in the real product)
// could be implemented separately; no private implementation is included here.

import type { Corridor } from "@corridor/manifest";
import {
  applyPrice,
  compareAmounts,
  fail,
  isValidAmount,
  ok,
  subAmounts,
  type Money,
  type Outcome,
  type PaymentIntent,
  type SettlementRef,
  settlementId,
} from "@corridor/types";

export { type SettlementRef, settlementId };
export { Sep10Client, jwtExpiryMs, type Sep10Signer } from "./sep10";

/** A SEP-38 quote. `firm` quotes carry an id + expiry and bind the deliverer to a rate. */
export interface Quote {
  readonly id: string;
  /** Dest units per 1 source unit. */
  readonly price: string;
  /** Epoch ms after which a firm quote is no longer honoured. */
  readonly expiresAt: number;
  readonly sourceAmount: Money;
  readonly destAmount: Money;
  readonly fee?: Money;
  readonly firm: boolean;
}

export interface KycResult {
  readonly status: "accepted" | "pending" | "rejected";
  readonly customerId?: string;
}

/**
 * How a corridor's KYC is performed. Shared by the manifest (`compliance.method`)
 * and by `AdapterCapabilities.kyc` so the two cannot drift apart.
 */
export type ComplianceMethod = "sep12" | "sep6_fields" | "bespoke" | "none";

/**
 * Deposit instructions returned by an anchor describing where or how to settle funds.
 * Discriminated union supporting on-chain Stellar payments, claimable balance funding,
 * and off-chain / adapter-settled transactions (#183).
 */
export type DepositInstructions =
  | {
      readonly kind: "stellar_payment";
      readonly to: string;
      readonly memo?: string;
      readonly memoType?: "text" | "hash" | "id";
      readonly asset?: string;
    }
  | {
      readonly kind: "claimable_balance";
      readonly claimant: string;
      readonly asset?: string;
      readonly predicateSeconds?: number;
    }
  | {
      readonly kind: "adapter_settled";
      readonly reference?: string;
    };

/**
 * Extract legacy flat address and memo fields from an OpenTransaction.
 * Retained for backward compatibility during transition to instructions union.
 */
export function toLegacy(tx: OpenTransaction): {
  readonly depositAddress?: string;
  readonly memo?: string;
  readonly memoType?: "text" | "hash" | "id";
} {
  if (tx.instructions && tx.instructions.kind === "stellar_payment") {
    return {
      depositAddress: tx.instructions.to,
      memo: tx.instructions.memo,
      memoType: tx.instructions.memoType,
    };
  }
  return {
    depositAddress: tx.depositAddress,
    memo: tx.memo,
    memoType: tx.memoType,
  };
}

/** Returned by the receiving anchor's SEP-31 POST /transactions — where to send the bridge asset. */
export interface OpenTransaction {
  readonly transactionId: string;
  readonly instructions: DepositInstructions;
  readonly amountIn?: Money;
  /**
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
   */
  readonly depositAddress?: string;
  /**
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
   */
  readonly memo?: string;
  /**
   * How to encode `memo` on the settlement transaction.
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
   */
  readonly memoType?: "text" | "hash" | "id";
}

/**
 * One entry of SEP-31's `refunds.payments[]` — a single movement of money back,
 * which may be one of several making up a refund.
 */
export interface RefundPayment {
  /** Stellar transaction hash, or the anchor's own external payment id. */
  readonly id: string;
  /** `stellar` for an on-chain refund, `external` for an off-chain one. */
  readonly idType?: string;
  readonly amount: Money;
  /** What the anchor kept out of this payment. */
  readonly fee: Money;
}

/**
 * What a receiving anchor reports about a refund, from the `refunds` object on
 * the SEP-31 transaction record.
 *
 * This is *news*, not a request: over SEP-31 the sending side cannot ask for a
 * refund, it can only learn one happened (see `Sep31Adapter.requestRefund`).
 * Without this, a refund was visible only as the status flipping to `refunded`
 * — correct, but it left "how much came back" unanswerable, and a partial
 * refund indistinguishable from a full one.
 *
 * Amounts are `Money`, never numbers: the amount that came back is compared
 * against the amount that went out, and doing that in float64 is exactly the
 * bug the string-based money rule exists to prevent.
 */
export interface RefundInfo {
  /** Total returned to the sender, before the anchor's refund fee. */
  readonly amountRefunded: Money;
  /** Total the anchor kept for processing the refund. */
  readonly amountFee: Money;
  /** The individual payments making up the refund; may be empty. */
  readonly payments: readonly RefundPayment[];
  /**
   * Whether the whole payment came back.
   *
   * `unknown` when the anchor did not report an amount to compare against, or
   * reported one that could not be parsed — the caller is told it does not
   * know, rather than being handed a guess. Decided with `compareAmounts`, not
   * string equality: "100" and "100.00" are the same amount of money.
   */
  readonly completeness: "full" | "partial" | "unknown";
}

/** The `refunds` object as SEP-6 / SEP-31 puts it on the wire — every field untrusted. */
export interface RawRefunds {
  amount_refunded?: unknown;
  amount_fee?: unknown;
  payments?: unknown;
}

/**
 * Parse SEP-6 / SEP-31's `refunds` object off a transaction record.
 *
 * Everything is optional and untrusted: anchors omit `refunds` entirely on the
 * happy path, amounts arrive as strings, and a malformed field must never turn
 * a poll into an error — the status classification is what the engine acts on
 * and it is decided independently of this.
 *
 * Returns undefined rather than a zero-filled object when the refund cannot be
 * read: "refunded nothing" and "said nothing" are different facts, and the
 * engine must not be able to confuse them.
 *
 * @param settledAmount the amount that went out (`amount_in`), used to tell a
 * partial refund from a full one. Compared with `compareAmounts` — "100" and
 * "100.00" are the same amount of money and string equality says otherwise.
 */
export function parseRefunds(
  refunds: unknown,
  asset: string,
  settledAmount?: string,
): RefundInfo | undefined {
  if (!refunds || typeof refunds !== "object" || Array.isArray(refunds)) return undefined;
  const raw = refunds as RawRefunds;

  const parseAmt = (v: unknown): string | undefined => {
    return typeof v === "string" && isValidAmount(v.trim()) ? v.trim() : undefined;
  };

  const amountRefunded = parseAmt(raw.amount_refunded);
  if (amountRefunded === undefined) return undefined;

  const amountFee = parseAmt(raw.amount_fee) ?? "0";

  const payments: RefundPayment[] = [];
  if (Array.isArray(raw.payments)) {
    for (const entry of raw.payments) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const p = entry as { id?: unknown; id_type?: unknown; amount?: unknown; fee?: unknown };
      const amount = parseAmt(p.amount);
      if (typeof p.id !== "string" || !p.id || amount === undefined) continue;
      payments.push({
        id: p.id,
        ...(typeof p.id_type === "string" && p.id_type ? { idType: p.id_type } : {}),
        amount: { asset, amount },
        fee: { asset, amount: parseAmt(p.fee) ?? "0" },
      });
    }
  }

  const settled = settledAmount !== undefined ? parseAmt(settledAmount) : undefined;
  let completeness: RefundInfo["completeness"] = "unknown";
  if (settled !== undefined) {
    const cmp = compareAmounts(amountRefunded, settled);
    if (cmp.ok) completeness = cmp.value < 0 ? "partial" : "full";
  }

  return {
    amountRefunded: { asset, amount: amountRefunded },
    amountFee: { asset, amount: amountFee },
    payments,
    completeness,
  };
}

export interface TransactionStatus {
  /** The raw status string reported by the anchor (e.g. a SEP-31 status). */
  readonly status: string;
  /** The subsystem currently responsible for making progress on this status. */
  readonly phase?: "anchor" | "external";
  /** The payout is confirmed complete — the engine may finish. */
  readonly settled: boolean;
  /**
   * The transaction has reached a terminal NON-success state at the anchor
   * (e.g. SEP-31 `error` / `expired` / `refunded`). When set, the engine stops
   * polling immediately and routes to its recovery policy instead of waiting out
   * the corridor timeout. Absent/false means "not settled yet, keep polling".
   */
  readonly terminalFailure?: boolean;
  /**
   * In flight, but blocked on input from outside the engine rather than on the
   * anchor doing its work (SEP-31 `incomplete`, `pending_customer_info_update`,
   * `pending_transaction_info_update`). Polling continues either way — the
   * distinction is operational: a run that times out here timed out waiting on
   * a human, not on a slow anchor. Optional and purely informational; absent
   * means "not known to be blocked".
   */
  readonly awaitingInput?: boolean;
  /**
   * Refund detail, when the anchor reported any.
   *
   * Carried on the status rather than fetched separately because it arrives on
   * the same record the poll already reads: a second call would be a second
   * chance for the two to disagree. Absent whenever the anchor omits `refunds`
   * (the happy path) or reports one that cannot be trusted — never a
   * zero-filled placeholder, which would read as "refunded nothing" rather
   * than "said nothing".
   */
  readonly refunds?: RefundInfo;
  /**
   * The anchor's own record of what it expects to receive, read back off the
   * transaction (SEP-31 `amount_in` / `amount_in_asset`, `stellar_account_id`,
   * `stellar_memo`, `stellar_memo_type`).
   *
   * These exist so a caller can cross-check the opened transaction against the
   * payment it is about to submit before any money moves. Each is independent
   * and optional: absent whenever the anchor omits it or reports something that
   * cannot be read — never a guess. An adapter that cannot see them leaves them
   * all undefined.
   */
  readonly amountIn?: Money;
  readonly depositAddress?: string;
  readonly memo?: string;
  readonly memoType?: "text" | "hash" | "id";
}

/**
 * Reference returned when a refund request is accepted for processing.
 *
 * A refund is *requested* here and *reported* on `TransactionStatus.refunds`:
 * the request is the sender's side of the conversation, the report is the
 * anchor's. They are separate types because a request can be accepted and still
 * move no money yet — `status: "pending"` is the normal outcome, and the amounts
 * only become knowable later, on the transaction record the poll already reads.
 */
export interface RefundRef {
  readonly transactionId: string;
  readonly status: "pending" | "refunded" | "rejected";
  readonly refundId?: string;
  readonly message?: string;
}

/**
 * What an adapter supports, discoverable up front instead of by failing.
 * Exposes supported quote styles, KYC mechanism, settlement kinds, refunds and callbacks.
 */
export interface AdapterCapabilities {
  readonly protocol: string;
  readonly quotes: readonly ("sep38_firm" | "sep38_indicative" | "native" | "none")[];
  readonly kyc: "sep12" | "sep6_fields" | "bespoke" | "none";
  readonly settlement: readonly DepositInstructions["kind"][];
  readonly refunds: "request" | "report_only" | "none";
  readonly callbacks: boolean;
}

/**
 * A source of quotes, independent of the receiving adapter.
 */
