// The corridor circuit breaker. A lane whose anchor stops answering should
// stop accepting money after a handful of consecutive lane-level failures,
// instead of settling payment after payment into the same broken leg until a
// human happens to read a dashboard.
//
// Two decisions live here and are deliberately separated:
//
//   1. WHICH run outcomes count. `breakerOutcomeFor` is a pure function of the
//      terminal state plus the error code, so "does this failure mean the lane
//      is unhealthy" is answerable without a database and is unit-testable as
//      such. Most pre-settle refusals are about the request — a quote that
//      expired, a KYC rejection, an amount outside the anchor's limits — and
//      must never take a lane down. A reconcile that stalled with money already
//      on the chain is exactly the signal we want to stop on. See
//      `LANE_FAILURE_CODES` for the full argument.
//
//   2. WHERE the count is kept. `CorridorHealthStore` is a port. The in-memory
//      implementation is right for a single process and for tests; the Postgres
//      one (breaker-pg.ts) is what production uses, because a per-replica
//      breaker would let one healthy replica keep taking payments on a lane
//      another replica has already halted.
//
// The breaker is STICKY. There is no half-open probe: a lane that tripped stays
// tripped until a person records why it was safe to reopen. That is the whole
// point — an automatic reopen just moves the outage later and hides it.

import type { CorridorError, CorridorErrorCode } from "@corridor/types";
import type { CorridorState } from "./state";
import { noopMetrics, type Metrics } from "./observability";

/** Threshold used when a caller does not pass one (and the manifest default). */
export const DEFAULT_BREAKER_THRESHOLD = 3;

/** `closed` = accepting payments. `open` = halted until a human resets it. */
export type BreakerState = "closed" | "open";

/**
 * What a finished run means for the lane's health.
 *
 * `neutral` is the important one: most failures are not evidence about the
 * lane. It is not recorded at all.
 */
export type BreakerOutcome = "success" | "failure" | "neutral";

/** One corridor's breaker row. `undefined` fields mean "never happened". */
export interface BreakerRecord {
  readonly corridorId: string;
  readonly state: BreakerState;
  /** Consecutive counted failures. Reset to 0 by a `success`. */
  readonly consecutiveFailures: number;
  /** When the lane tripped. Set once, on the transition into `open`. */
  readonly trippedAt?: number;
  /** The error text of the failure that tripped (or last failed) the lane. */
  readonly lastError?: string;
  /** Who reopened the lane, and why. Kept as history even after later failures. */
  readonly resetBy?: string;
  readonly resetReason?: string;
  readonly resetAt?: number;
  readonly updatedAt: number;
}

/**
 * Durable breaker state. Deliberately a *counter plus a state*, not a rolling
 * window: "this lane is broken right now" is the question an operator asks, and
 * a window would answer "mostly fine" during exactly the incident it exists for.
 */
export interface CorridorHealthStore {
  /** The lane's current breaker row, or `undefined` if it has never failed. */
  get(corridorId: string): Promise<BreakerRecord | undefined>;
  /**
   * Record a finished run and return the row as it now stands.
   *
   * `threshold` travels per call rather than being configured on the store
   * because one store holds every lane and each manifest sets its own
   * (`recovery.breaker.consecutive_failures`). `error` is the text shown to
   * whoever reads `corridor breaker status` next; it is stored verbatim, so
   * callers should not put secrets in it.
   */
  recordOutcome(
    corridorId: string,
    outcome: Exclude<BreakerOutcome, "neutral">,
    at: number,
    opts: RecordOutcomeOptions,
  ): Promise<BreakerRecord>;
  /**
   * Deliberate human reopen. `by` and `reason` are stored permanently: the next
   * person to trip this lane needs to know who last cleared it and on what
   * evidence, and "someone ran a command" is not that.
   */
  reset(corridorId: string, by: string, reason: string, at?: number): Promise<BreakerRecord>;
  /** Every lane with a row, for `corridor breaker status`. */
  list(): Promise<readonly BreakerRecord[]>;
}

export interface RecordOutcomeOptions {
  /** Consecutive failures at which the lane trips. Always >= 1. */
  readonly threshold: number;
  /** Free text describing the failure, kept as `lastError`. */
  readonly error?: string;
}

// --- Which failures count ------------------------------------------------

