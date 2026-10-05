// PostgresCorridorHealthStore against a hand-written fake DB.
//
// The unit here is the SQL itself — the atomic increment, the threshold test
// and the sticky `open` all live inside one `insert … on conflict do update`
// statement, so a fake that recognises that statement by shape can exercise the
// semantics without a server. What it cannot check is that Postgres parses the
// statement; tests/integration/breaker-pg.test.ts runs it against a real one.

import { describe, expect, it } from "vitest";
import {
  BREAKERS_MIGRATION_SQL,
  CREATE_BREAKERS_TABLE_SQL,
  CREATE_TABLE_SQL,
  PostgresCorridorHealthStore,
  justTripped,
  migrate,
  type Queryable,
  type QueryResult,
} from "@corridor/engine";

/** Every column the breaker row can carry, in the order `outgoing` emits them. */
const COLUMNS = [
  "corridor_id",
  "consecutive_failures",
  "state",
  "tripped_at",
  "last_error",
  "reset_by",
  "reset_reason",
  "reset_at",
  "updated_at",
];

/** The columns a `returning` clause produces, in order, as raw driver values. */
function outgoing(r: {
  corridor_id: string;
  consecutiveFailures: number;
  state: string;
  tripped_at: number | null;
  last_error: string | null;
  reset_by: string | null;
  reset_reason: string | null;
  reset_at: number | null;
  updated_at: number;
}): Record<string, unknown> {
  // `pg` returns timestamptz as a Date; that is what the fake hands back, so the
  // mapping under test is the one production actually takes.
  const ts = (ms: number | null) => (ms === null ? null : new Date(ms));
  return {
    corridor_id: r.corridor_id,
    consecutive_failures: r.consecutiveFailures,
    state: r.state,
    tripped_at: ts(r.tripped_at),
    last_error: r.last_error,
    reset_by: r.reset_by,
    reset_reason: r.reset_reason,
    reset_at: ts(r.reset_at),
    updated_at: ts(r.updated_at),
  };
}

interface FakeRow {
  corridor_id: string;
  consecutiveFailures: number;
  state: string;
  tripped_at: number | null;
  last_error: string | null;
  reset_by: string | null;
  reset_reason: string | null;
  reset_at: number | null;
  updated_at: number;
}

/**
 * Mirrors the store's real SQL closely enough to be a test rather than a mock:
 * it applies the same increment, the same threshold comparison and the same
 * "only stamp tripped_at on the transition into open" rule.
 */
function fakeDb(): Queryable & { table: Map<string, FakeRow> } {
  const table = new Map<string, FakeRow>();
  return {
    table,
    async query<R = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<R>> {
      const current = table.get(params[0] as string);
      // `reset_by = excluded.reset_by` appears only in the reset statement, so
      // it is a reliable discriminator between the two upserts. The two take
      // different parameter lists, so each branch reads the ones it binds.
      if (text.includes("reset_by = excluded.reset_by")) {
        // reset($1 corridor, $2 by, $3 reason, $4 at)
        const next: FakeRow = {
          corridor_id: params[0] as string,
          consecutiveFailures: 0,
          state: "closed",
          tripped_at: null,
          last_error: null,
          reset_by: params[1] as string,
          reset_reason: params[2] as string,
          reset_at: params[3] as number,
          updated_at: params[3] as number,
        };
        table.set(next.corridor_id, next);
        return { rows: [outgoing(next) as R] };
      }

      // recordOutcome($1 corridor, $2 failure, $3 at, $4 threshold, $5 error)
      const id = params[0] as string;
      const failure = params[1] as boolean;
      const at = params[2] as number;
      const threshold = params[3] as number;
      const error = (params[4] as string | null) ?? null;

      // A column missing from the INSERT list is not "set to null by the
      // author", it is *absent*, and takes the table default — which for
      // `tripped_at` is NULL. That distinction is the whole reason this fake
      // reads the statement instead of restating it: re-implementing the rule
      // from the author's understanding is what let a lane trip on its first
      // failure with no `tripped_at` reach the real database unnoticed.
      const insertCols = /insert into corridor_breakers\s*\(([\s\S]*?)\)\s*values/i.exec(
        text,
      )?.[1];
      const insertCarriesTrippedAt = insertCols?.includes("tripped_at") === true;

      const next: FakeRow = {
        corridor_id: id,
        consecutiveFailures: failure ? (current?.consecutiveFailures ?? 0) + 1 : 0,
        state: "closed",
        tripped_at: current?.tripped_at ?? null,
        last_error: failure ? error : (current?.last_error ?? null),
        reset_by: current?.reset_by ?? null,
        reset_reason: current?.reset_reason ?? null,
        reset_at: current?.reset_at ?? null,
        updated_at: at,
      };
      if (failure && next.consecutiveFailures >= threshold) {
        next.state = "open";
        if (current?.state !== "open") {
          // On the conflict path the UPDATE clause stamps it unconditionally.
          // On the insert path it is only there if the column was listed.
          if (current || insertCarriesTrippedAt) next.tripped_at = at;
        }
      }
      table.set(id, next);
      return { rows: [outgoing(next) as R] };
    },
  };
}

