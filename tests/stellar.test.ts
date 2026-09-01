import { describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  TransactionFailedError,
} from "@stellar/stellar-sdk";
import {
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
  type ExternalSigner,
} from "@corridor/stellar";
import type { RefundRequest, SettlementRequest } from "@corridor/engine";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { Horizon } from "@stellar/stellar-sdk";

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
  // The refusal is by design, not a settlement outage: it must report under its
  // own code so paging on SETTLEMENT_FAILED doesn't fire on a design invariant.
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
      expect(r.error.code).toBe("REFUND_UNSUPPORTED");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("cannot be reversed on-chain");
    }
  });
});

// --- submit() ambiguous-failure safety ------------------------------------
// A client-side network error from submitTransaction() does not mean the
// payment failed — Horizon may have applied it anyway. Blindly retrying that
// case builds and sends an independently-valid second payment. These tests
// pin the fix: only a CONFIRMED Horizon rejection (TransactionFailedError) is
// retryable; anything else must be resolved via confirm()-by-hash before a
// retryable/non-retryable verdict is returned.

const ISSUER = Keypair.random().publicKey();

function testCorridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "testnet", asset_issuer: ISSUER },
    recovery: { max_retries: 2 },
  });
  if (!r.ok) throw new Error(`fixture invalid: ${JSON.stringify(r.error)}`);
  return r.value;
}

function testRequest(): SettlementRequest {
  return {
    to: Keypair.random().publicKey(),
    amount: { asset: "USDC", amount: "10" },
    corridor: testCorridor(),
  };
}

/** A minimal fake Horizon server: only the three methods submit() touches. */
function fakeServer(opts: {
  submitTransaction: () => Promise<unknown>;
  lookupTransaction?: (hash: string) => Promise<{ successful: boolean; ledger_attr?: number }>;
}) {
  const loadAccount = vi.fn(async (publicKey: string) => new Account(publicKey, "100"));
  const submitTransaction = vi.fn(opts.submitTransaction);
  const lookupTransaction =
    opts.lookupTransaction ??
    (async () => {
      throw new Error("not found");
    });
  return {
    loadAccount,
    submitTransaction,
    transactions: () => ({
      transaction: (hash: string) => ({ call: () => lookupTransaction(hash) }),
    }),
  } as unknown as Horizon.Server;
}

function immediateClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("StellarSettlementSubmitter.submit — ambiguous failure safety", () => {
  it("a confirmed Horizon rejection (TransactionFailedError) is retryable", async () => {
    const rejection = new TransactionFailedError("tx failed", {
      data: { extras: { result_codes: { transaction: "tx_bad_seq", operations: [] } } },
    });
    const server = fakeServer({
      submitTransaction: async () => {
        throw rejection;
      },
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
    });

    const r = await sub.submit(testRequest());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_FAILED");
      expect(r.error.retryable).toBe(true);
    }
  });

  it("an ambiguous failure whose tx actually landed resolves to ok, not a retry", async () => {
    const server = fakeServer({
      submitTransaction: async () => {
        throw new Error("ECONNRESET");
      },
      lookupTransaction: async () => ({ successful: true, ledger_attr: 4_242 }),
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
      ...immediateClock(),
    });

    const r = await sub.submit(testRequest());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ledger).toBe(4_242);
    // Exactly one on-chain submission attempt — the fix must never resubmit
    // to resolve the ambiguity, only look the original tx up by hash.
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("an ambiguous failure that never resolves is non-retryable, not blindly retried", async () => {
    const server = fakeServer({
      submitTransaction: async () => {
        throw new Error("ECONNRESET");
      },
      // tx is never found — confirm() polls until its timeout.
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
      confirmTimeoutMs: 3_000,
      ...immediateClock(),
    });

    const r = await sub.submit(testRequest());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      // The whole point of the fix: an unresolved ambiguous failure must NOT
      // be marked safe to retry, or a caller-level retry double-pays.
      expect(r.error.retryable).toBe(false);
    }
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("StellarSettlementSubmitter.submit — sequence-number serialization", () => {
  it("serializes concurrent submitTransaction calls (no two in flight together)", async () => {
    // External state, not an in-mock `expect()` — a throw inside the fake
    // would just be caught by submit()'s own try/catch and silently routed
    // into the ambiguous-failure path, hiding a real serialization bug.
    let inFlight = 0;
    let sawOverlap = false;
    const server = fakeServer({
      submitTransaction: async () => {
        inFlight++;
        if (inFlight > 1) sawOverlap = true;
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      lookupTransaction: async () => ({ successful: true, ledger_attr: 1 }),
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
    });

    const [a, b] = await Promise.all([sub.submit(testRequest()), sub.submit(testRequest())]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(server.loadAccount).toHaveBeenCalledTimes(2);
    expect(server.submitTransaction).toHaveBeenCalledTimes(2);
    expect(sawOverlap).toBe(false);
  });

  it("releases the lock right after submitTransaction, not after the confirm() poll", async () => {
    const marks: Record<string, number> = {};
    let submitCount = 0;
    let confirmCount = 0;
    const server = fakeServer({
      submitTransaction: async () => {
        submitCount++;
        marks[`submit${submitCount}`] = performance.now();
      },
      lookupTransaction: async () => {
        confirmCount++;
        const n = confirmCount;
        // Long enough that "lock held through confirm" and "lock released
        // after submitTransaction" produce clearly distinguishable timing.
        await new Promise((r) => setTimeout(r, 40));
        marks[`confirmEnd${n}`] = performance.now();
        return { successful: true, ledger_attr: 1 };
      },
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
    });

    await Promise.all([sub.submit(testRequest()), sub.submit(testRequest())]);

    // If the lock were (incorrectly) held through confirm(), the second
    // submitTransaction couldn't start until the first confirm() poll had
    // already finished — i.e. submit2 would land at or after confirmEnd1.
    // Releasing early lets submit2 start while confirm1 is still in flight.
    expect(marks.submit2).toBeLessThan(marks.confirmEnd1);
  });
});