/**
 * Error codes that mean "this lane is unhealthy", as opposed to "this request
 * was bad" or "this is how the system is designed".
 *
 * `REFUND_UNSUPPORTED` is deliberately absent. It is what a parked run reports
 * when the refund port refuses, and that refusal is a design invariant (on-chain
 * payments are final), not an outage — docs/operations.md §2 says so, and
 * tripping a lane over it would halt every corridor that has ever parked a
 * payment. A run that got there via `holdAndStop` passes the ORIGINAL failure
 * code instead, so the reconcile/settlement problem still counts.
 *
 * Pre-settle codes are listed one by one rather than matched on the
 * `PRESETTLE_` prefix, and the distinction is not cosmetic. Most pre-settle
 * refusals are about the request, not the lane: an amount outside the anchor's
 * limits, a quote too short-lived to survive settle plus confirm, a receiver
 * whose SEP-12 status is no longer ACCEPTED. None of those get better if the
 * lane halts, so counting them would let ordinary payment errors stop a working
 * corridor and would need a human to reopen it. A prefix test cannot tell those
 * apart from the checks that really do read the chain, and adding a new
 * pre-settle check upstream would silently become a new way to take a lane
 * down. So the set is explicit, and a new pre-settle code is neutral until
 * someone argues otherwise.
 */
const LANE_FAILURE_CODES: ReadonlySet<CorridorErrorCode> = new Set<CorridorErrorCode>([
  "SETTLEMENT_FAILED",
  "SETTLEMENT_TIMEOUT",
  "RECONCILE_MISMATCH",
  "RECONCILE_STALLED",
  // Pre-settle checks that read the chain or the anchor. These are evidence
  // about the lane: our balance cannot cover the payment, the anchor drifted
  // from what it promised, or the transaction it opened is not the one we are
  // about to pay. Any of them means the leg is not working.
  "PRESETTLE_INSUFFICIENT_FUNDS",
  "PRESETTLE_ANCHOR_DRIFT",
  "PRESETTLE_TX_MISMATCH",
  "PRESETTLE_DESTINATION_UNSAFE",
]);

/** Pure classifier: does this terminal run count against the lane? */
export function breakerOutcomeFor(
  state: CorridorState,
  code?: CorridorErrorCode,
): BreakerOutcome {
  if (state === "completed") return "success";
  // Only terminal states carry health information. Everything else is either
  // still in flight or a mid-run step.
  if (state !== "failed" && state !== "held" && state !== "refunded") return "neutral";
  if (code === undefined) return "neutral";
  return LANE_FAILURE_CODES.has(code) ? "failure" : "neutral";
}

/**
 * The failure that sent a run into recovery, as the breaker should judge it when
 * the run is picked up again after a restart. The in-memory error is gone, but
 * the run persisted `lastError` as "CODE: message" before it went anywhere, so
 * the real cause is still there and the lane's stored `lastError` can show it.
 *
 * Only a code the breaker already counts as a lane failure is trusted. Anything
 * else (no `lastError`, one that does not parse, a neutral code such as
 * REFUND_UNSUPPORTED left behind by a later step) falls back to `fallback`, so a
 * resumed run is never judged more leniently than it was before.
 */
export function recoveredBreakerCause(
  lastError: string | undefined,
  fallback: CorridorError,
): CorridorError {
  if (lastError === undefined) return fallback;
  const sep = lastError.indexOf(": ");
  if (sep <= 0) return fallback;
  const code = lastError.slice(0, sep) as CorridorErrorCode;
  if (!LANE_FAILURE_CODES.has(code)) return fallback;
  return { code, message: lastError.slice(sep + 2), retryable: false };
}

/** Does `recordOutcome` transitioning to this row mean "this call tripped it"? */
export function justTripped(record: BreakerRecord, at: number): boolean {
  // `trippedAt` is written once, on the transition into `open`, so matching the
  // call's own timestamp identifies the trip without a read-modify-write race:
  // two replicas failing at once can only produce one `trippedAt`.
  return record.state === "open" && record.trippedAt === at;
}

function closedRecord(corridorId: string, at: number): BreakerRecord {
  return { corridorId, state: "closed", consecutiveFailures: 0, updatedAt: at };
}

// --- In-memory store -----------------------------------------------------

/** Per-process breaker. Correct for one replica and for tests; see the header. */
export class InMemoryCorridorHealthStore implements CorridorHealthStore {
  private readonly rows = new Map<string, BreakerRecord>();

  async get(corridorId: string): Promise<BreakerRecord | undefined> {
    return this.rows.get(corridorId);
  }

  async list(): Promise<readonly BreakerRecord[]> {
    return [...this.rows.values()];
  }