describe("PostgresCorridorHealthStore.recordOutcome", () => {
  it("stays closed below the threshold and opens on the Kth failure", async () => {
    const s = new PostgresCorridorHealthStore(fakeDb());
    expect(await s.recordOutcome("c", "failure", 1000, { threshold: 3 })).toMatchObject({
      state: "closed",
      consecutiveFailures: 1,
    });
    expect(await s.recordOutcome("c", "failure", 2000, { threshold: 3 })).toMatchObject({
      state: "closed",
      consecutiveFailures: 2,
    });
    const third = await s.recordOutcome("c", "failure", 3000, { threshold: 3 });
    expect(third).toMatchObject({ state: "open", consecutiveFailures: 3, trippedAt: 3000 });
    expect(justTripped(third, 3000)).toBe(true);
  });

  it("clears the count on a success but keeps the last error as history", async () => {
    const s = new PostgresCorridorHealthStore(fakeDb());
    await s.recordOutcome("c", "failure", 1000, {
      threshold: 3,
      error: "RECONCILE_STALLED: x",
    });
    const after = await s.recordOutcome("c", "success", 2000, { threshold: 3 });
    expect(after).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    // Still there: "why was this lane in trouble" stays answerable afterwards.
    expect(after.lastError).toBe("RECONCILE_STALLED: x");
  });

  it("is sticky: a further failure does not re-trip or move tripped_at", async () => {
    const s = new PostgresCorridorHealthStore(fakeDb());
    await s.recordOutcome("c", "failure", 1000, { threshold: 1 });
    const second = await s.recordOutcome("c", "failure", 5000, { threshold: 1 });
    expect(second.state).toBe("open");
    expect(second.trippedAt).toBe(1000);
    expect(justTripped(second, 5000)).toBe(false);
  });

  it("stamps tripped_at when the FIRST failure is also the trip", async () => {
    // The insert path, not the conflict path. With `consecutive_failures: 1` a
    // lane's very first failure opens the breaker, and the row is created by
    // the INSERT branch of the upsert. If that branch does not carry
    // `tripped_at`, the row says `open` with a null trip time — and since
    // `justTripped` matches on the trip time, the `corridor_breaker_tripped`
    // counter never fires for a lane that trips on contact. An operator asking
    // `breaker status` gets `tripped: -` for a lane that is refusing traffic.
    const s = new PostgresCorridorHealthStore(fakeDb());
    const r = await s.recordOutcome("brand-new", "failure", 1000, {
      threshold: 1,
      error: "SETTLEMENT_FAILED: x",
    });
    expect(r.state).toBe("open");
    expect(r.trippedAt).toBe(1000);
    expect(justTripped(r, 1000)).toBe(true);
  });

  it("binds exactly the five parameters its statements reference", async () => {
    // Guards the classic parameterisation bug: a statement reading $6 while
    // handed five fails at the driver, not at compile time.
    const seen: number[] = [];
    const db: Queryable = {
      async query(_text: string, params: unknown[] = []) {
        seen.push(params.length);
        return { rows: [] };
      },
    };
    const s = new PostgresCorridorHealthStore(db);
    await s
      .recordOutcome("c", "failure", 1000, { threshold: 3, error: "boom" })
      .catch(() => {});
    await s.reset("c", "me", "why", 2000).catch(() => {});
    expect(seen).toEqual([5, 4]);
  });

  it("folds one outcome in a single statement, with no read before it", async () => {
    // The reason the increment and the threshold test live in one statement: a
    // read-then-write lets two replicas each read 1 and each write 2, so a lane
    // failing on both needs double the failures to trip on either. What this can
    // assert without a server is the shape: one write, no preceding read.
    const queries: string[] = [];
    const db: Queryable = {
      async query(text: string) {
        queries.push(text.trim());
        return { rows: [] };
      },
    };
    const s = new PostgresCorridorHealthStore(db);
    await s.recordOutcome("c", "failure", 1000, { threshold: 3 }).catch(() => {});
    expect(queries).toHaveLength(1);
    expect(queries[0].startsWith("insert into corridor_breakers")).toBe(true);
    expect(queries[0]).toContain("on conflict (corridor_id) do update set");
  });
});

