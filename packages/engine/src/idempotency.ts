// Idempotency — the guarantee that the same idempotencyKey never settles twice.
//
// The `version` field is what reconciliation keys on: each state transition bumps
// it, so an external observer (or a resumed run) can tell which step a payment
// reached without re-deriving it. Same pattern as Numio's version field.
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
}
