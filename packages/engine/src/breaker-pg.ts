// Durable circuit-breaker state.
//
// An in-memory breaker is wrong the moment there is more than one replica, and
// both failure modes point the same way: each replica keeps its own count, so a
// lane that failed five times on the replica holding the traffic can still be
// accepted by a peer that saw none of it — the lane keeps taking money while it
// is broken. It is also wrong across restarts, where a lane that tripped an hour
// ago comes back healthy with no record of why.
//
// So the counted state lives in one row per corridor and the increment is a
// single atomic statement. The subtlety is that `consecutive_failures + 1` and
// "did that cross the threshold" must be evaluated in the same statement: a
// read-then-write in application code lets two replicas both read 2, both write
// 3, and neither opens the breaker.
//
// Same tiny `Queryable` seam as idempotency-pg.ts — we depend on the shape, not
// on `pg`, so the library does not force a driver on consumers.

import type { Queryable } from "./idempotency-pg";
import type {
  BreakerOutcome,
  BreakerRecord,
  CorridorHealthStore,
  RecordOutcomeOptions,
} from "./breaker";

/**
 * One row per corridor. `state` is denormalised next to the counter so the gate
 * is a single indexed read on the hot path, and so an operator reading the
 * table sees why a lane is refusing without reconstructing it.
 *
 * The table is created by the engine's single `migrate()` entry point, not
 * here, so one command brings a database up to date.
 */
export const CREATE_BREAKERS_TABLE_SQL = `
create table if not exists corridor_breakers (
  corridor_id          text primary key,
  consecutive_failures integer not null default 0,
  state                text not null default 'closed',
  tripped_at           timestamptz,
  last_error           text,
  reset_by             text,
  reset_reason         text,
  reset_at             timestamptz,
  updated_at           timestamptz not null default now()
);`;

/**
 * In-place upgrade of the stub `corridor_breakers` table that #366's migrate()
 * created (no `reset_at`, default 'up', states 'up'/'down'). All idempotent, so
 * they are safe on a fresh table and on repeated runs. Order matters: the
 * default changes before legacy rows are remapped.
 */
export const BREAKERS_MIGRATION_SQL = [
  `alter table corridor_breakers add column if not exists reset_at timestamptz;`,
  `alter table corridor_breakers alter column state set default 'closed';`,
  `update corridor_breakers set state = 'open' where state = 'down';`,
  `update corridor_breakers set state = 'closed' where state = 'up';`,
];

interface Row {
  corridor_id: string;
  consecutive_failures: number;
  state: string;
  tripped_at: Date | string | null;
  last_error: string | null;
  reset_by: string | null;
  reset_reason: string | null;
  reset_at: Date | string | null;
  updated_at: Date | string | null;
}

