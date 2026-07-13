// @corridor/sep31 — ONE adapter that works for any standards-compliant SEP-31
// receiving anchor (Anclap, Bitso, the Anchor Platform testnet reference server, ...).
//
// This is the whole point of the standard: you don't write a new adapter per anchor.
// Bespoke exchanges/OTC desks that don't speak SEP-31 implement AnchorAdapter
// directly instead — those would live in the private repo, not here.
//
// The HTTP shapes below follow SEP-31 (GET /info, POST /transactions,
// GET /transactions/:id), SEP-38 (POST /quote), SEP-10 (GET/POST web_auth) and
// SEP-12 (GET /customer). The crypto for SEP-10 — parsing and signing the
// challenge transaction XDR — lives behind an injected Sep10Signer so this
// adapter never has to depend on a Stellar SDK. The on-chain settle leg is NOT
// here; that's the engine's job.

import type { AnchorConfig, Corridor } from "@corridor/manifest";
import { fail, ok, type Outcome, type PaymentIntent } from "@corridor/types";
import type {
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  TransactionStatus,
} from "@corridor/adapter-kit";

type FetchLike = typeof fetch;

/**
 * Signs a SEP-10 challenge. The concrete implementation (Keypair + Transaction
 * from @stellar/stellar-sdk) is supplied by the caller, keeping this package
 * free of a chain SDK. See @corridor/stellar for a ready-made signer.
 */
export interface Sep10Signer {
  /** The Stellar account (G…) being authenticated. */
  readonly account: string;
  /** Sign the base64 challenge XDR and return the signed XDR. */
  signChallenge(challengeXdr: string, networkPassphrase: string): Promise<string>;
}

export interface Sep31AdapterOptions {
  /** Inject a fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: FetchLike;
  /** SEP-10 signer. Without it the adapter calls anchors anonymously. */
  sep10?: Sep10Signer;
}

/**
 * Classify a SEP-31 transaction status into the engine's reconcile model.
 *
 * SEP-31 defines a lifecycle of `pending_*` / `incomplete` (in flight) plus the
 * terminals `completed` (success), `refunded`, `expired`, and `error`. The engine
 * only needs three buckets:
 *   - settled         → `completed`
 *   - terminalFailure → `refunded` | `expired` | `error`  (stop polling, recover)
 *   - otherwise        → still in flight, keep polling
 * Unknown statuses are treated as in-flight (fail-open to polling, never to a
 * false "settled"). Exported so it can grow as real anchors surface new statuses.
 */
export function mapSep31Status(raw: string): {
  status: string;
  settled: boolean;
  terminalFailure: boolean;
} {
  const status = (raw ?? "").toLowerCase();
  if (status === "completed") return { status, settled: true, terminalFailure: false };
  if (status === "refunded" || status === "expired" || status === "error") {
    return { status, settled: false, terminalFailure: true };
  }
  return { status, settled: false, terminalFailure: false };
}

/**
 * SEP-38 Asset Identification Format for the corridor's bridge asset:
 * `stellar:native` for XLM, `stellar:CODE:ISSUER` for everything else. Anchors
 * reject issuer-less Stellar asset ids ("sell_asset not found").
 */
function sep38SellAsset(corridor: Corridor): string {
  const code = corridor.settlement.bridge_asset;
  return code.toUpperCase() === "XLM"
    ? "stellar:native"
    : `stellar:${code}:${corridor.settlement.asset_issuer}`;
}

