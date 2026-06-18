import { describe, expect, it } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { StellarSep10Signer, StellarSettlementSubmitter } from "@corridor/stellar";
import type { RefundRequest } from "@corridor/engine";

describe("StellarSep10Signer", () => {
  it("signs a challenge transaction and exposes its account", async () => {
    const kp = Keypair.random();
    const challenge = new TransactionBuilder(new Account(kp.publicKey(), "0"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: "1" }),
      )
      .setTimeout(300)
      .build();

    const signer = new StellarSep10Signer(kp);
    expect(signer.account).toBe(kp.publicKey());

    const signedXdr = await signer.signChallenge(challenge.toXDR(), Networks.TESTNET);
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    expect(signed.signatures.length).toBe(1);
  });
});

describe("StellarSettlementSubmitter", () => {
  it("refuses to reverse a settled payment on-chain (escalates to manual)", async () => {
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "https://horizon-testnet.stellar.org",
    });
    const req = {
      original: { stellarTxHash: "deadbeef" },
      amount: { asset: "USDC", amount: "1" },
      reason: "test",
    } as unknown as RefundRequest;

    const r = await sub.refund(req);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_FAILED");
      expect(r.error.retryable).toBe(false);
    }
  });
});
