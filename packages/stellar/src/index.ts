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
  NotFoundError,
  Operation,
  Transaction,
  TransactionBuilder,
  TransactionFailedError,
  xdr,
} from "@stellar/stellar-sdk";
import { fail, fromScaled, ok, STROOP_SCALE, toScaled, type Outcome } from "@corridor/types";
import type {
  CheckResult,
  GateCheck,
  GateContext,
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

/**
 * Encode the anchor's deposit memo in the form the anchor asked for.
 *
 * Getting this wrong is not cosmetic: a `hash` memo is 32 raw bytes delivered as
 * base64, and forcing it through Memo.text() throws ("Expects string, array or
 * buffer, max 28 bytes"). Even where it fits, the wrong memo type means the
 * anchor cannot match the incoming payment to its transaction, so the funds
 * arrive unattributed. Default to text only when the anchor said nothing.
 */
function buildMemo(memo: string, type: "text" | "hash" | "id" | undefined): Memo {
  switch (type) {
    case "hash":
      return Memo.hash(Buffer.from(memo, "base64").toString("hex"));
    case "id":
      return Memo.id(memo);
    case "text":
    default:
      return Memo.text(memo);
  }
}

// --- Signing -------------------------------------------------------------
// The private key is the most sensitive thing in the system. ExternalSigner is
// the seam that keeps it out of this process: a KMS/HSM implements `sign` and
// the raw seed never leaves the vault. LocalKeypairSigner (an in-process seed)
// is for dev/testnet only. See docs/key-management.md.

export interface ExternalSigner {
  /** The signing account (G…). */
  readonly publicKey: string;
  /** Produce a 64-byte ed25519 signature over `data` (the 32-byte tx hash). */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** In-process signer backed by a Stellar seed. Dev/testnet only — in production
 *  implement ExternalSigner over a KMS/HSM so the seed never enters the app. */
export class LocalKeypairSigner implements ExternalSigner {
  readonly publicKey: string;
  constructor(private readonly keypair: Keypair) {
    this.publicKey = keypair.publicKey();
  }
  static fromSecret(secret: string): LocalKeypairSigner {
    return new LocalKeypairSigner(Keypair.fromSecret(secret));
  }
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return this.keypair.sign(Buffer.from(data));
  }
}

function isKeypair(s: ExternalSigner | Keypair): s is Keypair {
  // Keypair exposes publicKey() as a method; ExternalSigner as a string property.
  return typeof (s as { publicKey: unknown }).publicKey === "function";
}

function toSigner(s: ExternalSigner | Keypair): ExternalSigner {
  return isKeypair(s) ? new LocalKeypairSigner(s) : s;
}

/** Attach an ExternalSigner's signature to a built transaction. */
async function attachSignature(tx: Transaction, signer: ExternalSigner): Promise<void> {
  const signature = Buffer.from(await signer.sign(tx.hash()));
  const hint = Keypair.fromPublicKey(signer.publicKey).signatureHint();
  tx.signatures.push(new xdr.DecoratedSignature({ hint, signature }));
}

/** Signs SEP-10 challenges via an ExternalSigner (or a raw Keypair for dev). */
export class StellarSep10Signer implements Sep10Signer {
  private readonly signer: ExternalSigner;
  readonly account: string;
  constructor(signer: ExternalSigner | Keypair) {
    this.signer = toSigner(signer);
    this.account = this.signer.publicKey;
  }

  async signChallenge(challengeXdr: string, networkPassphrase: string): Promise<string> {
    const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase) as Transaction;
    await attachSignature(tx, this.signer);
    return tx.toXDR();
  }
}

/** The subset of Horizon.Server this class actually calls — narrow enough that
 *  tests can pass a fake without pulling in a real Horizon connection. */
type HorizonServerLike = Pick<
  Horizon.Server,
  "loadAccount" | "submitTransaction" | "transactions"
>;