  async recordOutcome(
    corridorId: string,
    outcome: Exclude<BreakerOutcome, "neutral">,
    at: number,
    opts: RecordOutcomeOptions,
  ): Promise<BreakerRecord> {
    const current = this.rows.get(corridorId) ?? closedRecord(corridorId, at);
    let next: BreakerRecord;
    if (outcome === "success") {
      // A completed run is proof the lane works. Clearing the count here is the
      // only thing that makes this a *consecutive*-failure breaker.
      next = { ...current, state: "closed", consecutiveFailures: 0, updatedAt: at };
    } else {
      const consecutiveFailures = current.consecutiveFailures + 1;
      const trips = consecutiveFailures >= opts.threshold;
      next = {
        ...current,
        // Sticky: a failure on an already-open lane leaves it open, so the
        // `tripped` metric fires once per trip and not once per failure.
        state: trips || current.state === "open" ? "open" : "closed",
        consecutiveFailures,
        trippedAt: trips ? (current.trippedAt ?? at) : current.trippedAt,
        lastError: opts.error ?? current.lastError,
        updatedAt: at,
      };
    }
    this.rows.set(corridorId, next);
    return next;
  }

  async reset(
    corridorId: string,
    by: string,
    reason: string,
    at: number = Date.now(),
  ): Promise<BreakerRecord> {
    const next: BreakerRecord = {
      corridorId,
      state: "closed",
      consecutiveFailures: 0,
      // Cleared on reset: a `trippedAt` from before the reset would render as
      // "open since <last week>" on a lane that is running again.
      resetBy: by,
      resetReason: reason,
      resetAt: at,
      updatedAt: at,
    };
    this.rows.set(corridorId, next);
    return next;
  }
}

// --- Metrics -------------------------------------------------------------

/**
 * The three breaker series, named once so the engine, the CLI, the tests and
 * the runbook cannot drift apart. Rendered by PrometheusMetrics as
 * `corridor_breaker_tripped`, `corridor_breaker_refused` and
 * `corridor_breaker_reset`, each labelled `corridor`.
 *
 * Scope of `reset`, stated plainly because it is easy to assume otherwise: the
 * counter only fires when a `MeteredCorridorHealthStore` observes the reset, and
 * Metrics sinks are in-process. `tripped` and `refused` are therefore always
 * correct (the engine trips them), but a reset performed by `corridor breaker
 * reset` runs in a short-lived CLI process whose counter is gone at exit. The
 * authoritative record of who reopened a lane and why is the durable
 * `reset_by` / `reset_reason` / `reset_at` columns, which is what the runbook
 * tells operators to read. Do not build an alert on `corridor_breaker_reset`
 * until a scrape-time collector reads those columns; it is here so a deployment
 * that resets through the service sees the event on its own target.
 */
export const BREAKER_METRICS = {
  tripped: "corridor.breaker.tripped",
  refused: "corridor.breaker.refused",
  reset: "corridor.breaker.reset",
} as const;

/**
 * Wraps any store and reports breaker events to a `Metrics` sink.
 *
 * A decorator rather than ad-hoc `metrics.increment` calls at the call sites so
 * that *every* trip and reset is counted, including ones triggered from code
 * that has no metrics handle — a future HTTP reset endpoint, or the CLI. The
 * refusal counter is not here because a refusal is the gate's decision, not
 * the store's, and it is emitted in run.ts.
 */
export class MeteredCorridorHealthStore implements CorridorHealthStore {
  constructor(
    private readonly inner: CorridorHealthStore,
    private readonly metrics: Metrics = noopMetrics,
  ) {}

  get(corridorId: string): Promise<BreakerRecord | undefined> {
    return this.inner.get(corridorId);
  }

  list(): Promise<readonly BreakerRecord[]> {
    return this.inner.list();
  }

  async recordOutcome(
    corridorId: string,
    outcome: Exclude<BreakerOutcome, "neutral">,
    at: number,
    opts: RecordOutcomeOptions,
  ): Promise<BreakerRecord> {
    const record = await this.inner.recordOutcome(corridorId, outcome, at, opts);
    if (outcome === "failure" && justTripped(record, at)) {
      this.metrics.increment(BREAKER_METRICS.tripped, { corridor: corridorId });
    }
    return record;
  }

  async reset(
    corridorId: string,
    by: string,
    reason: string,
    at?: number,
  ): Promise<BreakerRecord> {
    const record = await this.inner.reset(corridorId, by, reason, at);
    this.metrics.increment(BREAKER_METRICS.reset, { corridor: corridorId });
    return record;
  }
}
