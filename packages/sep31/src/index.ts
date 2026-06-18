// @corridor/sep31 — ONE adapter that works for any standards-compliant SEP-31
// receiving anchor (Anclap, Bitso, the Anchor Platform testnet reference server, ...).
//
// This is the whole point of the standard: you don't write a new adapter per anchor.
// Bespoke exchanges/OTC desks that don't speak SEP-31 implement AnchorAdapter
// directly instead — those would live in the private repo, not here.
//
// The HTTP shapes below follow SEP-31 (GET /info, POST /transactions,
// GET /transactions/:id) and SEP-38 (POST /quote). SEP-10 JWT auth is stubbed —
// see authToken(). The on-chain settle leg is NOT here; that's the engine's job.

import type { AnchorConfig, Corridor } from "@corridor/manifest";
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

type FetchLike = typeof fetch;

export interface Sep31AdapterOptions {
  /** Inject a fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: FetchLike;
}

export class Sep31Adapter implements AnchorAdapter {
  readonly name: string;
  private readonly anchor: AnchorConfig;
  private readonly fetchImpl: FetchLike;

  constructor(corridor: Corridor, opts: Sep31AdapterOptions = {}) {
    this.anchor = corridor.dest;
    this.name = corridor.dest.name;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // SEP-10. Stub: a real implementation does the challenge/response handshake
  // against web_auth and caches the returned JWT until expiry.
  private async authToken(_corridor: Corridor): Promise<string | undefined> {
    // TODO(sep10): implement WEB_AUTH_ENDPOINT challenge transaction + JWT.
    return undefined;
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
      const token = await this.authToken(corridor);
      const res = await this.fetchImpl(`${b.value.sep38}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          sell_asset: `stellar:${corridor.settlement.bridge_asset}`,
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
    // TODO(sep12): PUT /customer against kyc_server with the fields the anchor's
    // GET /info advertises for this corridor, then poll GET /customer for status.
    // The sending anchor verifies once and passes identity through here.
    if (!this.anchor.endpoints.kyc_server) {
      // Some corridors deliver 1:1 with no per-customer KYC at the receiver.
      return ok<KycResult>({ status: "accepted" });
    }
    void intent;
    void corridor;
    return ok<KycResult>({ status: "accepted", customerId: "sep12-stub" });
  }

  async openTransaction(
    intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    const b = this.base(corridor);
    if (!b.ok) return b;
    try {
      const token = await this.authToken(corridor);
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
      const status = j.transaction.status;
      return ok<TransactionStatus>({
        status,
        settled: status === "completed",
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }
}
