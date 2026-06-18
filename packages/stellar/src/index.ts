// @corridor/stellar — the ONE place that touches the chain. It wraps
// @stellar/stellar-sdk to (a) sign SEP-10 challenges and (b) submit the native
// settle-leg payment. Everything else in the monorepo stays SDK-free; swap
// createMockSubmitter() for StellarSettlementSubmitter to move real money.
//
// SEP-31 settlement is a single NATIVE payment of the bridge asset to the
// receiving anchor's deposit address — no smart contract involved.

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { fail, ok, type Outcome } from "@corridor/types";
import type {
  RefundRequest,
  SettlementRef,
  SettlementRequest,
  SettlementSubmitter,
} from "@corridor/engine";
import type { Sep10Signer } from "@corridor/sep31";

function passphraseFor(network: "public" | "testnet"): string {
  return network === "public" ? Networks.PUBLIC : Networks.TESTNET;
}

/** Build the bridge asset for a corridor's settlement leg ("XLM" → native). */
function bridgeAsset(code: string, issuer: string): Asset {
  return code.toUpperCase() === "XLM" ? Asset.native() : new Asset(code, issuer);
}

/** Signs SEP-10 challenges with a Stellar keypair. Plug into Sep31Adapter. */
export class StellarSep10Signer implements Sep10Signer {
  readonly account: string;
  constructor(private readonly keypair: Keypair) {
    this.account = keypair.publicKey();
  }

  async signChallenge(challengeXdr: string, networkPassphrase: string): Promise<string> {
    const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
    tx.sign(this.keypair);
    return tx.toXDR();
  }
}

export interface StellarSubmitterOptions {
  /** Secret seed (S…) of the distribution account that holds the bridge asset. */
  signerSecret: string;
  /** Horizon endpoint, e.g. https://horizon-testnet.stellar.org */
  horizonUrl: string;
  /** How long to keep polling Horizon for confirmation. Default 30s. */
  confirmTimeoutMs?: number;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Production settlement: build → sign → submit a native payment of the bridge
 * asset to the anchor's deposit address, then confirm it on Horizon.
 *
 * Refunds: a payment already credited to a third-party anchor cannot be reversed
 * unilaterally on-chain. refund() therefore fails non-retryably, which the engine
 * escalates to a manual `held` state — the correct, safe outcome for SEP-31
 * (recovery is the anchor's SEP-31 refund flow or an operator action).
 */
export class StellarSettlementSubmitter implements SettlementSubmitter {
  private readonly keypair: Keypair;
  private readonly server: Horizon.Server;
  private readonly confirmTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: StellarSubmitterOptions) {
    this.keypair = Keypair.fromSecret(opts.signerSecret);
    this.server = new Horizon.Server(opts.horizonUrl);
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async submit(req: SettlementRequest): Promise<Outcome<SettlementRef>> {
    try {
      const { network } = req.corridor.settlement;
      const passphrase = passphraseFor(network);
      const asset = bridgeAsset(req.amount.asset, req.corridor.settlement.asset_issuer);

      const source = await this.server.loadAccount(this.keypair.publicKey());
      const builder = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(
          Operation.payment({ destination: req.to, asset, amount: req.amount.amount }),
        )
        // Beat the firm-quote expiry: the tx must hit the ledger before the quote dies.
        .setTimeout(req.corridor.fx.quote_ttl_seconds);

      if (req.memo) builder.addMemo(Memo.text(req.memo));

      const tx = builder.build();
      tx.sign(this.keypair);

      const sent = await this.server.submitTransaction(tx);
      const confirmed = await this.confirm(sent.hash);
      if (!confirmed.ok) return confirmed;
      return ok<SettlementRef>({ stellarTxHash: sent.hash, ledger: confirmed.value });
    } catch (cause) {
      return fail("SETTLEMENT_FAILED", `settlement submit failed: ${describe(cause)}`, {
        retryable: true,
        cause,
      });
    }
  }

  async refund(req: RefundRequest): Promise<Outcome<SettlementRef>> {
    return fail(
      "SETTLEMENT_FAILED",
      `payment ${req.original.stellarTxHash} cannot be reversed on-chain; ` +
        `initiate a SEP-31 anchor refund or manual recovery`,
      { retryable: false },
    );
  }

  /** Poll Horizon until the tx is in a ledger or we time out. Returns the ledger. */
  private async confirm(hash: string): Promise<Outcome<number>> {
    const deadline = this.now() + this.confirmTimeoutMs;
    for (;;) {
      try {
        const tx = await this.server.transactions().transaction(hash).call();
        if (tx.successful) return ok(tx.ledger_attr ?? tx.ledger);
        return fail("SETTLEMENT_FAILED", `tx ${hash} failed on-chain`);
      } catch {
        // not yet visible
      }
      if (this.now() >= deadline) {
        return fail("SETTLEMENT_TIMEOUT", `tx ${hash} not confirmed within timeout`, {
          retryable: true,
        });
      }
      await this.sleep(1_000);
    }
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