describe("PostgresCorridorHealthStore.reset", () => {
  it("closes the lane and records who reset it and why", async () => {
    const s = new PostgresCorridorHealthStore(fakeDb());
    await s.recordOutcome("c", "failure", 1000, { threshold: 1 });
    const after = await s.reset("c", "ezedike", "anchor confirmed healthy", 5000);
    expect(after).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      resetBy: "ezedike",
      resetReason: "anchor confirmed healthy",
      resetAt: 5000,
    });
    // The stale trip time is cleared, so a running lane does not render as open.
    expect(after.trippedAt).toBeUndefined();
    expect(after.updatedAt).toBe(5000);
  });

  it("reads an unrecognised state string as closed, never as open", async () => {
    // A row hand-edited in psql must not be able to inject a value the engine's
    // types claim is a halted lane.
    const db = rowsDb([
      {
        corridor_id: "c",
        consecutive_failures: 9,
        state: "OPEN'; DROP TABLE corridor_runs; --",
        tripped_at: null,
        last_error: null,
        reset_by: null,
        reset_reason: null,
        reset_at: null,
        updated_at: new Date(1000),
      },
    ]);
    expect((await new PostgresCorridorHealthStore(db).get("c"))?.state).toBe("closed");
  });

  it("maps NULL columns to absent fields, not empty strings", async () => {
    // A `resetReason` of "" would render as a reset with no reason given, which
    // is a different statement from "never reset".
    expect(await new PostgresCorridorHealthStore(rowsDb([])).get("nope")).toBeUndefined();
  });

  it("accepts a timestamptz arriving as a string, as non-pg drivers return it", async () => {
    const db = rowsDb([
      {
        corridor_id: "c",
        consecutive_failures: 3,
        state: "open",
        tripped_at: "2026-09-28T12:00:00.000Z",
        last_error: "x",
        reset_by: null,
        reset_reason: null,
        reset_at: null,
        updated_at: "2026-09-28T12:00:00.000Z",
      },
    ]);
    const r = await new PostgresCorridorHealthStore(db).get("c");
    expect(r?.trippedAt).toBe(Date.parse("2026-09-28T12:00:00.000Z"));
    expect(r?.resetAt).toBeUndefined();
    expect(r?.resetBy).toBeUndefined();
  });
});

describe("migrate() ships the breaker table", () => {
  it("creates corridor_breakers from the same entry point as corridor_runs", async () => {
    // One migration command, not two: a deployment that upgrades the engine and
    // does not re-run migrate() would fail every payment on a missing table.
    const seen: string[] = [];
    await migrate({
      async query(text: string) {
        seen.push(text);
        return { rows: [] };
      },
    });
    expect(seen.join("\n")).toContain("create table if not exists corridor_breakers");
  });

  it("is idempotent: running it twice issues the same statements", async () => {
    const once: string[] = [];
    const twice: string[] = [];
    const collect = (into: string[]): Queryable => ({
      async query(text: string) {
        into.push(text);
        return { rows: [] };
      },
    });
    await migrate(collect(once));
    await migrate(collect(twice));
    expect(twice).toEqual(once);
  });
});

