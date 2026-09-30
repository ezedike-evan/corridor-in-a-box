// Gate check: the anchor must still be expecting exactly the payment we are
// about to send (#148). `settle()` pays `opened.depositAddress` with
// `opened.memo` based solely on the POST /transactions response; nothing
// confirmed the anchor still had that transaction open, in `pending_sender`,
// for these values. Lives in @corridor/sep31 because "pending_sender" is
// SEP-31 status semantics, not engine vocabulary.

import { compareAmounts } from "@corridor/types";
import type { AnchorAdapter, TransactionStatus } from "@corridor/adapter-kit";
import {
  buildSettlementRequest,
  type CheckResult,
  type GateCheck,
  type GateContext,
} from "@corridor/engine";

const NAME = "anchor.tx.match";

/**
 * The transaction fields this check compares, as the anchor reports them on
 * GET /transactions/:id. They land on `TransactionStatus` with #147; until
 * then every field is optional here, and the check treats an absent field
 * as `unverified` rather than failing (unless `strict`). Structural on
 * purpose: when #147 adds the real fields, this alias collapses into them
 * with no change to the check.
 */
export type ReportedTransactionFields = {
  readonly amount?: string;
  readonly asset?: string;
  readonly depositAddress?: string;
  readonly memo?: string;
  readonly memoType?: string;
};

export interface OpenedTxCheckOptions {
  /** Fail when the anchor omitted a comparable field instead of recording it unverified. */
  readonly strict?: boolean;
}

/** Never log a full memo: its type plus a 6-char prefix identifies without disclosing. */
function memoForLog(memo: string | undefined, memoType: string): string {
  if (memo === undefined) return "(none)";
  return `${memoType}:${memo.slice(0, 6)}…`;
}

export function openedTxCheck(
  adapter: Pick<AnchorAdapter, "getTransaction">,
  opts: OpenedTxCheckOptions = {},
): GateCheck {
  return {
    name: NAME,
    async run(ctx: GateContext): Promise<CheckResult> {
      const start = Date.now();
      const done = (partial: Omit<CheckResult, "name" | "durationMs">): CheckResult => ({
        name: NAME,
        durationMs: Date.now() - start,
        ...partial,
      });

      const fetched = await adapter.getTransaction(ctx.opened.transactionId);
      if (!fetched.ok) {
        return done({
          passed: false,
          code: "SETTLEMENT_FAILED",
          detail: `failed to re-read transaction ${ctx.opened.transactionId}: ${fetched.error.message}`,
        });
      }
      const status: TransactionStatus & ReportedTransactionFields = fetched.value;

      if (status.status !== "pending_sender") {
        return done({
          passed: false,
          code: "PRESETTLE_TX_MISMATCH",
          detail: `status: expected pending_sender, anchor reports ${status.status}`,
        });
      }

      // The exact request settle() will submit — shared builder, so this can
      // never drift from what is actually sent.
      const expected = buildSettlementRequest(ctx.opened, ctx.quote, ctx.corridor);
      const expectedMemoType = expected.memoType ?? "text";

      const mismatches: string[] = [];
      const unverified: string[] = [];

      if (status.amount === undefined) {
        unverified.push("amount");
      } else {
        const cmp = compareAmounts(expected.amount.amount, status.amount);
        if (!cmp.ok) {
          mismatches.push(`amount: anchor reported unparseable "${status.amount}"`);
        } else if (cmp.value !== 0) {
          mismatches.push(
            `amount: we will send ${expected.amount.amount}, anchor expects ${status.amount}`,
          );
        }
      }

      if (status.asset === undefined) {
        unverified.push("asset");
      } else if (status.asset.toUpperCase() !== expected.amount.asset.toUpperCase()) {
        mismatches.push(
          `asset: we will send ${expected.amount.asset}, anchor expects ${status.asset}`,
        );
      }

      if (status.depositAddress === undefined) {
        unverified.push("depositAddress");
      } else if (status.depositAddress !== expected.to) {
        mismatches.push("depositAddress: anchor reports a different deposit account");
      }

      if (status.memo === undefined) {
        unverified.push("memo");
      } else if (status.memo !== expected.memo) {
        mismatches.push(
          `memo: we will send ${memoForLog(expected.memo, expectedMemoType)}, anchor expects ${memoForLog(status.memo, status.memoType ?? "text")}`,
        );
      }

      if (status.memoType === undefined) {
        unverified.push("memoType");
      } else if (status.memoType !== expectedMemoType) {
        mismatches.push(
          `memoType: we will send ${expectedMemoType}, anchor expects ${status.memoType}`,
        );
      }

      if (mismatches.length > 0) {
        return done({
          passed: false,
          code: "PRESETTLE_TX_MISMATCH",
          detail: mismatches.join("; "),
        });
      }
      if (opts.strict && unverified.length > 0) {
        return done({
          passed: false,
          code: "PRESETTLE_TX_MISMATCH",
          detail: `strict: anchor did not report ${unverified.join(", ")}`,
        });
      }
      return done({
        passed: true,
        detail:
          unverified.length > 0
            ? `pending_sender; matches on every reported field (unverified: ${unverified.join(", ")})`
            : "pending_sender; matches on every field",
      });
    },
  };
}
