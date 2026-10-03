import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Scalar, YAMLMap, parseDocument, stringify } from "yaml";
import type { Corridor, Proof } from "@corridor/manifest";
import type { RunResult, SettlementRequest } from "@corridor/engine";
import type { PaymentExpectation, TransactionFacts } from "@corridor/stellar";
import { compareAmounts, fail, isSettleableAmount, ok, type Outcome } from "@corridor/types";

/** A first canary is deliberately small until an operator records a lane-specific cap. */
export const DEFAULT_CANARY_MAX_AMOUNT = "1.00";

export interface PaymentVerifier {
  verifyPayment(expectation: PaymentExpectation): Promise<Outcome<TransactionFacts>>;
}

export interface CanarySettlement {
  readonly result: RunResult;
  readonly settlement: SettlementRequest;
}

export interface BuildProofOptions extends CanarySettlement {
  readonly corridor: Corridor;
  readonly verifier: PaymentVerifier;
  readonly now?: Date;
}

export interface FinalizeCanaryOptions extends BuildProofOptions {
  /** Path to the manifest to update. Required when `write` is true. */
  readonly manifestPath?: string;
  readonly write?: boolean;
}

export interface CanaryProofResult {
  readonly proof: Proof;
  readonly transaction: TransactionFacts;
  readonly yaml: string;
  readonly written: boolean;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Verify a completed run against Horizon and turn it into the proof block that
 * earns a corridor the PROVEN liveness tier. This function never trusts
 * RunResult on its own: the destination, amount and memo are read back from the
 * chain before any manifest write is attempted.
 */
export async function buildCanaryProof(
  opts: BuildProofOptions,
): Promise<Outcome<CanaryProofResult>> {
  const { result, settlement, corridor, verifier } = opts;
  if (result.state !== "completed") {
    return fail(
      "SETTLEMENT_FAILED",
      `canary ended in "${result.state}", not "completed"; no proof was written`,
    );
  }
  if (!result.transactionId || !result.stellarTxHash) {
    return fail(
      "SETTLEMENT_FAILED",
      "completed canary is missing its anchor id or Stellar tx hash",
    );
  }
  if (!isSettleableAmount(settlement.amount.amount)) {
    return fail(
      "AMOUNT_INVALID",
      `canary settlement amount "${settlement.amount.amount}" is invalid`,
    );
  }

  const cap = corridor.proof?.canary_max_amount ?? DEFAULT_CANARY_MAX_AMOUNT;
  const capComparison = compareAmounts(settlement.amount.amount, cap);
  if (!capComparison.ok) return capComparison;
  if (capComparison.value > 0) {
    return fail(
      "AMOUNT_INVALID",
      `canary amount ${settlement.amount.amount} exceeds the proof ceiling ${cap}`,
    );
  }

  const verified = await verifier.verifyPayment({
    hash: result.stellarTxHash,
    to: settlement.to,
    amount: settlement.amount.amount,
    memo: settlement.memo,
    memoType: settlement.memoType,
    assetCode: corridor.settlement.bridge_asset,
    assetIssuer: corridor.settlement.asset_issuer,
  });
  if (!verified.ok) return verified;

  const proof: Proof = {
    canary_completed_at: isoDate(opts.now ?? new Date()),
    stellar_tx_hash: result.stellarTxHash.toLowerCase(),
    anchor_transaction_id: result.transactionId,
    amount: settlement.amount.amount,
    max_age_days: corridor.proof?.max_age_days ?? 30,
    canary_max_amount: cap,
  };
  const yaml = stringify({ proof }).trimEnd();

  return ok({ proof, transaction: verified.value, yaml, written: false });
}

/** Update only the proof node, leaving every existing comment in place. */
export function writeProofManifest(path: string, proof: Proof): void {
  const source = readFileSync(path, "utf8");
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`cannot parse manifest ${path}: ${document.errors.join("; ")}`);
  }
  const alreadyHadProof =
    document.contents instanceof YAMLMap && document.contents.has("proof");

  // `set` replaces an existing proof in place, so a second canary refreshes the
  // evidence rather than appending a second block. The date is quoted to match
  // how endpoints_verified_at is written by hand.
  const node = new YAMLMap<unknown, unknown>();
  const date = new Scalar(proof.canary_completed_at);
  date.type = Scalar.QUOTE_DOUBLE;
  node.set("canary_completed_at", date);
  node.set("stellar_tx_hash", proof.stellar_tx_hash);
  node.set("anchor_transaction_id", proof.anchor_transaction_id);
  node.set("amount", proof.amount);
  node.set("max_age_days", proof.max_age_days);
  node.set("canary_max_amount", proof.canary_max_amount);
  document.set("proof", node);

  // flowCollectionPadding/lineWidth keep the rewritten file byte-compatible
  // with this repo's prettier settings, so a manifest a canary touched still
  // passes `pnpm lint`.
  let output = document.toString({ flowCollectionPadding: false, lineWidth: 0 });
  if (!alreadyHadProof) {
    // Give a freshly appended block its own paragraph instead of gluing it onto
    // the last line of the manifest.
    output = output.replace(/\n(proof:\n)/, "\n\n$1");
  }

  // Write-then-rename: a reader never sees a half-written manifest, and a
  // crash mid-write leaves the original intact.
  const temporary = `${path}.canary-${process.pid}.tmp`;
  writeFileSync(temporary, output, "utf8");
  renameSync(temporary, path);
}

/**
 * Finalize a canary. The terminal-state guard is deliberately the first thing
 * that happens: a failed, held or refunded run must leave the manifest
 * byte-identical, and must not even parse or rewrite it.
 */
export async function finalizeCanary(
  opts: FinalizeCanaryOptions,
): Promise<Outcome<CanaryProofResult>> {
  if (opts.result.state !== "completed") {
    return fail(
      "SETTLEMENT_FAILED",
      `canary ended in "${opts.result.state}", not "completed"; manifest was not changed`,
    );
  }

  const built = await buildCanaryProof(opts);
  if (!built.ok) return built;
  if (!opts.write) return built;

  if (!opts.manifestPath) {
    return fail("MANIFEST_INVALID", "--write requires a manifest path");
  }
  try {
    writeProofManifest(opts.manifestPath, built.value.proof);
  } catch (cause) {
    return fail(
      "MANIFEST_INVALID",
      `could not write proof to ${opts.manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return ok({ ...built.value, written: true });
}