function toMs(v: Date | string | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  // `pg` hands back a Date for timestamptz; the string branch keeps this usable
  // against drivers that do not.
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function toRecord(r: Row): BreakerRecord {
  const trippedAt = toMs(r.tripped_at);
  const resetAt = toMs(r.reset_at);
  return {
    corridorId: r.corridor_id,
    // Never trust a `state` string into the union: a row hand-edited in psql
    // must not be able to inject a value the engine's types claim is closed.
    state: r.state === "open" ? "open" : "closed",
    consecutiveFailures: r.consecutive_failures,
    ...(trippedAt !== undefined && { trippedAt }),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    ...(r.reset_by ? { resetBy: r.reset_by } : {}),
    ...(r.reset_reason ? { resetReason: r.reset_reason } : {}),
    ...(resetAt !== undefined && { resetAt }),
    updatedAt: toMs(r.updated_at) ?? 0,
  };
}

const SELECT_COLUMNS = `corridor_id, consecutive_failures, state, tripped_at,
       last_error, reset_by, reset_reason, reset_at, updated_at`;

export class PostgresCorridorHealthStore implements CorridorHealthStore {
  constructor(private readonly db: Queryable) {}

  async get(corridorId: string): Promise<BreakerRecord | undefined> {
    const res = await this.db.query<Row>(
      `select ${SELECT_COLUMNS} from corridor_breakers where corridor_id = $1`,
      [corridorId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : undefined;
  }

  async list(): Promise<readonly BreakerRecord[]> {
    const res = await this.db.query<Row>(
      `select ${SELECT_COLUMNS} from corridor_breakers order by corridor_id`,
    );
    return res.rows.map(toRecord);
  }

  /**
   * Fold one run's outcome into the row, atomically, and return the result.
   *
   * One upsert with the transition logic inside the `case` expressions, so the
   * increment, the threshold test and the `tripped_at` stamp are all evaluated
   * against the same row version. Split into a `select` in application code plus
   * an `update`, two replicas failing at once would each read
   * `consecutive_failures = 2` and each write 3, and a lane would need twice as
   * many failures to trip on either.
   *
   * Three details in here are load-bearing:
   *
   *  - `state` is sticky. A failure on an already-`open` lane leaves it open and
   *    leaves `tripped_at` untouched, so a trip is one event — `tripped_at` is
   *    the marker `justTripped` keys on — and not one per failure.
   *  - The INSERT branch carries `tripped_at` as well, because a lane whose
   *    first-ever failure is also the trip (threshold 1) is created by the
   *    insert, not the conflict clause. Omitting it there produced a row that
   *    said `open` with a null trip time, and since `justTripped` matches on
   *    that time, `corridor_breaker_tripped` stayed silent for exactly the
   *    lanes that trip on contact.
   *  - `last_error` is carried forward rather than cleared by a success, so the
   *    operator can still see why a lane was in trouble after it recovered.
   *  - `reset_by`/`reset_reason` are history: an outcome never overwrites them.
   */
  async recordOutcome(
    corridorId: string,
    outcome: Exclude<BreakerOutcome, "neutral">,
    at: number,
    opts: RecordOutcomeOptions,
  ): Promise<BreakerRecord> {
    const failure = outcome === "failure";
    const res = await this.db.query<Row>(
      `insert into corridor_breakers
         (corridor_id, consecutive_failures, state, tripped_at, last_error, updated_at)
       values ($1,
               case when $2 then 1 else 0 end,
               case when $2 and 1 >= $4 then 'open' else 'closed' end,
               case when $2 and 1 >= $4 then to_timestamp($3 / 1000.0) else null end,
               case when $2 then $5 else null end,
               to_timestamp($3 / 1000.0))
       on conflict (corridor_id) do update set
         consecutive_failures = case
           when $2 then corridor_breakers.consecutive_failures + 1
           else 0
         end,
         state = case
           when $2 and corridor_breakers.consecutive_failures + 1 >= $4 then 'open'
           when $2 then corridor_breakers.state
           else 'closed'
         end,
         tripped_at = case
           when $2
              and corridor_breakers.consecutive_failures + 1 >= $4
              and corridor_breakers.state <> 'open'
             then to_timestamp($3 / 1000.0)
           else corridor_breakers.tripped_at
         end,
         last_error = case when $2 then $5 else corridor_breakers.last_error end,
         updated_at = to_timestamp($3 / 1000.0)
       returning ${SELECT_COLUMNS}`,
      [corridorId, failure, at, opts.threshold, opts.error ?? null],
    );
    return toRecord(res.rows[0]);
  }

  /**
   * Reopen the lane on a human's say-so. `by` and `reason` are written and
   * never rewritten by an outcome, so "who reopened this, and on what evidence"
   * outlives the next incident.
   *
   * Upsert rather than update-then-insert: resetting a lane that has never
   * failed is a legitimate (if unexciting) thing to do after fixing something
   * by hand, and it must not error.
   */
  async reset(
    corridorId: string,
    by: string,
    reason: string,
    at: number = Date.now(),
  ): Promise<BreakerRecord> {
    const res = await this.db.query<Row>(
      `insert into corridor_breakers
         (corridor_id, consecutive_failures, state, tripped_at, last_error,
          reset_by, reset_reason, reset_at, updated_at)
       values ($1, 0, 'closed', null, null, $2, $3,
               to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0))
       on conflict (corridor_id) do update set
         consecutive_failures = 0,
         state = 'closed',
         tripped_at = null,
         reset_by = excluded.reset_by,
         reset_reason = excluded.reset_reason,
         reset_at = excluded.reset_at,
         updated_at = excluded.updated_at
       returning ${SELECT_COLUMNS}`,
      [corridorId, by, reason, at],
    );
    return toRecord(res.rows[0]);
  }
}
