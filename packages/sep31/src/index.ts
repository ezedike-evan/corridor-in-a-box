// @corridor/sep31 — ONE adapter that works for any standards-compliant SEP-31
// receiving anchor (Anclap, Bitso, the Anchor Platform testnet reference server, ...).
//
// This is the whole point of the standard: you don't write a new adapter per anchor.
// Bespoke exchanges/OTC desks that don't speak SEP-31 implement AnchorAdapter
// directly instead — bespoke implementations are outside this generic adapter
// and could be maintained separately; no private repo is assumed to exist.
//
// The HTTP shapes below follow SEP-31 (GET /info, POST /transactions,
// GET /transactions/:id), SEP-38 (POST /quote), SEP-10 (GET/POST web_auth) and
// SEP-12 (GET /customer). The crypto for SEP-10 — parsing and signing the
// challenge transaction XDR — lives behind an injected Sep10Signer so this
// adapter never has to depend on a Stellar SDK. The on-chain settle leg is NOT
// here; that's the engine's job.

import type { Sep31Anchor, Corridor } from "@corridor/manifest";
import {
  fail,
  isValidAmount,
  ok,
  type Money,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import {
  type AdapterCapabilities,
  type AnchorAdapter,
  type DepositInstructions,
  type KycResult,
  type OpenTransaction,
  type Quote,
  type RefundRef,
  Sep38QuoteProvider,
  type TransactionStatus,
  parseRefunds,
} from "@corridor/adapter-kit";
import { Sep10Client, type Sep10Signer } from "@corridor/adapter-kit";
import type { CheckResult, GateCheck, GateContext } from "@corridor/engine";

type FetchLike = typeof fetch;

export type { RefundInfo, RefundPayment } from "@corridor/adapter-kit";
export type { Sep10Signer } from "@corridor/adapter-kit";

/**
 * Signs a SEP-10 challenge. The concrete implementation (Keypair + Transaction
 * from @stellar/stellar-sdk) is supplied by the caller, keeping this package
 * free of a chain SDK. See @corridor/stellar for a ready-made signer.
 */
export interface Sep31AdapterOptions {
  /** Inject a fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: FetchLike;
  /** SEP-10 signer. Without it the adapter calls anchors anonymously. */
  sep10?: Sep10Signer;
}

/** Terminal non-success at the anchor: stop polling, hand over to recovery. */
const TERMINAL_FAILURE_STATUSES = new Set(["refunded", "expired", "error"]);

/**
 * In flight and blocked on input from outside the engine — the anchor is not
 * working on the transfer, it is waiting for someone to supply something.
 * `incomplete` is the Anchor Platform's "the SEP-12 customer record isn't
 * complete yet"; the two `*_info_update` statuses are the anchor explicitly
 * asking for a correction via `PATCH /transactions/:id`.
 */
const AWAITING_INPUT_STATUSES = new Set([
  "incomplete",
  "pending_customer_info_update",
  "pending_transaction_info_update",
]);

/**
 * In flight with the work on the anchor's side (or the network's). Classified
 * explicitly rather than left to the default so that "we know this status and
 * it means keep waiting" is distinguishable from "we have never seen this".
 */
const IN_FLIGHT_STATUSES = new Set([
  "pending_sender",
  "pending_receiver",
  "pending_external",
  "pending_anchor",
  "pending_stellar",
]);

/**
 * Classify a SEP-31 transaction status into the engine's reconcile model.
 *
 * SEP-31 defines a lifecycle of `pending_*` / `incomplete` (in flight) plus the
 * terminals `completed` (success), `refunded`, `expired`, and `error`. The engine
 * needs these buckets:
 *   - settled         → `completed`
 *   - terminalFailure → `refunded` | `expired` | `error`  (stop polling, recover)
 *   - awaitingInput   → `incomplete` | `pending_customer_info_update` |
 *                       `pending_transaction_info_update` (in flight, but the
 *                       hold-up is someone else's input, not the anchor's work)
 *   - otherwise        → still in flight, keep polling
 * Unknown statuses are treated as in-flight (fail-open to polling, never to a
 * false "settled"). Exported so it can grow as real anchors surface new statuses.
 */
export function mapSep31Status(raw: string): {
  status: string;
  phase?: "anchor" | "external";
  settled: boolean;
  terminalFailure: boolean;
  awaitingInput: boolean;
} {
  const status = (raw ?? "").toLowerCase();
  if (status === "completed") {
    return { status, settled: true, terminalFailure: false, awaitingInput: false };
  }
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    return { status, settled: false, terminalFailure: true, awaitingInput: false };
  }
  if (AWAITING_INPUT_STATUSES.has(status)) {
    return { status, settled: false, terminalFailure: false, awaitingInput: true };
  }
  if (IN_FLIGHT_STATUSES.has(status)) {
    return {
      status,
      ...(status === "pending_external" || status === "pending_receiver"
        ? { phase: "external" as const }
        : {}),
      settled: false,
      terminalFailure: false,
      awaitingInput: false,
    };
  }
  // Unrecognised status. Same shape as a known in-flight one on purpose: the
  // default must stay fail-open to polling and never to a false "settled".
  return { status, settled: false, terminalFailure: false, awaitingInput: false };
}

export { parseRefunds };

