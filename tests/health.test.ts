import { describe, expect, it } from "vitest";
import { PostgresCorridorHealthStore } from "../packages/engine/src/health-pg";
import type { Queryable, QueryResult } from "../packages/engine/src/idempotency-pg";

function fakeHealthDb(): Queryable & { table: Map<string, Record<string, unknown>> } {
  const table = new Map<string, Record<string, unknown>>();
  return {
    table,
    async query<R = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<R>> {
      if (text.trimStart().startsWith("select")) {
        const row = table.get(params[0] as string);
        return { rows: (row ? [row] : []) as R[] };
      }

      const corridorId = params[0] as string;
      const isReset = text.includes("reset_by = $2");

      if (isReset) {
        const resetBy = params[1] as string;
        const resetReason = params[2] as string;

        const updated = {
          corridor_id: corridorId,
          consecutive_failures: 0,
          state: "up",
          tripped_at: null,
          last_error: null,
          reset_by: resetBy,
          reset_reason: resetReason,
        };
        table.set(corridorId, updated);
        return { rows: [updated] as R[] };
      }

      // recordOutcome
      const success = params[5] as boolean;
      const errorStr = params[6] as string | null;

      const current = table.get(corridorId) || {
        corridor_id: corridorId,
        consecutive_failures: 0,
        state: "up",
        tripped_at: null,
        last_error: null,
        reset_by: null,
        reset_reason: null,
      };

      const consecutive_failures = success ? 0 : (current.consecutive_failures as number) + 1;
      const state = success ? "up" : "down";
      const last_error = success ? current.last_error : errorStr;
      const tripped_at = success ? null : (current.tripped_at ?? new Date().toISOString());

      const updated = {
        ...current,
        consecutive_failures,
        state,
        last_error,
        tripped_at,
      };

      table.set(corridorId, updated);
      return { rows: [updated] as R[] };
    },
  };
}

describe("PostgresCorridorHealthStore", () => {
  it("records successful outcome", async () => {
    const store = new PostgresCorridorHealthStore(fakeHealthDb());

    const res = await store.recordOutcome("c1", true);
    expect(res).toMatchObject({
      corridorId: "c1",
      consecutiveFailures: 0,
      state: "up",
    });
    expect(res.trippedAt).toBeUndefined();
  });

  it("records failed outcome and increments failures", async () => {
    const store = new PostgresCorridorHealthStore(fakeHealthDb());

    const r1 = await store.recordOutcome("c1", false, "timeout");
    expect(r1.consecutiveFailures).toBe(1);
    expect(r1.state).toBe("down");
    expect(r1.lastError).toBe("timeout");
    expect(r1.trippedAt).toBeDefined();

    const r2 = await store.recordOutcome("c1", false, "connection refused");
    expect(r2.consecutiveFailures).toBe(2);
    expect(r2.state).toBe("down");
    expect(r2.lastError).toBe("connection refused");
    expect(r2.trippedAt).toBeDefined();
    expect(r2.trippedAt).toBe(r1.trippedAt); // timestamp shouldn't change
  });

  it("resets failures on success", async () => {
    const store = new PostgresCorridorHealthStore(fakeHealthDb());

    await store.recordOutcome("c1", false, "timeout");
    const res = await store.recordOutcome("c1", true);

    expect(res.consecutiveFailures).toBe(0);
    expect(res.state).toBe("up");
    expect(res.trippedAt).toBeUndefined();
    // lastError stays from the previous failure (based on the coalesce logic in postgres, wait, the sql says `case when $6::boolean then corridor_breakers.last_error else $7`)
    expect(res.lastError).toBe("timeout");
  });

  it("resets breaker explicitly for audit", async () => {
    const store = new PostgresCorridorHealthStore(fakeHealthDb());

    await store.recordOutcome("c1", false, "timeout");

    const res = await store.reset("c1", "admin@example.com", "resolved issue");
    expect(res.consecutiveFailures).toBe(0);
    expect(res.state).toBe("up");
    expect(res.trippedAt).toBeUndefined();
    expect(res.resetBy).toBe("admin@example.com");
    expect(res.resetReason).toBe("resolved issue");
    expect(res.lastError).toBeUndefined();
  });

  it("can get current state", async () => {
    const store = new PostgresCorridorHealthStore(fakeHealthDb());
    await store.recordOutcome("c1", false, "timeout");

    const state = await store.get("c1");
    expect(state).toBeDefined();
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.state).toBe("down");
  });
});
