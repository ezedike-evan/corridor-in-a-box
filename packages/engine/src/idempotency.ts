// Idempotency — the guarantee that the same idempotencyKey never settles twice.
//
// The `version` field is what reconciliation keys on: each state transition bumps
// it, so an external observer (or a resumed run) can tell which step a payment
// reached without re-deriving it.
//
// InMemoryIdempotencyStore is for tests/examples. In production back this with
// Postgres (a row per idempotencyKey, optimistic concurrency on `version`).

import type { CorridorState } from "./state";

export interface StoredRun {
  readonly idempotencyKey: string;
  readonly corridorId: string;
  state: CorridorState;
  version: number;
  transactionId?: string;
  quoteId?: string;
  stellarTxHash?: string;
  /**
   * Identifier of a refund already requested for this run — the refund leg's
   * own reference, not the settlement's.
   *
   * Without it a run knows whether the payment went out but not whether a
   * refund did, which is the same class of bug the idempotency gate exists to
   * prevent: a process that crashes after requesting a refund and resumes with
   * no record of having done so requests a *second* one. Not settling twice,
   * but money moving twice all the same.
   *
   * Set once, when a refund is first successfully requested, and treated as
   * immutable thereafter — the refund request path reads it and refuses to
   * issue another.
   */
  refundId?: string;
  lastError?: string;
  /**
   * Opaque tenant id that owns this run, so a read can be scoped to its creator.
   * Set by the caller from an already-VALIDATED credential — never from a
   * request body. Undefined when the deployment runs without auth, in which case
   * no scoping is possible and every run is readable by anyone who can reach the
   * service.
   */
  readonly owner?: string;
}

/**
 * True when a refund has already been requested for this run.
 *
 * The one question the refund request path must ask before issuing another,
 * and the reason `refundId` is persisted at all: a process that crashes after
 * requesting a refund and resumes without this evidence sends the money back
 * twice.
 *
 * A predicate rather than an inline `!run.refundId` so the rule has a name and
 * a test of its own — this is the gate, not a null check.
 */
export function hasRequestedRefund(run: Pick<StoredRun, "refundId">): boolean {
  return run.refundId !== undefined && run.refundId !== "";
}

export interface IdempotencyStore {
  get(key: string): Promise<StoredRun | undefined>;
  put(run: StoredRun): Promise<void>;
  /**
   * Atomically claim a key for a brand-new run. Returns `true` if THIS caller
   * inserted the row, `false` if a row for the key already existed. This is the
   * gate that stops two concurrent callers from both passing a `get()`-then-act
   * check and each settling the same payment. `put()`'s version guard only stops
   * the stored row from going backwards; it does not stop two in-flight runs —
   * `create()` does.
   */
  create(run: StoredRun): Promise<boolean>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, StoredRun>();

  async get(key: string): Promise<StoredRun | undefined> {
    const r = this.map.get(key);
    return r ? { ...r } : undefined;
  }

  async put(run: StoredRun): Promise<void> {
    this.map.set(run.idempotencyKey, { ...run });
  }

  // Single-threaded JS: the has/set pair has no await between them, so this is
  // an atomic test-and-set — the in-memory analogue of INSERT … ON CONFLICT.
  async create(run: StoredRun): Promise<boolean> {
    if (this.map.has(run.idempotencyKey)) return false;
    this.map.set(run.idempotencyKey, { ...run });
    return true;
  }
}
