// Integration test for PostgresIdempotencyStore against a REAL Postgres.
//
// The unit tests (tests/idempotency.test.ts) exercise the store against a
// hand-written fake DB. This file runs the same SQL — the atomic claim and the
// version-guarded upsert, the two pieces that actually protect against
// double-settlement — against a live server, so we know the real `INSERT … ON
// CONFLICT` semantics match our assumptions.
//
// It is opt-in: skipped unless CORRIDOR_TEST_DATABASE_URL is set. CI provides a
// Postgres service container (see .github/workflows/ci.yml). Locally:
//
//   docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
//   CORRIDOR_TEST_DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres \
//     pnpm exec vitest run tests/integration/idempotency-pg.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresIdempotencyStore,
  migrate,
  type Queryable,
  type StoredRun,
} from "@corridor/engine";

const url = process.env.CORRIDOR_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("PostgresIdempotencyStore (live Postgres)", () => {
  // `pg.Pool` satisfies the structural `Queryable` shape; import lazily so the
  // suite doesn't require a running DB (or even pg) when the env var is unset.
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
    await pool.query("delete from corridor_runs");
  });

  const store = () => new PostgresIdempotencyStore(pool as unknown as Queryable);
  const newRun = (key: string): StoredRun => ({
    idempotencyKey: key,
    corridorId: "c",
    state: "created",
    version: 0,
  });

  it("create() claims a key exactly once", async () => {
    const s = store();
    expect(await s.create(newRun("k1"))).toBe(true);
    expect(await s.create(newRun("k1"))).toBe(false);
    const got = await s.get("k1");
    expect(got?.state).toBe("created");
    expect(got?.version).toBe(0);
  });

  it("only ONE of many concurrent create() calls wins the claim", async () => {
    const s = store();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => s.create(newRun("race"))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("put() enforces optimistic concurrency on version", async () => {
    const s = store();
    await s.create(newRun("k2"));
    await s.put({ idempotencyKey: "k2", corridorId: "c", state: "settled", version: 5 });
    // A stale writer at a lower version must be ignored, not clobber the row.
    await s.put({ idempotencyKey: "k2", corridorId: "c", state: "settling", version: 3 });
    const got = await s.get("k2");
    expect(got?.state).toBe("settled");
    expect(got?.version).toBe(5);
  });

  it("round-trips all columns and maps NULLs to undefined", async () => {
    const s = store();
    await s.create(newRun("k3"));
    await s.put({
      idempotencyKey: "k3",
      corridorId: "c",
      state: "settled",
      version: 2,
      transactionId: "tx_1",
      stellarTxHash: "hash_1",
    });
    const got = await s.get("k3");
    expect(got).toMatchObject({
      idempotencyKey: "k3",
      state: "settled",
      version: 2,
      transactionId: "tx_1",
      stellarTxHash: "hash_1",
    });
    expect(got?.quoteId).toBeUndefined();
    expect(got?.lastError).toBeUndefined();
  });
});