export interface StellarSubmitterOptions {
  /** Production: a KMS/HSM-backed signer that never exposes the seed. */
  signer?: ExternalSigner;
  /** Dev/testnet convenience: a raw seed, wrapped in a LocalKeypairSigner. */
  signerSecret?: string;
  /** Horizon endpoint, e.g. https://horizon-testnet.stellar.org */
  horizonUrl: string;
  /** Test seam: inject a fake Horizon server instead of connecting for real. */
  horizonServer?: HorizonServerLike;
  /** The settlement fee (in XLM decimal string). Defaults to StellarSettlementSubmitter.fee. */
  fee?: string;
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
  /** The fee actually paid per settlement transaction, in XLM decimal string (e.g. "0.00001"). */
  static readonly fee: string = fromScaled(BigInt(BASE_FEE), STROOP_SCALE);

  readonly fee: string;
  private readonly signer: ExternalSigner;
  private readonly server: HorizonServerLike;
  private readonly confirmTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes loadAccount→build→sign→submit per signer, so two concurrent
   *  settlements never race on the same sequence number. Released as soon as
   *  submitTransaction() settles — NOT held through the (possibly 30s)
   *  confirm() poll, so one ambiguous submission doesn't head-of-line-block
   *  every other in-flight payment from this signer. */
  private lock: Promise<void> = Promise.resolve();

  constructor(opts: StellarSubmitterOptions) {
    if (!opts.signer && !opts.signerSecret) {
      throw new Error("StellarSettlementSubmitter: provide either `signer` or `signerSecret`");
    }
    this.signer = opts.signer ?? LocalKeypairSigner.fromSecret(opts.signerSecret as string);
    this.server = opts.horizonServer ?? new Horizon.Server(opts.horizonUrl);
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const fee = opts.fee ?? StellarSettlementSubmitter.fee;
    if (!toScaled(fee, STROOP_SCALE).ok) {
      throw new Error(
        `StellarSettlementSubmitter: invalid \`fee\` "${fee}" (expected an XLM decimal string)`,
      );
    }
    this.fee = fee;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: () => void = () => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async submit(req: SettlementRequest): Promise<Outcome<SettlementRef>> {
    let hash: string | undefined;
    let submitAttempted = false;
    try {
      const { network } = req.corridor.settlement;
      const passphrase = passphraseFor(network);
      const asset = bridgeAsset(req.amount.asset, req.corridor.settlement.asset_issuer);

      await this.withLock(async () => {
        const source = await this.server.loadAccount(this.signer.publicKey);
        const feeScaled = toScaled(this.fee, STROOP_SCALE);
        // this.fee was validated in the constructor.
        const feeStroops = feeScaled.ok ? feeScaled.value.toString() : BASE_FEE;
        const builder = new TransactionBuilder(source, {
          fee: feeStroops,
          networkPassphrase: passphrase,
        })
          .addOperation(
            Operation.payment({ destination: req.to, asset, amount: req.amount.amount }),
          )
          // Beat the firm-quote expiry: the tx must hit the ledger before the quote dies.
          .setTimeout(req.corridor.fx.quote_ttl_seconds);

        if (req.memo) builder.addMemo(buildMemo(req.memo, req.memoType));

        const tx = builder.build();
        // Computed before submission: the one thing that lets us check "did
        // this actually land" if submitTransaction's own response is lost.
        hash = tx.hash().toString("hex");
        await attachSignature(tx, this.signer);

        submitAttempted = true;
        await this.server.submitTransaction(tx);
      });

      const confirmed = await this.confirm(hash as string);
      if (!confirmed.ok) return confirmed;
      return ok<SettlementRef>({ stellarTxHash: hash as string, ledger: confirmed.value });
    } catch (cause) {
      if (!submitAttempted || cause instanceof TransactionFailedError) {
        // Either nothing ever reached Horizon (build/sign/lock failure — always
        // safe to retry), or Horizon evaluated the envelope and definitively
        // rejected it (e.g. tx_bad_seq) — also safe to retry, a fresh attempt
        // will get a fresh sequence number.
        return fail("SETTLEMENT_FAILED", `settlement submit failed: ${describe(cause)}`, {
          retryable: true,
          cause,
        });
      }
      // submitTransaction was attempted and failed WITHOUT a confirmed Horizon
      // rejection (network timeout, ECONNRESET, DNS failure, ...) — Horizon may
      // have applied the transaction even though this process never saw the
      // success response. Resubmitting blind here is exactly how a single
      // network blip becomes a double payment, so check before deciding.
      const landed = await this.confirm(hash as string);
      if (landed.ok) {
        return ok<SettlementRef>({ stellarTxHash: hash as string, ledger: landed.value });
      }
      return fail(
        landed.error.code,
        `settlement submit ambiguous for tx ${hash} (${describe(cause)}); ` +
          `confirm check: ${landed.error.message}`,
        { retryable: landed.error.retryable, cause },
      );
    }
  }

  async refund(req: RefundRequest): Promise<Outcome<SettlementRef>> {
    return fail(
      "REFUND_UNSUPPORTED",
      `payment ${req.original.stellarTxHash} cannot be reversed on-chain; ` +
        `resolve out-of-band with the receiving anchor (SEP-31 gives the sender ` +
        `no refund endpoint) — see the held runbook in docs/operations.md`,
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
        // NOT retryable-by-resubmission: the transaction may still land (or,
        // on the happy path, may have already landed and Horizon's read side
        // is just lagging), and sending a second one would risk a double
        // payment. Timeout means "needs manual reconciliation," not "safe to
        // retry" — mirrors packages/attester/src/index.ts's confirm().
        return fail("SETTLEMENT_TIMEOUT", `tx ${hash} not confirmed within timeout`);
      }
      await this.sleep(1_000);
    }
  }
}

