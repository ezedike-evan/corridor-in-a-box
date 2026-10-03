// Integration test for PostgresCorridorHealthStore against a REAL Postgres.
//
// tests/breaker-pg.test.ts exercises the store against a fake that mirrors its
// SQL. This file runs the actual statements — the atomic increment, the sticky
// `open`, the `tripped_at` stamp — against a live server, because the whole
// safety argument rests on `insert … on conflict do update` evaluating the
// increment and the threshold test against the same row version. A fake that
// agrees with our reading of the SQL proves nothing about Postgres agreeing
// with it too.
//
// It is opt-in: skipped unless CORRIDOR_TEST_DATABASE_URL is set. CI provides a
// Postgres service container (see .github/workflows/ci.yml). Locally:
//
//   docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
//   CORRIDOR_TEST_DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres \
//     pnpm exec vitest run tests/integration/breaker-pg.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresCorridorHealthStore,
  justTripped,
  migrate,
  type Queryable,
} from "@corridor/engine";

const url = process.env.CORRIDOR_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("PostgresCorridorHealthStore (live Postgres)", () => {
  // `pg.Pool` satisfies the structural `Queryable` shape; imported lazily so the
  // suite does not require a running DB (or even pg) when the env var is unset.
  let pool: { query: Queryable["query"]; end: () => Promise<void> };

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url }) as unknown as typeof pool;
    await migrate(pool as unknown as Queryable);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from corridor_breakers");
  });

  const store = () => new PostgresCorridorHealthStore(pool as unknown as Queryable);
  const fail = (id: string, at: number, threshold: number) =>
    store().recordOutcome(id, "failure", at, { threshold, error: "RECONCILE_STALLED: x" });

  it("migrate() is idempotent and creates the table", async () => {
    // Run it again on the already-migrated database: `create table if not exists`
    // must be a no-op, or every deploy would need a migration lock.
    await migrate(pool as unknown as Queryable);
    const res = await pool.query(
      "select count(*)::int as n from information_schema.tables where table_name = $1",
      ["corridor_breakers"],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it("opens on the Kth failure and stays open afterwards", async () => {
    expect(await fail("c", 1000, 3)).toMatchObject({
      state: "closed",
      consecutiveFailures: 1,
    });
    expect(await fail("c", 2000, 3)).toMatchObject({
      state: "closed",
      consecutiveFailures: 2,
    });
    const third = await fail("c", 3000, 3);
    expect(third).toMatchObject({ state: "open", consecutiveFailures: 3 });
    expect(new Date(third.trippedAt!).toISOString()).toBe("1970-01-01T00:00:03.000Z");
    // Sticky: a further failure does not move tripped_at, so a trip is one event.
    const fourth = await fail("c", 9000, 3);
    expect(fourth.state).toBe("open");
    expect(fourth.trippedAt).toBe(3000);
    expect(justTripped(fourth, 9000)).toBe(false);
  });

  it("a success clears the count but keeps last_error as history", async () => {
    await fail("c", 1000, 3);
    await fail("c", 2000, 3);
    const after = await store().recordOutcome("c", "success", 3000, { threshold: 3 });
    expect(after).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect(after.lastError).toBe("RECONCILE_STALLED: x");
  });

  // The reason the increment and the threshold test are one statement.
  it("no concurrent writer loses an increment", async () => {
    const s = store();
    await Promise.all(Array.from({ length: 20 }, (_, i) => fail("race", 1000 + i, 100)));
    const got = await s.get("race");
    // With a read-then-write, several of the 20 would read the same value and
    // overwrite each other, leaving a count well under 20.
    expect(got?.consecutiveFailures).toBe(20);
  });

  it("only one of many concurrent trips stamps tripped_at", async () => {
    const s = store();
    // Distinct call timestamps, as in real concurrent runs. `tripped_at` is
    // written only on the closed -> open transition, so exactly one result
    // satisfies justTripped and the `tripped` counter fires exactly once.
    const stamps = Array.from({ length: 10 }, (_, i) => 1000 + i);
    const results = await Promise.all(
      stamps.map((at) =>
        s.recordOutcome("trip", "failure", at, { threshold: 1, error: "boom" }),
      ),
    );
    const tripped = results.filter((r, i) => justTripped(r, stamps[i]));
    expect(tripped).toHaveLength(1);
    expect((await s.get("trip"))?.state).toBe("open");
  });

  it("round-trips reset_by and reset_reason, and clears the trip", async () => {
    const s = store();
    await fail("c", 1000, 1);
    const after = await s.reset("c", "ezedike", "anchor confirmed healthy", 5000);
    expect(after).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      resetBy: "ezedike",
      resetReason: "anchor confirmed healthy",
    });
    expect(after.trippedAt).toBeUndefined();
    expect((await s.get("c"))?.resetBy).toBe("ezedike");
  });

  it("an outcome never overwrites the reset audit", async () => {
    const s = store();
    await s.reset("c", "ezedike", "anchor confirmed healthy", 1000);
    await fail("c", 2000, 100);
    const after = await s.get("c");
    // "who reopened this, and on what evidence" has to outlive the next incident.
    expect(after?.resetBy).toBe("ezedike");
    expect(after?.resetReason).toBe("anchor confirmed healthy");
  });

  it("reset() on a lane with no row is not an error", async () => {
    expect(await store().reset("never-seen", "ezedike", "fixed by hand")).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("keeps lanes independent", async () => {
    const s = store();
    await fail("a", 1000, 1);
    await fail("b", 1000, 5);
    expect((await s.get("a"))?.state).toBe("open");
    expect((await s.get("b"))?.state).toBe("closed");
    const all = await s.list();
    expect(all.map((r) => r.corridorId).sort()).toEqual(["a", "b"]);
  });

  it("maps NULL columns to absent fields, not empty strings", async () => {
    const s = store();
    await s.reset("c", "ezedike", "why", 1000);
    const after = await fail("c", 2000, 100);
    expect(after.lastError).toBe("RECONCILE_STALLED: x");
    expect(after.trippedAt).toBeUndefined();
    expect(after.resetBy).toBe("ezedike");
  });
});
