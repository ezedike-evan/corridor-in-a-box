// @corridor/sep6 — ONE adapter for any standards-compliant SEP-6 anchor, wired
// from the side that drives the corridor: it opens a withdraw-exchange
// transaction and returns the Stellar payment instructions the engine settles
// against (issue #197).
//
// The engine knows only the AnchorAdapter port (@corridor/adapter-kit). A
// `dest.protocol: sep6` corridor plugs into that port here. The on-chain settle
// leg is NOT in this package — an SEP-6 withdrawal settles through the existing
// StellarPaymentStrategy with no engine change, because `openTransaction`
// returns the same flat `OpenTransaction` as SEP-31. Note for the reader of the
// issue text: #183's discriminated `DepositInstructions` union has NOT landed
// in this tree, so "where to send the asset" is still
// `depositAddress`/`memo`/`memoType` — exactly what `buildSettlementRequest`
// (packages/engine/src/verbs.ts) reads off `opened`.
//
// ENDPOINT EVIDENCE (#197 — which method/path, and why). The issue brief named
// `POST /transactions/withdraw-exchange`; no version of SEP-6 has ever defined
// that path. SEP-6 v4.3.0 (current; updated 2025-09-10) lists exactly five
// initiation endpoints — `GET /deposit`, `GET /withdraw`, `GET /deposit-exchange`,
// `GET /withdraw-exchange`, `GET /info` — and its firm-quote withdraw diagram
// initiates with `GET [SEP-6]/withdraw-exchange` and reads the receiving
// account/memo back from `GET [SEP-6]/transaction?id=`. Verified live against
// testanchor.stellar.org (whose stellar.toml publishes TRANSFER_SERVER =
// https://testanchor.stellar.org/sep6): with a SEP-10 JWT, `GET
// /sep6/withdraw-exchange?...` returns 200 `{"id": ...}` with no account, `POST`
// to the same path returns "Request method 'POST' is not supported", and
// `GET /sep6/withdraw/exchange` is not routed. So this implements the current
// spec's GET-with-query-params form.

import type { Corridor, Sep6Anchor } from "@corridor/manifest";
import {
  fail,
  isValidAmount,
  ok,
  type Money,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import type {
  AdapterCapabilities,
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  RefundRef,
  TransactionStatus,
} from "@corridor/adapter-kit";

type FetchLike = typeof fetch;

/**
 * Signs a SEP-10 challenge. The concrete implementation (Keypair + Transaction
 * from @stellar/stellar-sdk) is supplied by the caller, keeping this package
 * free of a chain SDK. Same seam as @corridor/sep31 — copied deliberately;
 * adapters must not gain a dependency on each other.
 */
export interface Sep10Signer {
  /** The Stellar account (G…) being authenticated. */
  readonly account: string;
  /** Sign the base64 challenge XDR and return the signed XDR. */
  signChallenge(challengeXdr: string, networkPassphrase: string): Promise<string>;
}

export interface Sep6AdapterOptions {
  /** Inject a fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: FetchLike;
  /** SEP-10 signer. Without it the adapter calls anchors anonymously. */
  sep10?: Sep10Signer;
}

/** Terminal non-success at the anchor: stop polling, hand over to recovery. */
const TERMINAL_FAILURE_STATUSES = new Set([
  "error",
  "expired",
  "refunded",
  "no_market",
  "too_small",
  "too_large",
]);

/**
 * In flight and blocked on input from outside the anchor. In a SEP-6
 * withdrawal "the user" is us — `pending_user_transfer_start` is the state the
 * settle leg is meant to act on — so a run that times out here timed out
 * waiting on a human or on our own payment, not on a slow anchor.
 */
const AWAITING_INPUT_STATUSES = new Set([
  "incomplete",
  "pending_user",
  "pending_user_transfer_start",
  "pending_customer_info_update",
  "pending_transaction_info_update",
]);

/**
 * In flight with the work on the anchor's side (or the network's). Classified
 * explicitly rather than left to the default so that "we know this status and
 * it means keep waiting" is distinguishable from "we have never seen this".
 */
const IN_FLIGHT_STATUSES = new Set([
  "pending_external",
  "pending_anchor",
  "pending_stellar",
  "pending_trust",
  "pending_user_transfer_complete",
  "on_hold",
]);

/** Record statuses that mean "KYC is what is holding the account back". */
const KYC_BLOCKED_STATUSES = new Set(["incomplete", "pending_customer_info_update"]);

/**
 * Classify a SEP-6 transaction status into the engine's reconcile model.
 *
 * SEP-6's lifecycle is SEP-31's plus the user-transfer states
 * (`pending_user_transfer_start`/`_complete`), `on_hold`, `pending_trust`,
 * `pending_user` and the amount-failure terminals `no_market`/`too_small`/
 * `too_large`. Same discipline as `mapSep31Status`: unknown statuses stay
 * in-flight (fail-open to polling, never to a false "settled"). Exported so it
 * can grow as real anchors surface new statuses.
 */
export function mapSep6Status(raw: string): {
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
      ...(status === "pending_external" ? { phase: "external" as const } : {}),
      settled: false,
      terminalFailure: false,
      awaitingInput: false,
    };
  }
  // Unrecognised status. Same shape as a known in-flight one on purpose: the
  // default must stay fail-open to polling and never to a false "settled".
  return { status, settled: false, terminalFailure: false, awaitingInput: false };
}