/**
 * Turn a Horizon failure into something an operator can act on.
 *
 * Horizon rejects a bad transaction with a flat `400` and puts the actual reason
 * in `response.data.extras.result_codes` — `tx_failed` plus per-operation codes
 * like `op_no_trust` (no trustline for the asset) or `op_underfunded`. Reporting
 * only "Request failed with status code 400" hides exactly the information
 * needed to fix it.
 */
function describe(cause: unknown): string {
  const extras = (
    cause as {
      response?: {
        data?: {
          extras?: {
            result_codes?: { transaction?: string; operations?: string[] };
            result_xdr?: string;
          };
        };
      };
    }
  )?.response?.data?.extras;

  const codes = extras?.result_codes;
  if (codes) {
    const ops = codes.operations?.length ? ` operations=[${codes.operations.join(", ")}]` : "";
    return `${codes.transaction ?? "tx_failed"}${ops}`;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

// --- Account Inspector & Balance Gate Check -------------------------------
// Read-only chain facts for pre-settle and reconcile checks. Every chain-facing
// check reads through one AccountInspector so the check itself stays a pure
// function over plain data. Amounts are Horizon's decimal strings throughout —
// never parsed into floats.

export interface AccountBalanceFact {
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly balance: string;
  readonly selling_liabilities?: string;
  readonly buying_liabilities?: string;
  /** Always true for native XLM. For a trustline, false unless Horizon says it
   *  is authorized — an unknown authorization never reads as "authorized". */
  readonly is_authorized?: boolean;
}

export interface AccountFacts {
  readonly id: string;
  readonly subentry_count: number;
  readonly num_sponsoring: number;
  readonly num_sponsored: number;
  readonly balances: readonly AccountBalanceFact[];
  readonly flags?: Readonly<{
    auth_required?: boolean;
    auth_revocable?: boolean;
    auth_immutable?: boolean;
    auth_clawback_enabled?: boolean;
  }>;
}

export interface HorizonAccountBalanceLike {
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly balance: string;
  readonly selling_liabilities?: string;
  readonly buying_liabilities?: string;
  readonly is_authorized?: boolean;
}

export interface HorizonAccountResponseLike {
  readonly id?: string;
  readonly subentry_count?: number;
  readonly num_sponsoring?: number;
  readonly num_sponsored?: number;
  readonly balances?: readonly HorizonAccountBalanceLike[];
  readonly flags?: AccountFacts["flags"];
}

/** Stellar memo types as Horizon reports them. `hash` and `return` are base64. */
export type HorizonMemoType = "none" | "text" | "id" | "hash" | "return";

/** One payment operation, joined with the memo of the transaction carrying it. */
export interface PaymentFact {
  /** Operation id. */
  readonly id: string;
  readonly type: "payment" | "path_payment_strict_receive" | "path_payment_strict_send";
  readonly transactionHash: string;
  readonly ledger: number;
  readonly createdAt: string;
  readonly from: string;
  /** The destination G-address (the base account when paid to a muxed M-address). */
  readonly to: string;
  readonly toMuxed?: string;
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  /** Amount credited to `to`, as Horizon's decimal string. */
  readonly amount: string;
  readonly memoType: HorizonMemoType;
  readonly memo?: string;
}

export interface PaymentsFromOptions {
  /** Only payments whose destination is this account (G… or M…). */
  readonly to?: string;
  /** Only payments in this ledger or later. Paging stops once it is passed. */
  readonly sinceLedger?: number;
}

export interface PaymentsFromResult {
  /** Newest first. */
  readonly payments: readonly PaymentFact[];
  /**
   * True when the page budget ran out before the history (or `sinceLedger`)
   * was reached. A duplicate-send check must treat a truncated result as
   * "unknown", never as "no such payment".
   */
  readonly truncated: boolean;
}

interface HorizonPageLike<T> {
  readonly records: readonly T[];
  next(): Promise<HorizonPageLike<T>>;
}

interface HorizonLedgerLike {
  readonly sequence: number;
  readonly base_fee_in_stroops: number;
  readonly base_reserve_in_stroops: number;
}

interface HorizonJoinedTransactionLike {
  readonly memo_type: HorizonMemoType;
  readonly memo?: string;
  /** Horizon's raw field; the SDK moves the number to `ledger_attr` once parsed. */
  readonly ledger?: unknown;
  readonly ledger_attr?: number;
}

interface HorizonPaymentLike {
  readonly id: string;
  readonly type: string;
  readonly created_at: string;
  readonly transaction_hash: string;
  readonly from?: string;
  readonly to?: string;
  readonly to_muxed?: string;
  readonly asset_type?: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly amount?: string;
  /** Present when the call was made with `join("transactions")`. */
  readonly transaction_attr?: HorizonJoinedTransactionLike;
}

/**
 * The read-only slice of Horizon.Server the inspector calls. Structural, so a
 * real Horizon.Server satisfies it and tests can hand in a small fake.
 */
export interface InspectorHorizonLike {
  loadAccount(id: string): Promise<HorizonAccountResponseLike>;
  ledgers(): {
    order(direction: "desc"): {
      limit(n: number): { call(): Promise<HorizonPageLike<HorizonLedgerLike>> };
    };
  };
  payments(): {
    forAccount(id: string): {
      join(include: "transactions"): {
        order(direction: "desc"): {
          limit(n: number): { call(): Promise<HorizonPageLike<HorizonPaymentLike>> };
        };
      };
    };
  };
}

export interface AccountInspectorOptions {
  readonly horizonUrl?: string;
  /** Test seam: a fake Horizon instead of a real connection. */
  readonly horizonServer?: Partial<InspectorHorizonLike>;
  /** Pin the base reserve (XLM decimal) instead of reading the latest ledger. */
  readonly baseReserve?: string;
  /** Pin the base fee (XLM decimal) instead of reading the latest ledger. */
  readonly baseFee?: string;
  /** Records per Horizon page for paymentsFrom(). Default 200 (Horizon's max). */
  readonly pageSize?: number;
  /** Pages paymentsFrom() may read before reporting `truncated`. Default 10. */
  readonly maxPages?: number;
}

const PAYMENT_TYPES: ReadonlySet<string> = new Set([
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);

/** Horizon answered 404 — the resource does not exist, as opposed to "Horizon failed". */
function isNotFound(err: unknown): boolean {
  if (err instanceof NotFoundError) return true;
  const e = err as { response?: { status?: number }; status?: number } | undefined;
  return e?.response?.status === 404 || e?.status === 404;
}

function toAccountFacts(res: HorizonAccountResponseLike, id: string): AccountFacts {
  return {
    id: res.id ?? id,
    subentry_count: res.subentry_count ?? 0,
    num_sponsoring: res.num_sponsoring ?? 0,
    num_sponsored: res.num_sponsored ?? 0,
    balances: (res.balances ?? []).map((b) => ({
      asset_type: b.asset_type,
      asset_code: b.asset_code,
      asset_issuer: b.asset_issuer,
      balance: b.balance,
      selling_liabilities: b.selling_liabilities ?? "0",
      buying_liabilities: b.buying_liabilities ?? "0",
      is_authorized: b.asset_type === "native" ? true : b.is_authorized === true,
    })),
    flags: res.flags,
  };
}

/** Horizon reports stroops as a JSON integer; convert without touching floats. */
function stroopsToXlm(stroops: unknown): string | undefined {
  if (typeof stroops === "number" && Number.isSafeInteger(stroops) && stroops >= 0) {
    return fromScaled(BigInt(stroops), STROOP_SCALE);
  }
  if (typeof stroops === "string" && /^\d+$/.test(stroops)) {
    return fromScaled(BigInt(stroops), STROOP_SCALE);
  }
  return undefined;
}

function horizonFailure(what: string, err: unknown): Outcome<never> {
  return fail(
    "SETTLEMENT_FAILED",
    `failed to ${what}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err, retryable: true },
  );
}

/**
 * Read-only Horizon inspector: account facts (balances, trustline
 * authorization, reserve counts, flags), the network's base reserve and base
 * fee, and our own payment history joined with transaction memos. It never
 * signs or submits anything.
 */
export class AccountInspector {
  private readonly server: Partial<InspectorHorizonLike>;
  private readonly pinnedBaseReserve?: string;
  private readonly pinnedBaseFee?: string;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(opts: AccountInspectorOptions = {}) {
    this.server =
      opts.horizonServer ??
      new Horizon.Server(opts.horizonUrl ?? "https://horizon-testnet.stellar.org");
    this.pinnedBaseReserve = opts.baseReserve;
    this.pinnedBaseFee = opts.baseFee;
    this.pageSize = opts.pageSize ?? 200;
    this.maxPages = opts.maxPages ?? 10;
  }

  /** `ok(undefined)` means the account does not exist (Horizon 404). */
  async account(id: string): Promise<Outcome<AccountFacts | undefined>> {
    try {
      if (!this.server.loadAccount) throw new Error("horizon server has no loadAccount");
      return ok(toAccountFacts(await this.server.loadAccount(id), id));
    } catch (err: unknown) {
      if (isNotFound(err)) return ok(undefined);
      return horizonFailure(`load account ${id}`, err);
    }
  }

  /** Base reserve per entry, in XLM, from the latest closed ledger. */
  async baseReserve(): Promise<Outcome<string>> {
    if (this.pinnedBaseReserve !== undefined) return ok(this.pinnedBaseReserve);
    return this.fromLatestLedger("base reserve", (l) => l.base_reserve_in_stroops);
  }

  /** Base fee per operation, in XLM, from the latest closed ledger. */
  async baseFee(): Promise<Outcome<string>> {
    if (this.pinnedBaseFee !== undefined) return ok(this.pinnedBaseFee);
    return this.fromLatestLedger("base fee", (l) => l.base_fee_in_stroops);
  }

  private async fromLatestLedger(
    what: string,
    pick: (l: HorizonLedgerLike) => unknown,
  ): Promise<Outcome<string>> {
    try {
      if (!this.server.ledgers) throw new Error("horizon server has no ledgers");
      const page = await this.server.ledgers().order("desc").limit(1).call();
      const latest = page.records[0];
      if (!latest) return fail("SETTLEMENT_FAILED", `no ledger returned for ${what}`);
      const xlm = stroopsToXlm(pick(latest));
      if (xlm === undefined) {
        return fail("SETTLEMENT_FAILED", `ledger ${latest.sequence} has no valid ${what}`);
      }
      return ok(xlm);
    } catch (err: unknown) {
      return horizonFailure(`read ${what} from the latest ledger`, err);
    }
  }

  /**
   * Payments sent BY `source`, newest first, each joined with its
   * transaction's memo. Incoming payments are dropped, as are non-payment
   * operations (create_account, account_merge, ...). Reads at most `maxPages`
   * pages; see `truncated`.
   */
  async paymentsFrom(
    source: string,
    opts: PaymentsFromOptions = {},
  ): Promise<Outcome<PaymentsFromResult>> {
    const out: PaymentFact[] = [];
    try {
      if (!this.server.payments) throw new Error("horizon server has no payments");
      let page = await this.server
        .payments()
        .forAccount(source)
        .join("transactions")
        .order("desc")
        .limit(this.pageSize)
        .call();
      for (let read = 1; ; read += 1) {
        for (const r of page.records) {
          const fact = toPaymentFact(r);
          if (!fact) {
            return fail(
              "SETTLEMENT_FAILED",
              `payment ${r.id} came back without its transaction's memo or ledger`,
            );
          }
          if (opts.sinceLedger !== undefined && fact.ledger < opts.sinceLedger) {
            return ok({ payments: out, truncated: false });
          }
          if (!PAYMENT_TYPES.has(r.type) || fact.from !== source) continue;
          const toMatches = fact.to === opts.to || fact.toMuxed === opts.to;
          if (opts.to !== undefined && !toMatches) continue;
          out.push(fact);
        }
        // A short page is the last one; only then is the history exhausted.
        if (page.records.length < this.pageSize) {
          return ok({ payments: out, truncated: false });
        }
        if (read >= this.maxPages) return ok({ payments: out, truncated: true });
        page = await page.next();
      }
    } catch (err: unknown) {
      if (isNotFound(err)) return ok({ payments: [], truncated: false });
      return horizonFailure(`list payments from ${source}`, err);
    }
  }
}

