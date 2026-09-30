// Durable idempotency store backed by SQL (Postgres). In-memory is fine for
// tests/examples; production needs a row per idempotencyKey that survives a
// crash, with optimistic concurrency on `version` so two workers can't advance
// the same payment past each other.
//
// We depend only on a tiny `Queryable` shape rather than the `pg` package, so the
// open library doesn't force a driver on consumers — pass your `pg.Pool` (it
// satisfies this structurally) or any compatible client.

import type { IdempotencyStore, ListRunsOptions, OutOfBandResolution, StoredRun } from "./idempotency";
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
  refund_id       text,
  last_error      text,
  owner           text,
  updated_at      timestamptz not null default now()
);`;

export const CREATE_RESOLUTIONS_TABLE_SQL = `
create table if not exists corridor_resolutions (
  idempotency_key text primary key references corridor_runs(idempotency_key),
  outcome         text not null check (outcome in ('refunded-offchain', 'paid-out-manually', 'written-off')),
  note            text not null,
  resolved_by     text not null,
  resolved_at     timestamptz not null
);`;

/** Additive migrations for tables created by an earlier version. `add column if
 *  not exists` is a no-op on a fresh table and the upgrade path on an existing
 *  one — without this, a deployment that predates run ownership would keep
 *  serving unscoped reads because the column silently isn't there. */
const ALTER_TABLE_SQL = [
  `alter table corridor_runs add column if not exists owner text;`,
  // Same reasoning as `owner`: a deployment created before refund state existed
  // must pick this up on migrate(), or every resumed run there would still have
  // no record of a refund it already requested.
  `alter table corridor_runs add column if not exists refund_id text;`,
];

export async function migrate(db: Queryable): Promise<void> {
  await db.query(CREATE_TABLE_SQL);
  await db.query(CREATE_RESOLUTIONS_TABLE_SQL);
  for (const sql of ALTER_TABLE_SQL) await db.query(sql);
}

interface Row {
  idempotency_key: string;
  corridor_id: string;
  state: string;
  version: number;
  transaction_id: string | null;
  quote_id: string | null;
  stellar_tx_hash: string | null;
  refund_id: string | null;
  last_error: string | null;
  owner: string | null;
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
    refundId: r.refund_id ?? undefined,
    lastError: r.last_error ?? undefined,
    owner: r.owner ?? undefined,
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
          quote_id, stellar_tx_hash, refund_id, last_error, owner, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
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
        run.refundId ?? null,
        run.lastError ?? null,
        run.owner ?? null,
      ],
    );
    return res.rows.length > 0;
  }

  async get(key: string): Promise<StoredRun | undefined> {
    const res = await this.db.query<Row>(
      `select idempotency_key, corridor_id, state, version, transaction_id,
              quote_id, stellar_tx_hash, refund_id, last_error, owner
         from corridor_runs where idempotency_key = $1`,
      [key],
    );
    const row = res.rows[0];
    return row ? toRun(row) : undefined;
  }

  async listByState(state: CorridorState, options: ListRunsOptions = {}): Promise<StoredRun[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const params: unknown[] = [state];
    const corridor = options.corridorId ? "and corridor_id = $2" : "";
    if (options.corridorId) params.push(options.corridorId);
    params.push(limit);
    const limitParam = `$${params.length}`;
    const result = await this.db.query<Row>(
      `select idempotency_key, corridor_id, state, version, transaction_id,
              quote_id, stellar_tx_hash, refund_id, last_error, owner
         from corridor_runs where state = $1 ${corridor}
        order by updated_at desc, idempotency_key asc limit ${limitParam}`,
      params,
    );
    return result.rows.map(toRun);
  }

  async getResolution(key: string): Promise<OutOfBandResolution | undefined> {
    const result = await this.db.query<{
      idempotency_key: string;
      outcome: OutOfBandResolution["outcome"];
      note: string;
      resolved_by: string;
      resolved_at: Date | string;
    }>(
      `select idempotency_key, outcome, note, resolved_by, resolved_at
         from corridor_resolutions where idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row
      ? {
          idempotencyKey: row.idempotency_key,
          outcome: row.outcome,
          note: row.note,
          resolvedBy: row.resolved_by,
          resolvedAt: new Date(row.resolved_at).getTime(),
        }
      : undefined;
  }

  async recordResolution(resolution: OutOfBandResolution): Promise<boolean> {
    const result = await this.db.query<{ idempotency_key: string }>(
      `insert into corridor_resolutions (idempotency_key, outcome, note, resolved_by, resolved_at)
       select $1, $2, $3, $4, to_timestamp($5 / 1000.0)
        where exists (
          select 1 from corridor_runs where idempotency_key = $1 and state = 'held'
        )
       on conflict (idempotency_key) do nothing
       returning idempotency_key`,
      [resolution.idempotencyKey, resolution.outcome, resolution.note, resolution.resolvedBy, resolution.resolvedAt],
    );
    return result.rows.length > 0;
  }

  /**
   * Upsert with optimistic concurrency: a write only lands if it carries a
   * strictly higher `version` than what's stored. A stale writer (e.g. a
   * resumed-then-superseded worker) is silently ignored, which is exactly the
   * double-advance protection we want.
   *
   * `owner` is deliberately absent from the `do update set` list: ownership is
   * established once by create() and must be immutable thereafter, or a later
   * write could quietly reassign a run to a different tenant.
   *
   * `refund_id` is coalesced rather than overwritten, for the same reason one
   * step further on: once a refund has been requested, the stored id is the
   * evidence that stops a second request. A writer that lost it (an older
   * in-memory copy of the run, say) must not be able to erase it — a *second*
   * refund id would mean money moved twice.
   */
  async put(run: StoredRun): Promise<void> {
    await this.db.query(
      `insert into corridor_runs
         (idempotency_key, corridor_id, state, version, transaction_id,
          quote_id, stellar_tx_hash, refund_id, last_error, owner, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       on conflict (idempotency_key) do update set
         state           = excluded.state,
         version         = excluded.version,
         transaction_id  = excluded.transaction_id,
         quote_id        = excluded.quote_id,
         stellar_tx_hash = excluded.stellar_tx_hash,
         refund_id       = coalesce(corridor_runs.refund_id, excluded.refund_id),
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
        run.refundId ?? null,
        run.lastError ?? null,
        run.owner ?? null,
      ],
    );
  }
}
