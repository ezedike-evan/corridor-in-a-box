// The seam between "money is about to move" and "money moves". A pre-settle
// check needs data from several places — the anchor (SEP-31/SEP-12), Horizon,
// the registry — so it cannot live in one adapter; it needs its own port. It
// stays protocol-agnostic so non-SEP-31 adapters can supply checks too:
// GateCheck implementations live in the packages that know their protocol
// (@corridor/sep31, @corridor/stellar), never here.

import type { Corridor } from "@corridor/manifest";
import type { OpenTransaction, Quote } from "@corridor/adapter-kit";
import type { CorridorErrorCode, PaymentIntent } from "@corridor/types";

export interface GateContext {
  readonly intent: PaymentIntent;
  readonly corridor: Corridor;
  readonly quote: Quote;
  readonly opened: OpenTransaction;
  readonly now: number;
  readonly attempt: number;
}

export interface CheckResult {
  /** e.g. "chain.balance" or "sep31.info.asset" */
  readonly name: string;
  readonly passed: boolean;
  /** Required when !passed. */
  readonly code?: CorridorErrorCode;
  /** Human-readable, safe to log (no PII). */
  readonly detail: string;
  readonly durationMs: number;
}

export interface GateCheck {
  readonly name: string;
  run(ctx: GateContext): Promise<CheckResult>;
}

export interface PreSettleGate {
  evaluate(ctx: GateContext): Promise<{ passed: boolean; results: CheckResult[] }>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Runs every check concurrently and reports every result — it never
 * short-circuits on the first failure, so the audit trail shows the whole
 * picture. Fails closed: a check that throws, rejects, or runs past
 * `timeoutMs` is recorded as a failing result (never lets the whole
 * evaluation reject), so a broken check blocks settlement instead of
 * silently waving it through.
 */
export class CompositeGate implements PreSettleGate {
  private readonly checks: readonly GateCheck[];
  private readonly timeoutMs: number;

  constructor(checks: GateCheck[], opts: { timeoutMs?: number } = {}) {
    this.checks = checks;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async evaluate(ctx: GateContext): Promise<{ passed: boolean; results: CheckResult[] }> {
    const results = await Promise.all(this.checks.map((check) => this.runOne(check, ctx)));
    return { passed: results.every((r) => r.passed), results };
  }

  private async runOne(check: GateCheck, ctx: GateContext): Promise<CheckResult> {
    const begin = Date.now();
    try {
      return await withTimeout(check.run(ctx), this.timeoutMs, check.name);
    } catch (e) {
      return {
        name: check.name,
        passed: false,
        code: "SETTLEMENT_FAILED",
        detail: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - begin,
      };
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gate check "${name}" exceeded ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