function toPaymentFact(r: HorizonPaymentLike): PaymentFact | undefined {
  const tx = r.transaction_attr;
  if (!tx) return undefined;
  const ledger = typeof tx.ledger_attr === "number" ? tx.ledger_attr : tx.ledger;
  if (typeof ledger !== "number") return undefined;
  return {
    id: r.id,
    type: r.type as PaymentFact["type"],
    transactionHash: r.transaction_hash,
    ledger,
    createdAt: r.created_at,
    from: r.from ?? "",
    to: r.to ?? "",
    ...(r.to_muxed && { toMuxed: r.to_muxed }),
    asset_type: r.asset_type ?? "",
    ...(r.asset_code && { asset_code: r.asset_code }),
    ...(r.asset_issuer && { asset_issuer: r.asset_issuer }),
    amount: r.amount ?? "0",
    memoType: tx.memo_type,
    ...(tx.memo !== undefined && { memo: tx.memo }),
  };
}

export type AccountInspectorLike =
  | { account(id: string): Promise<Outcome<AccountFacts | undefined>> }
  | { loadAccount(id: string): Promise<HorizonAccountResponseLike> }
  | AccountInspector;

export interface BalanceCheckOptions {
  /** The fee to check against, in XLM decimal string (defaults to StellarSettlementSubmitter.fee). */
  readonly fee?: string;
  /** Base reserve per entry, in XLM decimal string (defaults to "0.5"). */
  readonly baseReserve?: string;
}