function amountString(v: unknown): string | undefined {
  return typeof v === "string" && isValidAmount(v.trim()) ? v.trim() : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function parseMemoType(v: unknown): "text" | "hash" | "id" | undefined {
  const memoType = typeof v === "string" ? v.toLowerCase() : undefined;
  return memoType === "hash" || memoType === "id" || memoType === "text"
    ? memoType
    : undefined;
}

export { sep38SellAsset } from "@corridor/adapter-kit";

export class Sep31Adapter implements AnchorAdapter {
  readonly name: string;
  private readonly anchor: Sep31Anchor;
  /** Bridge asset for this corridor — the denomination `amount_in` is reported in. */
  private readonly settlementAsset: string;
  private readonly fetchImpl: FetchLike;
  private readonly sep10: Sep10Client;
  private readonly sep10Signer?: Sep10Signer;
  private readonly sep38Provider: Sep38QuoteProvider;

  constructor(corridor: Corridor, opts: Sep31AdapterOptions = {}) {
    if (corridor.dest.protocol !== "sep31") {
      throw new Error(
        `Sep31Adapter cannot handle protocol "${corridor.dest.protocol}"; use an adapter for that protocol`,
      );
    }
    this.anchor = corridor.dest as Sep31Anchor;
    this.settlementAsset = corridor.settlement.bridge_asset;
    this.name = corridor.dest.name;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sep10Signer = opts.sep10;
    this.sep10 = new Sep10Client(
      this.anchor.endpoints.web_auth,
      this.anchor.endpoints.home_domain,
      opts.sep10,
      this.fetchImpl,
    );
    this.sep38Provider = new Sep38QuoteProvider({
      context: "sep31",
      fetchImpl: this.fetchImpl,
      name: this.name,
      authToken: () => this.authToken(),
      quoteServer: () => this.anchor.endpoints.quote_server,
    });
  }

  // SEP-10 challenge/response: GET a challenge transaction, sign it, POST it back
  // for a JWT. Cached until ~30s before expiry.
  //
  // FAILS CLOSED. This previously returned `undefined` on every failure path and
  // callers carried on unauthenticated — so an anchor that 500'd on /auth got
  // its SEP-12 status read anonymously, and whatever it said back was treated as
  // an authenticated compliance answer. Now: if a signer is configured, a failed
  // handshake is a hard, retryable error. `ok(undefined)` means one thing only —
  // no auth was configured for this anchor, so anonymous access is intended.
  private async authToken(): Promise<Outcome<string | undefined>> {
    const auth = await this.sep10.token();
    if (!auth.ok) {
      return fail(auth.error.code, `${this.name}: ${auth.error.message}`, {
        retryable: auth.error.retryable,
        cause: auth.error.cause,
      });
    }
    return auth;
  }

  /** `Authorization` header for an authenticated call, or {} when the corridor
   *  configures no SEP-10. Propagates an auth failure to the caller. */
  private authHeader(token: string | undefined): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
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

  capabilities(): AdapterCapabilities {
    const e = this.anchor.endpoints;
    return {
      protocol: "sep31",
      quotes: e.quote_server ? ["sep38_firm"] : ["none"],
      kyc: e.kyc_server ? "sep12" : "none",
      settlement: ["stellar_payment"],
      refunds: "report_only",
      callbacks: false,
    };
  }

  async requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const b = this.base(corridor);
    if (!b.ok) return b;
    return this.sep38Provider.quote(intent, corridor);
  }

  /**
   * SEP-12 `PUT /customer` — register a customer with the receiving anchor and
   * get back the id that identifies them in every later call.
   *
   * This is deliberately NOT part of `AnchorAdapter`, and the engine never calls
   * it. Registration is the SENDING side's job: it collects and verifies the
   * PII, hands it to the receiving anchor once, and thereafter refers to the
   * customer by opaque id. Keeping it off the port is what lets the engine
   * orchestrate payments without PII ever passing through it — `execute()` only
   * ever sees a `sep12Id`.
   *
   * Call this from your deployment layer before `execute()`, and put the
   * returned id on `intent.recipient.sep12Id`.
   *
   * `fields` are the SEP-12 fields the anchor asks for; which ones are required
   * comes from its `GET /customer` response and varies per anchor and per type.
   */
  async registerCustomer(
    fields: Record<string, string>,
    opts: { type?: string; account?: string } = {},
  ): Promise<Outcome<string>> {
    const kyc = this.anchor.endpoints.kyc_server;
    if (!kyc) {
      return fail("KYC_REQUIRED", `${this.name}: anchor exposes no SEP-12 KYC server`);
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${kyc}/customer`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...this.authHeader(auth.value),
        },
        body: JSON.stringify({
          ...((opts.account ?? this.sep10Signer?.account)
            ? { account: opts.account ?? this.sep10Signer?.account }
            : {}),
          ...(opts.type ? { type: opts.type } : {}),
          ...fields,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return fail(
          "KYC_REQUIRED",
          `${this.name}: SEP-12 PUT /customer HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
          { retryable: res.status >= 500 },
        );
      }
      const j = (await res.json()) as { id?: string };
      if (!j.id) {
        return fail("KYC_REQUIRED", `${this.name}: SEP-12 PUT /customer returned no id`);
      }
      return ok(j.id);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-12 registration failed`, {
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
    // SEP-12: check the receiving customer's status. Fails closed without an id.
    const customerId = intent.recipient.sep12Id;
    if (!customerId) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: recipient has no SEP-12 customer id (register via registerCustomer first)`,
      );
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(
        `${kyc}/customer?id=${encodeURIComponent(customerId)}`,
        { headers: this.authHeader(auth.value) },
      );
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-12 GET /customer HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as { status?: string };
      if (j.status === "ACCEPTED") return ok<KycResult>({ status: "accepted" });
      if (j.status === "PROCESSING") return ok<KycResult>({ status: "pending" });
      return fail("KYC_REQUIRED", `${this.name}: recipient KYC status ${j.status ?? "unknown"}`);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-12 check failed`, {
        retryable: true,
        cause,
      });
    }
  }
}