/**
 * A decimal amount string, or undefined if the anchor sent anything else.
 *
 * Deliberately refuses numbers. An anchor that sends `100.1` as JSON has
 * already put the value through a float64, and accepting it here would launder
 * that into a `Money` the rest of the system trusts.
 */
function amountString(v: unknown): string | undefined {
  return typeof v === "string" && isValidAmount(v.trim()) ? v.trim() : undefined;
}

/** A non-empty string, or undefined if the anchor sent anything else. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * The anchor's memo type, case-insensitively, or undefined when absent or not
 * one of the three memo encodings Stellar supports. Never defaulted to "text":
 * a hash memo encoded as text is corrupted (32 bytes blows past the 28-byte
 * text cap), so an unknown type is reported as unknown.
 */
function parseMemoType(v: unknown): "text" | "hash" | "id" | undefined {
  const memoType = typeof v === "string" ? v.toLowerCase() : undefined;
  return memoType === "hash" || memoType === "id" || memoType === "text"
    ? memoType
    : undefined;
}

/**
 * SEP-38 Asset Identification Format for the corridor's bridge asset:
 * `stellar:native` for XLM, `stellar:CODE:ISSUER` for everything else. Anchors
 * reject issuer-less Stellar asset ids.
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

/** Read a JSON body off a response exactly once (bodies are single-use streams). */
async function jsonBody(res: Response): Promise<Record<string, unknown> | undefined> {
  const raw = await res.text().catch(() => "");
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Truncate an anchor-supplied detail for an error message. */
function clip(s: string, max = 300): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export class Sep6Adapter implements AnchorAdapter {
  readonly name: string;
  private readonly anchor: Sep6Anchor;
  /** Bridge asset for this corridor — the denomination `amount_in` is reported in. */
  private readonly settlementAsset: string;
  private readonly transferServer: string;
  private readonly fetchImpl: FetchLike;
  private readonly sep10?: Sep10Signer;
  private cachedToken?: { token: string; expMs: number };

  constructor(corridor: Corridor, opts: Sep6AdapterOptions = {}) {
    if (corridor.dest.protocol !== "sep6") {
      throw new Error(
        `Sep6Adapter cannot handle protocol "${corridor.dest.protocol}"; use an adapter for that protocol`,
      );
    }
    this.anchor = corridor.dest as Sep6Anchor;
    this.name = corridor.dest.name;
    this.settlementAsset = corridor.settlement.bridge_asset;
    // Required by the manifest schema (`Sep6DestSchema`), guarded anyway: a
    // hand-built Corridor object that skipped parseCorridor must not reach the
    // network with an undefined base.
    if (!this.anchor.endpoints.transfer_server) {
      throw new Error(`Sep6Adapter: corridor ${corridor.id} has no dest transfer_server`);
    }
    this.transferServer = this.anchor.endpoints.transfer_server;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sep10 = opts.sep10;
  }

  // SEP-10 challenge/response: GET a challenge transaction, sign it, POST it back
  // for a JWT. Cached until ~30s before expiry.
  //
  // FAILS CLOSED, same contract as @corridor/sep31: if a signer is configured,
  // a failed handshake is a hard, retryable error — never a silent anonymous
  // call. `ok(undefined)` means one thing only: no auth configured, anonymous
  // access is intended.
  private async authToken(): Promise<Outcome<string | undefined>> {
    const webAuth = this.anchor.endpoints.web_auth;
    if (!webAuth || !this.sep10) return ok(undefined);

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expMs - 30_000 > now) {
      return ok(this.cachedToken.token);
    }

    const authFailed = (why: string) =>
      fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-10 auth failed (${why})`, {
        retryable: true,
      });

    try {
      const url = new URL(webAuth);
      url.searchParams.set("account", this.sep10.account);
      url.searchParams.set("home_domain", this.anchor.endpoints.home_domain);
      const challengeRes = await this.fetchImpl(url.toString());
      if (!challengeRes.ok) return authFailed(`challenge HTTP ${challengeRes.status}`);
      const challenge = (await challengeRes.json()) as {
        transaction?: string;
        network_passphrase?: string;
      };
      if (!challenge.transaction || !challenge.network_passphrase) {
        return authFailed("challenge response missing transaction/network_passphrase");
      }

      const signed = await this.sep10.signChallenge(
        challenge.transaction,
        challenge.network_passphrase,
      );
      const tokenRes = await this.fetchImpl(webAuth, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: signed }),
      });
      if (!tokenRes.ok) return authFailed(`token HTTP ${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token?: string };
      if (!token) return authFailed("token response missing `token`");

      this.cachedToken = { token, expMs: jwtExpiryMs(token) ?? now + 15 * 60_000 };
      return ok(token);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-10 auth request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /** `Authorization` header for an authenticated call, or {} when the corridor
   *  configures no SEP-10. Propagates an auth failure to the caller. */
  private authHeader(token: string | undefined): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  capabilities(): AdapterCapabilities {
    const e = this.anchor.endpoints;
    return {
      protocol: "sep6",
      quotes: e.quote_server ? ["sep38_firm"] : ["none"],
      kyc: e.kyc_server ? "sep12" : "none",
      settlement: ["stellar_payment"],
      refunds: "report_only",
      callbacks: false,
    };
  }

  /**
   * Minimal SEP-38 firm quote — the honest floor, not the full design. #196
   * owns SEP-38 properly (indicative prices, the `total_price` arithmetic
   * cross-check @corridor/sep31 performs, expiry policy); until that lands we
   * only POST /quote when the dest pins a quote server, honour the anchor's
   * own sell_amount, and refuse anything we cannot read. Corridors without a
   * quote server price through `fx.quote_source: external` instead.
   */
  async requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const quoteServer = this.anchor.endpoints.quote_server;
    if (!quoteServer) {
      return fail(
        "QUOTE_UNAVAILABLE",
        `${this.name}: SEP-6 dest configures no SEP-38 quote server — firm quotes over ` +
          `SEP-6 are issue #196. Until then price corridor ${corridor.id} with ` +
          `fx.quote_source: external or a quote-bearing adapter`,
      );
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${quoteServer}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeader(auth.value),
        },
        body: JSON.stringify({
          context: "sep6",
          sell_asset: sep38SellAsset(corridor),
          buy_asset: corridor.dest.asset,
          sell_amount: intent.sourceAmount.amount,
        }),
      });
      if (!res.ok) {
        return fail("QUOTE_UNAVAILABLE", `${this.name}: quote HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await jsonBody(res)) as
        | {
            id?: unknown;
            price?: unknown;
            expires_at?: unknown;
            sell_amount?: unknown;
            buy_amount?: unknown;
            fee?: { total?: unknown; asset?: unknown };
          }
        | undefined;
      const id = nonEmptyString(j?.id);
      const price = amountString(j?.price);
      const buyAmount = amountString(j?.buy_amount);
      const expiresAt = typeof j?.expires_at === "string" ? Date.parse(j.expires_at) : NaN;
      if (!id || !price || !buyAmount || !Number.isFinite(expiresAt)) {
        return fail(
          "QUOTE_UNAVAILABLE",
          `${this.name}: SEP-38 quote response is unreadable (need id, price, ` +
            `buy_amount, expires_at as decimal strings)`,
        );
      }
      // Honour the anchor's OWN sell_amount, not the amount we asked for — the
      // same rule @corridor/sep31 applies: the firm quote binds to the anchor's
      // number, and settling ours instead means the payout will not match.
      const sellAmount = amountString(j?.sell_amount) ?? intent.sourceAmount.amount;

      let fee: Money | undefined;
      if (j?.fee) {
        const sellAsset = sep38SellAsset(corridor);
        // A fee in some other asset changes what must be sent; refuse the quote
        // rather than guess at the economics.
        if (j.fee.asset !== sellAsset) {
          return fail(
            "QUOTE_UNAVAILABLE",
            `${this.name}: quote fee asset "${String(j.fee.asset)}" does not match ` +
              `sell asset "${sellAsset}"`,
          );
        }
        const feeTotal = amountString(j.fee.total);
        if (feeTotal !== undefined) {
          fee = { asset: intent.sourceAmount.asset, amount: feeTotal };
        }
      }

      return ok<Quote>({
        id,
        price,
        expiresAt,
        sourceAmount: { asset: intent.sourceAmount.asset, amount: sellAmount },
        destAmount: { asset: corridor.dest.asset, amount: buyAmount },
        ...(fee && { fee }),
        firm: true,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: quote request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /**
   * SEP-12 status read for the recipient — the same faithful `GET /customer`
   * @corridor/sep31 does, and nothing more. The ComplianceStrategy design
   * (who registers, which party, what a SEP-6 anchor expects when no
   * kyc_server is configured) is issue #193; without a kyc_server we refuse
   * rather than assume a 1:1 KYC-less corridor.
   */
  async ensureCompliance(
    intent: PaymentIntent,
    corridor: Corridor,
  ): Promise<Outcome<KycResult>> {
    const kyc = this.anchor.endpoints.kyc_server;
    if (!kyc) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: SEP-6 dest configures no SEP-12 kyc_server — compliance routing for ` +
          `SEP-6 corridors is issue #193. Refusing to assume this lane needs no KYC.`,
      );
    }
    const sep12Id = intent.recipient.sep12Id;
    if (!sep12Id) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: recipient has no SEP-12 customer id — register the receiver ` +
          `with this anchor (SEP-12 PUT /customer) and set recipient.sep12Id before ` +
          `settling. Refusing to settle on an unverified recipient.`,
      );
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const url = new URL(`${kyc}/customer`);
      url.searchParams.set("id", sep12Id);
      url.searchParams.set("type", corridor.compliance.sep12_receiver_type);
      const res = await this.fetchImpl(url.toString(), {
        headers: this.authHeader(auth.value),
      });
      if (!res.ok) {
        return fail("KYC_REQUIRED", `${this.name}: SEP-12 customer HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await jsonBody(res)) as { id?: unknown; status?: unknown } | undefined;
      const status = (nonEmptyString(j?.status) ?? "").toUpperCase();
      if (status === "ACCEPTED") {
        return ok<KycResult>({ status: "accepted", customerId: nonEmptyString(j?.id) });
      }
      if (status === "REJECTED") {
        return ok<KycResult>({ status: "rejected", customerId: nonEmptyString(j?.id) });
      }
      // PROCESSING, NEEDS_INFO, or anything unknown → not yet cleared.
      return ok<KycResult>({ status: "pending", customerId: nonEmptyString(j?.id) });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-12 request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /**
   * Open a SEP-6 withdraw-exchange transaction: `GET /withdraw-exchange` with
   * the bridge asset as `source_asset` (SEP-38 id), the corridor's payout asset
   * as `destination_asset`, the firm quote's sell amount, and whatever
   * identifies the customer to the anchor — the operator's SEP-10 `account`
   * and/or the recipient's SEP-12 `customer_id`.
   *
   * The response either names the account to pay (map it to the flat
   * pre-#183 OpenTransaction, which settle() treats as `stellar_payment`), or
   * it does not — a KYC-shaped answer, or v3.24.0's optional `account_id`. In
   * those cases we NEVER return a half-transaction: an empty depositAddress
   * would build a bogus payment downstream, so the caller gets a refusal and,
   * where one follow-up could answer the question, exactly one
   * `GET /transaction?id=`.
   */
  async openTransaction(
    intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    // An unattributed withdrawal is un-settleable and unreconcilable: the
    // anchor ties the record to the SEP-10 `sub`, to `account`, or to
    // `customer_id` — with none of the three it cannot even answer
    // GET /transaction for us later. Fail before touching the network.
    const account = this.sep10?.account;
    const customerId = intent.recipient.sep12Id;
    if (!account && !customerId) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: cannot open a SEP-6 withdrawal with neither a SEP-10 signer nor ` +
          `recipient.sep12Id — the anchor would have no way to attribute the ` +
          `transaction. Refusing to open it unattributed.`,
      );
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;

    try {
      const url = new URL(`${this.transferServer}/withdraw-exchange`);
      url.searchParams.set("source_asset", sep38SellAsset(corridor));
      url.searchParams.set("destination_asset", corridor.dest.asset);
      url.searchParams.set("amount", quote.sourceAmount.amount);
      // A quote_id must reference a quote THIS anchor issued. An
      // ExternalQuoteProvider id is ours, not the anchor's, and a conformant
      // anchor 400s on a quote whose pair does not match — send only firm ones.
      if (quote.firm && quote.id) url.searchParams.set("quote_id", quote.id);
      if (account) url.searchParams.set("account", account);
      if (customerId) url.searchParams.set("customer_id", customerId);
      // Payout instructions keyed by the names the anchor's /info declares for
      // the withdrawal type (`dest`/`dest_extra` per SEP-9), `type` included:
      // only the anchor names its own funding methods, so we never invent one.
      // Protocol params win on a name clash — an anchor field called "amount"
      // must not silently rewrite what we send.
      for (const [field, value] of Object.entries(intent.destinationFields ?? {})) {
        if (!url.searchParams.has(field)) url.searchParams.set(field, value);
      }

      const res = await this.fetchImpl(url.toString(), {
        headers: this.authHeader(auth.value),
      });
      const j = await jsonBody(res);
      const kyc = this.kycRefusal(j);
      if (kyc) return kyc;

      if (!res.ok) {
        const detail = nonEmptyString(j?.error) ?? clip(await this.rawText(res));
        return fail(
          "ANCHOR_UNAVAILABLE",
          `${this.name}: open-tx HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
          { retryable: res.status >= 500 },
        );
      }

      const transactionId = nonEmptyString(j?.id);
      if (!transactionId) {
        // No anchor id means no record to poll: reconcile would have nothing
        // to verify against, which is exactly the blind settle this refuses.
        return fail(
          "ANCHOR_UNAVAILABLE",
          `${this.name}: withdraw-exchange succeeded but returned no transaction id — ` +
            `there is no record to reconcile against, so nothing was settled`,
        );
      }
      const depositAddress = nonEmptyString(j?.account_id);
      if (depositAddress) {
        return ok<OpenTransaction>({
          transactionId,
          depositAddress,
          memo: nonEmptyString(j?.memo),
          // Carry the anchor's memo TYPE through; assuming "text" corrupts a
          // hash memo (32 bytes > 28-byte text cap) and the submit fails.
          memoType: parseMemoType(j?.memo_type),
        });
      }
      // SEP-6 ≥ v3.24.0 makes `account_id` optional in the success response —
      // testanchor returns only {"id": ...}. One follow-up read, no polling:
      // more belongs to reconcile, not to open.
      return this.instructionsFromRecord(transactionId, auth.value);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: open-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /**
   * Exactly one `GET /transaction?id=` to pick up an account the initiate
   * response did not carry. Absent-or-unreadable account afterwards is a
   * REFUSAL, never an empty-address ok(): settle would pay nowhere.
   *
   * Failures here are NON-retryable on purpose: an automatic retry of
   * `openTransaction` initiates a SECOND withdrawal at the anchor (there is no
   * idempotent re-open in SEP-6). Whether the block is KYC or a record that is
   * simply not populated yet, the correct operator move is to resolve it and
   * re-run with a new idempotency key — the transaction id travels in the
   * message so the anchor-side record can be found.
   */
  private async instructionsFromRecord(
    transactionId: string,
    token: string | undefined,
  ): Promise<Outcome<OpenTransaction>> {
    const url = new URL(`${this.transferServer}/transaction`);
    url.searchParams.set("id", transactionId);
    const res = await this.fetchImpl(url.toString(), {
      headers: this.authHeader(token),
    });
    if (!res.ok) {
      const detail = clip(await this.rawText(res));
      return fail(
        "ANCHOR_UNAVAILABLE",
        `${this.name}: transaction ${transactionId} record HTTP ${res.status}` +
          `${detail ? ` — ${detail}` : ""} — opened but no deposit instructions`,
        { retryable: res.status >= 500 },
      );
    }
    const j = await jsonBody(res);
    const tx = j?.transaction as Record<string, unknown> | undefined;
    const depositAddress = nonEmptyString(tx?.withdraw_anchor_account);
    if (depositAddress) {
      return ok<OpenTransaction>({
        transactionId,
        depositAddress,
        memo: nonEmptyString(tx?.withdraw_memo),
        memoType: parseMemoType(tx?.withdraw_memo_type),
      });
    }
    const status = (nonEmptyString(tx?.status) ?? "").toLowerCase();
    if (KYC_BLOCKED_STATUSES.has(status)) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: transaction ${transactionId} is ${status} — the anchor has not ` +
          `accepted the customer and issues no account until it does. Complete SEP-12 ` +
          `for this customer and re-run with a new idempotency key.`,
      );
    }
    return fail(
      "ANCHOR_UNAVAILABLE",
      `${this.name}: transaction ${transactionId} reported no withdraw account ` +
        `(status=${status || "unknown"}) — refusing to settle blind; resolve the ` +
        `anchor-side record out-of-band before retrying.`,
    );
  }

  /**
   * The deprecated-but-alive KYC branches of a withdraw response, matched on the
   * body's `type` discriminator BEFORE the status code — spec v4.3.0 says they
   * return 403, but anchors that "moved on" to `pending_customer_info_update`
   * have been seen returning them with 200, and a KYC-shaped body under a
   * 200 is still a refusal, never instructions.
   */
  private kycRefusal(
    j: Record<string, unknown> | undefined,
  ): Outcome<OpenTransaction> | undefined {
    const type = nonEmptyString(j?.type);
    if (!type) return undefined;
    if (type === "non_interactive_customer_info_needed") {
      const fields = Array.isArray(j?.fields)
        ? j.fields.filter((f): f is string => typeof f === "string" && f.length > 0)
        : [];
      return fail(
        "KYC_REQUIRED",
        `${this.name}: anchor requires SEP-12 fields [${fields.join(", ")}] before it ` +
          `will open a withdrawal — supply them and re-run with a new idempotency key`,
      );
    }
    if (type === "customer_info_status") {
      const status = (nonEmptyString(j?.status) ?? "").toLowerCase();
      const moreInfo = nonEmptyString(j?.more_info_url);
      if (status === "denied") {
        return fail(
          "KYC_REJECTED",
          `${this.name}: anchor denied this customer's information${moreInfo ? ` — ${moreInfo}` : ""}`,
        );
      }
      // pending — or a status we do not know: not a yes, so not a transaction.
      return fail(
        "KYC_REQUIRED",
        `${this.name}: anchor is still processing this customer's information ` +
          `(status=${status || "unknown"})${moreInfo ? ` — ${moreInfo}` : ""}`,
      );
    }
    if (type === "authentication_required") {
      // Retryable: the usual cause is our cached JWT expiring; the next attempt
      // re-authenticates.
      return fail(
        "ANCHOR_UNAVAILABLE",
        `${this.name}: anchor requires SEP-10 authentication for this withdrawal`,
        { retryable: true },
      );
    }
    return undefined;
  }

  /** Body text for error details, after jsonBody() already consumed the stream. */
  private async rawText(res: Response): Promise<string> {
    return await res.text().catch(() => "");
  }

  /**
   * Poll a SEP-6 withdrawal record. SEP-6 GET /transaction REQUIRES the
   * SEP-10 JWT (unlike SEP-31's GET /transactions/:id), so this call
   * authenticates whenever a signer is configured.
   */
  async getTransaction(transactionId: string): Promise<Outcome<TransactionStatus>> {
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const url = new URL(`${this.transferServer}/transaction`);
      url.searchParams.set("id", transactionId);
      const res = await this.fetchImpl(url.toString(), {
        headers: this.authHeader(auth.value),
      });
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = await jsonBody(res);
      const tx = j?.transaction as
        | {
            status?: unknown;
            amount_in?: unknown;
            amount_in_asset?: unknown;
            withdraw_anchor_account?: unknown;
            withdraw_memo?: unknown;
            withdraw_memo_type?: unknown;
          }
        | undefined;
      if (!tx || typeof tx.status !== "string") {
        return fail(
          "ANCHOR_UNAVAILABLE",
          `${this.name}: get-tx response has no readable transaction.status`,
          { retryable: true },
        );
      }
      const mapped = mapSep6Status(tx.status);
      const asset = nonEmptyString(tx.amount_in_asset) ?? this.settlementAsset;
      const amountIn = amountString(tx.amount_in);
      const depositAddress = nonEmptyString(tx.withdraw_anchor_account);
      const memo = nonEmptyString(tx.withdraw_memo);
      const memoType = parseMemoType(tx.withdraw_memo_type);

      return ok<TransactionStatus>({
        ...mapped,
        ...(amountIn !== undefined ? { amountIn: { asset, amount: amountIn } } : {}),
        ...(depositAddress !== undefined ? { depositAddress } : {}),
        ...(memo !== undefined ? { memo } : {}),
        ...(memoType !== undefined ? { memoType } : {}),
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }

  // Refund initiation: NOT IMPLEMENTABLE over SEP-6, on purpose — same
  // reasoning as @corridor/sep31. SEP-6 defines no sender-initiated refund
  // call; a refund is decided by the anchor and only REPORTED to us on the
  // transaction record (the `refunds` object, statuses `refunded`/`error`).
  // Anything this method could POST to would be a bespoke endpoint dressed up
  // as conformance, and no network call is made.
  async requestRefund(
    transactionId: string,
    _amount?: Money,
    _reason?: string,
  ): Promise<Outcome<RefundRef>> {
    return fail(
      "REFUND_UNSUPPORTED",
      `${this.name}: SEP-6 has no sender-initiated refund endpoint — a refund is ` +
        `initiated by the anchor and only reported back on transaction ` +
        `${transactionId}; resolve out-of-band with the anchor (see the held/refunded ` +
        `runbook in docs/operations.md) and watch getTransaction() for the outcome`,
      { retryable: false },
    );
  }
}