/**
 * Gate check: verifies that our signing account has sufficient balance to cover the payment
 * amount, settlement fee, and minimum reserve requirement before signing or submitting to chain.
 *
 * Checks:
 * 1. Bridge asset: bridge_balance − bridge_selling_liabilities ≥ amount
 * 2. XLM: xlm_balance − xlm_selling_liabilities − minimum_reserve ≥ fee (+ amount when bridge asset is XLM)
 *
 * Minimum reserve formula:
 * (2 + subentry_count + num_sponsoring − num_sponsored) × base_reserve
 * All math strictly uses scaled BigInts; floats are never used.
 *
 * Refusal returns `PRESETTLE_INSUFFICIENT_FUNDS` with required vs available in `detail`.
 *
 * Note: A concurrent-payments budget (two runs racing for one balance) is out of scope.
 */
export function balanceCheck(
  inspector: AccountInspectorLike,
  signerPublicKey: string,
  opts: BalanceCheckOptions = {},
): GateCheck {
  return {
    name: "chain.balance",
    async run(ctx: GateContext): Promise<CheckResult> {
      const start = Date.now();

      let facts: AccountFacts | undefined;
      try {
        if ("account" in inspector && typeof inspector.account === "function") {
          const outcome = await inspector.account(signerPublicKey);
          if (!outcome.ok) {
            return {
              name: "chain.balance",
              passed: false,
              code: "SETTLEMENT_FAILED",
              detail: `failed to inspect account ${signerPublicKey}: ${outcome.error.message}`,
              durationMs: Date.now() - start,
            };
          }
          facts = outcome.value;
        } else if ("loadAccount" in inspector && typeof inspector.loadAccount === "function") {
          facts = toAccountFacts(
            await inspector.loadAccount(signerPublicKey),
            signerPublicKey,
          );
        } else {
          return {
            name: "chain.balance",
            passed: false,
            code: "SETTLEMENT_FAILED",
            detail: "invalid AccountInspector instance",
            durationMs: Date.now() - start,
          };
        }
      } catch (err: unknown) {
        if (isNotFound(err)) {
          facts = undefined;
        } else {
          return {
            name: "chain.balance",
            passed: false,
            code: "SETTLEMENT_FAILED",
            detail: `failed to inspect account ${signerPublicKey}: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - start,
          };
        }
      }

      if (!facts) {
        return {
          name: "chain.balance",
          passed: false,
          code: "PRESETTLE_INSUFFICIENT_FUNDS",
          detail: `account ${signerPublicKey} does not exist on-chain`,
          durationMs: Date.now() - start,
        };
      }

      const baseReserveStr = opts.baseReserve ?? "0.5";
      const baseReserveScaled = toScaled(baseReserveStr, STROOP_SCALE);
      if (!baseReserveScaled.ok) {
        return {
          name: "chain.balance",
          passed: false,
          code: "AMOUNT_INVALID",
          detail: `invalid base reserve amount: "${baseReserveStr}"`,
          durationMs: Date.now() - start,
        };
      }

      const feeStr = opts.fee ?? StellarSettlementSubmitter.fee;
      const feeScaled = toScaled(feeStr, STROOP_SCALE);
      if (!feeScaled.ok) {
        return {
          name: "chain.balance",
          passed: false,
          code: "AMOUNT_INVALID",
          detail: `invalid fee amount: "${feeStr}"`,
          durationMs: Date.now() - start,
        };
      }

      // Minimum reserve formula: (2 + subentry_count + num_sponsoring - num_sponsored) * base_reserve
      const entries =
        2n +
        BigInt(facts.subentry_count ?? 0) +
        BigInt(facts.num_sponsoring ?? 0) -
        BigInt(facts.num_sponsored ?? 0);
      const effectiveEntries = entries < 0n ? 0n : entries;
      const minReserveScaled = effectiveEntries * baseReserveScaled.value;
      const minReserveStr = fromScaled(minReserveScaled, STROOP_SCALE);

      // Extract XLM balance & selling liabilities
      const nativeBal = facts.balances.find(
        (b) => b.asset_type === "native" || b.asset_code?.toUpperCase() === "XLM",
      );
      const xlmBalanceStr = nativeBal?.balance ?? "0";
      const xlmSellingLiabilitiesStr = nativeBal?.selling_liabilities ?? "0";

      const xlmBalScaled = toScaled(xlmBalanceStr, STROOP_SCALE);
      const xlmLiabScaled = toScaled(xlmSellingLiabilitiesStr, STROOP_SCALE);
      if (!xlmBalScaled.ok || !xlmLiabScaled.ok) {
        return {
          name: "chain.balance",
          passed: false,
          code: "AMOUNT_INVALID",
          detail: "invalid XLM balance or liabilities on account",
          durationMs: Date.now() - start,
        };
      }

      // available XLM = xlm_balance - xlm_selling_liabilities - minimum_reserve
      const availableXlmScaled = xlmBalScaled.value - xlmLiabScaled.value - minReserveScaled;
      const availableXlmStr = fromScaled(availableXlmScaled, STROOP_SCALE);

      const bridgeAssetCode = ctx.corridor.settlement.bridge_asset;
      const bridgeAssetIssuer = ctx.corridor.settlement.asset_issuer;
      const amountStr = ctx.quote?.sourceAmount?.amount ?? ctx.intent.sourceAmount.amount;
      const amountScaled = toScaled(amountStr, STROOP_SCALE);
      if (!amountScaled.ok) {
        return {
          name: "chain.balance",
          passed: false,
          code: "AMOUNT_INVALID",
          detail: `invalid settlement amount: "${amountStr}"`,
          durationMs: Date.now() - start,
        };
      }

      const isXlmBridge =
        bridgeAssetCode.toUpperCase() === "XLM" || bridgeAssetCode.toLowerCase() === "native";

      if (isXlmBridge) {
        // When bridge asset is XLM, available XLM must cover fee + amount
        const requiredXlmScaled = amountScaled.value + feeScaled.value;
        const requiredXlmStr = fromScaled(requiredXlmScaled, STROOP_SCALE);

        if (availableXlmScaled < requiredXlmScaled) {
          return {
            name: "chain.balance",
            passed: false,
            code: "PRESETTLE_INSUFFICIENT_FUNDS",
            detail:
              `insufficient XLM: required ${requiredXlmStr} (${amountStr} amount + ${feeStr} fee against available after reserve ${minReserveStr}), ` +
              `available ${availableXlmStr} (balance ${xlmBalanceStr} - selling liabilities ${xlmSellingLiabilitiesStr} - minimum reserve ${minReserveStr})`,
            durationMs: Date.now() - start,
          };
        }

        return {
          name: "chain.balance",
          passed: true,
          detail:
            `balance covers XLM amount ${amountStr} and fee ${feeStr} after minimum reserve ${minReserveStr} ` +
            `(required ${requiredXlmStr}, available ${availableXlmStr})`,
          durationMs: Date.now() - start,
        };
      }

      // Non-XLM bridge asset
      const bridgeBal = facts.balances.find((b) => {
        if (b.asset_type === "native") return false;
        if (b.asset_code?.toUpperCase() !== bridgeAssetCode.toUpperCase()) return false;
        if (bridgeAssetIssuer && b.asset_issuer && b.asset_issuer !== bridgeAssetIssuer) {
          return false;
        }
        return true;
      });

      const bridgeBalanceStr = bridgeBal?.balance ?? "0";
      const bridgeSellingLiabilitiesStr = bridgeBal?.selling_liabilities ?? "0";
      const bridgeBalScaled = toScaled(bridgeBalanceStr, STROOP_SCALE);
      const bridgeLiabScaled = toScaled(bridgeSellingLiabilitiesStr, STROOP_SCALE);
      if (!bridgeBalScaled.ok || !bridgeLiabScaled.ok) {
        return {
          name: "chain.balance",
          passed: false,
          code: "AMOUNT_INVALID",
          detail: `invalid ${bridgeAssetCode} balance or liabilities on account`,
          durationMs: Date.now() - start,
        };
      }

      const availableBridgeScaled = bridgeBalScaled.value - bridgeLiabScaled.value;
      const availableBridgeStr = fromScaled(availableBridgeScaled, STROOP_SCALE);

      if (availableBridgeScaled < amountScaled.value) {
        return {
          name: "chain.balance",
          passed: false,
          code: "PRESETTLE_INSUFFICIENT_FUNDS",
          detail:
            `insufficient ${bridgeAssetCode}: required ${amountStr}, available ${availableBridgeStr} ` +
            `(balance ${bridgeBalanceStr} - selling liabilities ${bridgeSellingLiabilitiesStr})`,
          durationMs: Date.now() - start,
        };
      }

      if (availableXlmScaled < feeScaled.value) {
        return {
          name: "chain.balance",
          passed: false,
          code: "PRESETTLE_INSUFFICIENT_FUNDS",
          detail:
            `insufficient XLM for fee and reserve: required ${feeStr}, available ${availableXlmStr} ` +
            `(balance ${xlmBalanceStr} - selling liabilities ${xlmSellingLiabilitiesStr} - minimum reserve ${minReserveStr})`,
          durationMs: Date.now() - start,
        };
      }

      return {
        name: "chain.balance",
        passed: true,
        detail:
          `balance covers ${bridgeAssetCode} amount ${amountStr} (available: ${availableBridgeStr}) ` +
          `and XLM fee ${feeStr} + minimum reserve ${minReserveStr} (available XLM: ${availableXlmStr})`,
        durationMs: Date.now() - start,
      };
    },
  };
}
