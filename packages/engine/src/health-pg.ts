import type { Queryable } from "./idempotency-pg";

export interface HealthState {
  corridorId: string;
  consecutiveFailures: number;
  state: "up" | "down";
  trippedAt?: string;
  lastError?: string;
  resetBy?: string;
  resetReason?: string;
}

export interface CorridorHealthStore {
  recordOutcome(corridorId: string, success: boolean, error?: string): Promise<HealthState>;
  reset(corridorId: string, resetBy: string, resetReason: string): Promise<HealthState>;
  // Add get to match what tests might need, though the issue only mentioned recordOutcome and reset
  get(corridorId: string): Promise<HealthState | undefined>;
}

export class PostgresCorridorHealthStore implements CorridorHealthStore {
  constructor(private readonly db: Queryable) {}

  async recordOutcome(
    corridorId: string,
    success: boolean,
    error?: string,
  ): Promise<HealthState> {
    const res = await this.db.query<{
      corridor_id: string;
      consecutive_failures: number;
      state: string;
      tripped_at: Date | string | null;
      last_error: string | null;
      reset_by: string | null;
      reset_reason: string | null;
    }>(
      `insert into corridor_breakers (corridor_id, consecutive_failures, state, tripped_at, last_error, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (corridor_id) do update set
         consecutive_failures = case when $6::boolean then 0 else corridor_breakers.consecutive_failures + 1 end,
         state = case when $6::boolean then 'up' else 'down' end,
         last_error = case when $6::boolean then corridor_breakers.last_error else $7 end,
         tripped_at = case when $6::boolean then null else coalesce(corridor_breakers.tripped_at, now()) end,
         updated_at = now()
       returning *`,
      [
        corridorId,
        success ? 0 : 1,
        success ? "up" : "down",
        success ? null : new Date().toISOString(), // Use string to be compatible with fakeDb and pg driver
        success ? null : (error ?? null),
        success,
        error ?? null,
      ],
    );
    const row = res.rows[0]!;
    return {
      corridorId: row.corridor_id,
      consecutiveFailures: row.consecutive_failures,
      state: row.state as "up" | "down",
      trippedAt:
        row.tripped_at instanceof Date
          ? row.tripped_at.toISOString()
          : (row.tripped_at ?? undefined),
      lastError: row.last_error ?? undefined,
      resetBy: row.reset_by ?? undefined,
      resetReason: row.reset_reason ?? undefined,
    };
  }

  async reset(corridorId: string, resetBy: string, resetReason: string): Promise<HealthState> {
    const res = await this.db.query<{
      corridor_id: string;
      consecutive_failures: number;
      state: string;
      tripped_at: Date | string | null;
      last_error: string | null;
      reset_by: string | null;
      reset_reason: string | null;
    }>(
      `insert into corridor_breakers (corridor_id, consecutive_failures, state, reset_by, reset_reason, updated_at)
       values ($1, 0, 'up', $2, $3, now())
       on conflict (corridor_id) do update set
         consecutive_failures = 0,
         state = 'up',
         tripped_at = null,
         reset_by = $2,
         reset_reason = $3,
         updated_at = now()
       returning *`,
      [corridorId, resetBy, resetReason],
    );
    const row = res.rows[0]!;
    return {
      corridorId: row.corridor_id,
      consecutiveFailures: row.consecutive_failures,
      state: row.state as "up" | "down",
      trippedAt:
        row.tripped_at instanceof Date
          ? row.tripped_at.toISOString()
          : (row.tripped_at ?? undefined),
      lastError: row.last_error ?? undefined,
      resetBy: row.reset_by ?? undefined,
      resetReason: row.reset_reason ?? undefined,
    };
  }

  async get(corridorId: string): Promise<HealthState | undefined> {
    const res = await this.db.query<{
      corridor_id: string;
      consecutive_failures: number;
      state: string;
      tripped_at: Date | string | null;
      last_error: string | null;
      reset_by: string | null;
      reset_reason: string | null;
    }>(
      `select corridor_id, consecutive_failures, state, tripped_at, last_error, reset_by, reset_reason
       from corridor_breakers where corridor_id = $1`,
      [corridorId],
    );
    const row = res.rows[0];
    if (!row) return undefined;

    return {
      corridorId: row.corridor_id,
      consecutiveFailures: row.consecutive_failures,
      state: row.state as "up" | "down",
      trippedAt:
        row.tripped_at instanceof Date
          ? row.tripped_at.toISOString()
          : (row.tripped_at ?? undefined),
      lastError: row.last_error ?? undefined,
      resetBy: row.reset_by ?? undefined,
      resetReason: row.reset_reason ?? undefined,
    };
  }
}
