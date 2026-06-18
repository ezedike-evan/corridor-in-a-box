// The settle leg is the ONLY thing that touches the chain — and it's a native
// Stellar payment, not a smart contract. The engine depends on this port; a real
// implementation wraps @stellar/stellar-sdk to build → sign → submit a payment
// (or pathPaymentStrictSend if routing through the DEX) of the bridge asset to
// the receiving anchor's deposit address, then watches Horizon for confirmation.
//
// Keeping it behind a port means the engine skeleton type-checks and runs without
// pulling the full Stellar SDK, and the real submitter is one swap away.

import type { Corridor } from "@corridor/manifest";
import { fail, ok, type Money, type Outcome } from "@corridor/types";

export interface SettlementRef {
  readonly stellarTxHash: string;
  readonly ledger?: number;
}

export interface SettlementRequest {
  readonly to: string;
  readonly memo?: string;
  readonly amount: Money;
  readonly corridor: Corridor;
}

export interface SettlementSubmitter {
  submit(req: SettlementRequest): Promise<Outcome<SettlementRef>>;
}

/**
 * Default port. Returns a clear, actionable error pointing at the one integration
 * you owe. Replace with a StellarSubmitter built on @stellar/stellar-sdk:
 *
 *   const tx = new TransactionBuilder(source, { fee, networkPassphrase })
 *     .addOperation(Operation.payment({ destination: req.to, asset, amount: req.amount.amount }))
 *     .addMemo(req.memo ? Memo.text(req.memo) : Memo.none())
 *     .setTimeout(req.corridor.fx.quote_ttl_seconds)   // beat the firm-quote expiry
 *     .build();
 *   tx.sign(keypair);
 *   const res = await server.submitTransaction(tx);
 */
export class UnimplementedSubmitter implements SettlementSubmitter {
  async submit(): Promise<Outcome<SettlementRef>> {
    return fail(
      "SETTLEMENT_FAILED",
      "settlement not wired: implement SettlementSubmitter with @stellar/stellar-sdk (native payment to the anchor deposit address)",
    );
  }
}

/** Test/example submitter: pretends the on-chain payment succeeded. */
export function createMockSubmitter(): SettlementSubmitter {
  let n = 0;
  return {
    async submit(req) {
      void req;
      return ok<SettlementRef>({
        stellarTxHash: `mocktx${(++n).toString().padStart(60, "0")}`,
        ledger: 1_000_000 + n,
      });
    },
  };
}
