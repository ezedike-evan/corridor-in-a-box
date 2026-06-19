// Durable idempotency store backed by SQL (Postgres). In-memory is fine for
// tests/examples; production needs a row per idempotencyKey that survives a
// crash, with optimistic concurrency on `version` so two workers can't advance
// the same payment past each other.
//
// We depend only on a tiny `Queryable` shape rather than the `pg` package, so the
// open library doesn't force a driver on consumers — pass your `pg.Pool` (it
// satisfies this structurally) or any compatible client.

import type { IdempotencyStore, StoredRun } from "./idempotency";
import type { CorridorState } from "./state";

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** DDL for the runs table. Run once at startup (or via your migration tool). */
export const CREATE_TABLE_SQL = `
create table if not exists corridor_runs (
  idempotency_key text primary key,
  corridor_id     text not null,
  state           text not null,
  version         integer not null,
  transaction_id  text,
  quote_id        text,
  stellar_tx_hash text,
  last_error      text,
  updated_at      timestamptz not null default now()
);`;

export async function migrate(db: Queryable): Promise<void> {
  await db.query(CREATE_TABLE_SQL);
}

interface Row {
  idempotency_key: string;
  corridor_id: string;
  state: string;
  version: number;
  transaction_id: string | null;
  quote_id: string | null;
  stellar_tx_hash: string | null;
  last_error: string | null;
}

function toRun(r: Row): StoredRun {
  return {
    idempotencyKey: r.idempotency_key,
    corridorId: r.corridor_id,
    state: r.state as CorridorState,
    version: r.version,
    transactionId: r.transaction_id ?? undefined,
    quoteId: r.quote_id ?? undefined,
    stellarTxHash: r.stellar_tx_hash ?? undefined,
    lastError: r.last_error ?? undefined,
  };
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Atomically claim a key for a new run. `ON CONFLICT DO NOTHING` makes the
   * insert a no-op when the key already exists; `RETURNING` then tells us whether
   * a row was actually written. A `false` return means another worker already
   * owns this key — the caller must NOT proceed to settle. This is the gate that
   * closes the get()-then-insert race where two concurrent callers could both
   * start (and both settle) the same payment.
   */
  async create(run: StoredRun): Promise<boolean> {
    const res = await this.db.query<{ idempotency_key: string }>(
      `insert into corridor_runs
         (idempotency_key, corridor_id, state, version, transaction_id,
          quote_id, stellar_tx_hash, last_error, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (idempotency_key) do nothing
       returning idempotency_key`,
      [
        run.idempotencyKey,
        run.corridorId,
        run.state,
        run.version,
        run.transactionId ?? null,
        run.quoteId ?? null,
        run.stellarTxHash ?? null,
        run.lastError ?? null,
      ],
    );
    return res.rows.length > 0;
  }

  async get(key: string): Promise<StoredRun | undefined> {
    const res = await this.db.query<Row>(
      `select idempotency_key, corridor_id, state, version, transaction_id,
              quote_id, stellar_tx_hash, last_error
         from corridor_runs where idempotency_key = $1`,
      [key],
    );
    const row = res.rows[0];
    return row ? toRun(row) : undefined;
  }

  /**
   * Upsert with optimistic concurrency: a write only lands if it carries a
   * strictly higher `version` than what's stored. A stale writer (e.g. a
   * resumed-then-superseded worker) is silently ignored, which is exactly the
   * double-advance protection we want.
   */
  async put(run: StoredRun): Promise<void> {
    await this.db.query(
      `insert into corridor_runs
         (idempotency_key, corridor_id, state, version, transaction_id,
          quote_id, stellar_tx_hash, last_error, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (idempotency_key) do update set
         state           = excluded.state,
         version         = excluded.version,
         transaction_id  = excluded.transaction_id,
         quote_id        = excluded.quote_id,
         stellar_tx_hash = excluded.stellar_tx_hash,
         last_error      = excluded.last_error,
         updated_at      = now()
       where corridor_runs.version < excluded.version`,
      [
        run.idempotencyKey,
        run.corridorId,
        run.state,
        run.version,
        run.transactionId ?? null,
        run.quoteId ?? null,
        run.stellarTxHash ?? null,
        run.lastError ?? null,
      ],
    );
  }
}
