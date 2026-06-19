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
  lastError?: string;
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
