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
import {
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
  type ExternalSigner,
} from "@corridor/stellar";
import type { RefundRequest } from "@corridor/engine";

function challengeXdr(kp: Keypair): string {
  return new TransactionBuilder(new Account(kp.publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: "1" }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

describe("LocalKeypairSigner", () => {
  it("produces a signature the keypair verifies", async () => {
    const kp = Keypair.random();
    const signer = new LocalKeypairSigner(kp);
    expect(signer.publicKey).toBe(kp.publicKey());
    const data = Buffer.from("0123456789abcdef0123456789abcdef"); // 32 bytes
    const sig = await signer.sign(data);
    expect(kp.verify(data, Buffer.from(sig))).toBe(true);
  });
});

describe("StellarSep10Signer", () => {
  it("signs a challenge with a raw Keypair", async () => {
    const kp = Keypair.random();
    const signer = new StellarSep10Signer(kp);
    expect(signer.account).toBe(kp.publicKey());

    const signedXdr = await signer.signChallenge(challengeXdr(kp), Networks.TESTNET);
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    expect(signed.signatures.length).toBe(1);
    // the attached signature must verify against the signer's key over the tx hash
    expect(kp.verify(signed.hash(), Buffer.from(signed.signatures[0].signature()))).toBe(true);
  });

  it("works through the ExternalSigner port (KMS-style)", async () => {
    const kp = Keypair.random();
    // A signer that only exposes publicKey + sign — no Keypair leaking through.
    const external: ExternalSigner = {
      publicKey: kp.publicKey(),
      sign: async (data) => kp.sign(Buffer.from(data)),
    };
    const signer = new StellarSep10Signer(external);
    const signedXdr = await signer.signChallenge(challengeXdr(kp), Networks.TESTNET);
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    expect(kp.verify(signed.hash(), Buffer.from(signed.signatures[0].signature()))).toBe(true);
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