/** Decode a JWT's `exp` claim (epoch ms) without verifying it. */
function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class Sep31Adapter implements AnchorAdapter {
  readonly name: string;
  private readonly anchor: AnchorConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sep10?: Sep10Signer;
  private cachedToken?: { token: string; expMs: number };

  constructor(corridor: Corridor, opts: Sep31AdapterOptions = {}) {
    this.anchor = corridor.dest;
    this.name = corridor.dest.name;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sep10 = opts.sep10;
  }

  // SEP-10 challenge/response: GET a challenge transaction, sign it, POST it back
  // for a JWT. Cached until ~30s before expiry. Returns undefined when no
  // web_auth endpoint or signer is configured (anonymous access).
  private async authToken(): Promise<string | undefined> {
    const webAuth = this.anchor.endpoints.web_auth;
    if (!webAuth || !this.sep10) return undefined;

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expMs - 30_000 > now) {
      return this.cachedToken.token;
    }

    const url = new URL(webAuth);
    url.searchParams.set("account", this.sep10.account);
    url.searchParams.set("home_domain", this.anchor.endpoints.home_domain);
    const challengeRes = await this.fetchImpl(url.toString());
    if (!challengeRes.ok) return undefined;
    const challenge = (await challengeRes.json()) as {
      transaction: string;
      network_passphrase: string;
    };

    const signed = await this.sep10.signChallenge(
      challenge.transaction,
      challenge.network_passphrase,
    );
    const tokenRes = await this.fetchImpl(webAuth, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: signed }),
    });
    if (!tokenRes.ok) return undefined;
    const { token } = (await tokenRes.json()) as { token: string };

    this.cachedToken = { token, expMs: jwtExpiryMs(token) ?? now + 15 * 60_000 };
    return token;
  }

  private base(corridor: Corridor): Outcome<{ sep31: string; sep38?: string }> {
    const sep31 = this.anchor.endpoints.transfer_server_sep31;
    if (!sep31) {
      return fail(
        "ANCHOR_UNAVAILABLE",
        `${this.name}: no SEP-31 transfer server configured for corridor ${corridor.id}`,
      );
    }
    return ok({ sep31, sep38: this.anchor.endpoints.quote_server });
  }

  async requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const b = this.base(corridor);
    if (!b.ok) return b;
    if (!b.value.sep38) {
      return fail("QUOTE_UNAVAILABLE", `${this.name}: anchor exposes no SEP-38 quote server`);
    }
    try {
      const token = await this.authToken();
      const res = await this.fetchImpl(`${b.value.sep38}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          // Required by SEP-38: the protocol the quote will be executed under.
          context: "sep31",
          sell_asset: sep38SellAsset(corridor),
          buy_asset: this.anchor.asset,
          sell_amount: intent.sourceAmount.amount,
        }),
      });
      if (!res.ok) {
        return fail("QUOTE_UNAVAILABLE", `${this.name}: quote HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as {
        id: string;
        price: string;
        expires_at: string;
        sell_amount: string;
        buy_amount: string;
      };
      return ok<Quote>({
        id: j.id,
        price: j.price,
        expiresAt: Date.parse(j.expires_at),
        sourceAmount: intent.sourceAmount,
        destAmount: { asset: this.anchor.asset, amount: j.buy_amount },
        firm: true,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: quote request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async ensureCompliance(
    intent: PaymentIntent,
    corridor: Corridor,
  ): Promise<Outcome<KycResult>> {
    const kyc = this.anchor.endpoints.kyc_server;
    if (!kyc) {
      // Some corridors deliver 1:1 with no per-customer KYC at the receiver.
      return ok<KycResult>({ status: "accepted" });
    }
    // SEP-12: check the receiving anchor's view of the customer's status. The
    // sending anchor collects/verifies PII and passes it via SEP-12; here we only
    // read status (no PII flows through the engine). NEEDS_INFO / PROCESSING are
    // surfaced as "pending" so the engine fails closed rather than settling early.
    try {
      const token = await this.authToken();
      const url = new URL(`${kyc}/customer`);
      url.searchParams.set("account", this.sep10?.account ?? intent.recipient.id);
      url.searchParams.set("type", `${corridor.compliance.dest_jurisdiction}:receiver`);
      const res = await this.fetchImpl(url.toString(), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        return fail("KYC_REQUIRED", `${this.name}: SEP-12 customer HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as { id?: string; status?: string };
      const status = (j.status ?? "").toUpperCase();
      if (status === "ACCEPTED") {
        return ok<KycResult>({ status: "accepted", customerId: j.id });
      }
      if (status === "REJECTED") {
        return ok<KycResult>({ status: "rejected", customerId: j.id });
      }
      // PROCESSING, NEEDS_INFO, or anything unknown → not yet cleared.
      return ok<KycResult>({ status: "pending", customerId: j.id });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-12 request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async openTransaction(
    intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    const b = this.base(corridor);
    if (!b.ok) return b;
    try {
      const token = await this.authToken();
      const res = await this.fetchImpl(`${b.value.sep31}/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          amount: intent.sourceAmount.amount,
          asset_code: corridor.settlement.bridge_asset,
          quote_id: quote.id,
          // receiver/sender SEP-12 ids would be attached here in a full impl
        }),
      });
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: open-tx HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as {
        id: string;
        stellar_account_id: string;
        stellar_memo?: string;
      };
      return ok<OpenTransaction>({
        transactionId: j.id,
        depositAddress: j.stellar_account_id,
        memo: j.stellar_memo,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: open-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async getTransaction(transactionId: string): Promise<Outcome<TransactionStatus>> {
    const sep31 = this.anchor.endpoints.transfer_server_sep31;
    if (!sep31) return fail("ANCHOR_UNAVAILABLE", `${this.name}: no SEP-31 server`);
    try {
      const res = await this.fetchImpl(`${sep31}/transactions/${transactionId}`);
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as { transaction: { status: string } };
      return ok<TransactionStatus>(mapSep31Status(j.transaction.status));
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }
}