describe("migrate() upgrades the legacy #366 corridor_breakers table", () => {
  // Databases that ran migrate() since #366 hold a table with no `reset_at`,
  // default 'up' and states 'up'/'down'. `create table if not exists` is a no-op
  // there, so without the extra statements every payment would fail selecting
  // reset_at. The statements are interpreted over a tiny legacy-table model so
  // the semantics (not just their text) are checked; tests/integration runs the
  // same path against real Postgres.
  function legacyDb() {
    const legacy = {
      columns: new Set([
        "corridor_id",
        "consecutive_failures",
        "state",
        "tripped_at",
        "last_error",
        "reset_by",
        "reset_reason",
        "updated_at",
      ]),
      stateDefault: "up",
      rows: [
        { corridor_id: "a", state: "up" },
        { corridor_id: "b", state: "down" },
      ],
    };
    const statements: string[] = [];
    const db: Queryable = {
      async query(text: string) {
        statements.push(text);
        const add = /alter table corridor_breakers add column if not exists (\w+)/i.exec(text);
        if (add) legacy.columns.add(add[1]);
        const def = /alter column state set default '(\w+)'/i.exec(text);
        if (def) legacy.stateDefault = def[1];
        const upd = /update corridor_breakers set state = '(\w+)' where state = '(\w+)'/i.exec(
          text,
        );
        if (upd) for (const r of legacy.rows) if (r.state === upd[2]) r.state = upd[1];
        return { rows: [] };
      },
    };
    return { db, legacy, statements };
  }

  it("adds reset_at, defaults state to closed, and maps up/down to closed/open", async () => {
    const { db, legacy } = legacyDb();
    await migrate(db);
    expect(legacy.columns.has("reset_at")).toBe(true);
    expect(legacy.stateDefault).toBe("closed");
    expect(legacy.rows).toEqual([
      { corridor_id: "a", state: "closed" },
      { corridor_id: "b", state: "open" },
    ]);
  });

  it("is idempotent over the legacy table", async () => {
    const { db, legacy } = legacyDb();
    await migrate(db);
    await migrate(db);
    expect(legacy.rows.map((r) => r.state)).toEqual(["closed", "open"]);
  });

  it("runs the upgrade statements after the create, from migrate() alone", async () => {
    const { db, statements } = legacyDb();
    await migrate(db);
    const create = statements.indexOf(CREATE_BREAKERS_TABLE_SQL);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(statements.slice(create + 1)).toEqual([...BREAKERS_MIGRATION_SQL]);
  });

  it("defines corridor_breakers in exactly one place", () => {
    expect(CREATE_TABLE_SQL).not.toContain("corridor_breakers");
  });
});

describe("PostgresCorridorHealthStore.list", () => {
  it("keeps one row per corridor, so lanes cannot overwrite each other", async () => {
    const db = fakeDb();
    const s = new PostgresCorridorHealthStore(db);
    await s.recordOutcome("b", "failure", 1000, { threshold: 1 });
    await s.recordOutcome("a", "failure", 1000, { threshold: 5 });
    expect(db.table.size).toBe(2);
    expect(db.table.get("a")).toMatchObject({ state: "closed", consecutiveFailures: 1 });
    expect(db.table.get("b")).toMatchObject({ state: "open", tripped_at: 1000 });
  });
});

/**
 * A Queryable that hands back fixed rows, for the decoding paths that only a
 * hand-written row can reach (a stringified timestamp, a NULL column, a state
 * value no code path would ever write). `query` is generic on Queryable, so the
 * cast is the seam — the rows themselves are still type-checked at the call site.
 */
function rowsDb(rows: Record<string, unknown>[]): Queryable {
  return {
    async query<R = Record<string, unknown>>(): Promise<QueryResult<R>> {
      return { rows: rows as R[] };
    },
  };
}

describe("breaker schema and row mapping agree", () => {
  it("selects every column the DDL creates, and no column it does not", async () => {
    // Drift here is silent and expensive: add a column to the row mapper without
    // adding it to the `select` and every read returns undefined for it, with no
    // error anywhere. The reverse — a selected column with no column in the table
    // — fails every payment with a driver error. Assert both directions.
    const seen: string[] = [];
    await new PostgresCorridorHealthStore({
      async query<R = Record<string, unknown>>(text: string): Promise<QueryResult<R>> {
        seen.push(text);
        return { rows: [] };
      },
    }).list();

    const selected = seen[0] ?? "";
    for (const col of COLUMNS) {
      expect(CREATE_BREAKERS_TABLE_SQL).toContain(col);
      expect(selected).toContain(col);
    }
    // No phantom column: every word in the select list is a real one.
    const list = selected.slice(selected.indexOf("select") + 6, selected.indexOf(" from"));
    for (const word of list.split(/[\s,]+/).filter(Boolean)) {
      expect(COLUMNS).toContain(word);
    }
  });

  it("keys outgoing() by the same column names it reads", () => {
    expect(
      Object.keys(
        outgoing({
          corridor_id: "c",
          consecutiveFailures: 0,
          state: "closed",
          tripped_at: 1,
          last_error: null,
          reset_by: null,
          reset_reason: null,
          reset_at: null,
          updated_at: 2,
        }),
      ).sort(),
    ).toEqual([...COLUMNS].sort());
  });
});
