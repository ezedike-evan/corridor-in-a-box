import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  createMockSubmitter,
  execute,
  type EngineDeps,
  type Queryable,
  type QueryResult,
  type StoredRun,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "resume-1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

function deps(store: InMemoryIdempotencyStore): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter()),
    submitter: createMockSubmitter(),
    idempotency: store,
    sleep: async () => {},
  };
}

describe("crash resume", () => {
  it("resumes a run persisted in 'settled' by reconciling, then completing", async () => {
    const store = new InMemoryIdempotencyStore();
    // Simulate a crash right after the on-chain payment but before reconcile.
    await store.put({
      idempotencyKey: "resume-1",
      corridorId: "test",
      state: "settled",
      version: 5,
      transactionId: "tx_crashed",
      stellarTxHash: "mocktx0001",
    });

    const r = await execute(intent, corridor(), deps(store));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.transactionId).toBe("tx_crashed");
      expect(r.value.trail).toEqual(["settled", "reconciled", "completed"]);
    }
  });

  it("does NOT auto-resume an ambiguous 'settling' run (no double-settle)", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "resume-1",
      corridorId: "test",
      state: "settling",
      version: 4,
    });
    const r = await execute(intent, corridor(), deps(store));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("concurrent claim", () => {
  it("two concurrent runs of the same key settle exactly once", async () => {
    const store = new InMemoryIdempotencyStore();
    // Count how many times the submitter actually moves money. A correct gate
    // lets exactly one of the two concurrent runs reach settle().
    let settlements = 0;
    const submitter = createMockSubmitter();
    const counting = {
      ...submitter,
      submit: (req: Parameters<typeof submitter.submit>[0]) => {
        settlements += 1;
        return submitter.submit(req);
      },
    };
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter()),
      submitter: counting,
      idempotency: store,
      sleep: async () => {},
    };

    const [a, b] = await Promise.all([
      execute(intent, corridor(), d),
      execute(intent, corridor(), d),
    ]);

    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const loser = outcomes.find((r) => !r.ok);
    expect(loser && !loser.ok && loser.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(settlements).toBe(1);
  });
});

describe("PostgresIdempotencyStore.create", () => {
  it("claims a fresh key once and rejects a second claim", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    const run: StoredRun = {
      idempotencyKey: "k",
      corridorId: "c",
      state: "created",
      version: 0,
    };
    expect(await store.create(run)).toBe(true);
    expect(await store.create(run)).toBe(false);
    // The losing claim must not have clobbered the row.
    const got = await store.get("k");
    expect(got?.state).toBe("created");
    expect(got?.version).toBe(0);
  });
});

// A tiny in-memory fake that honours the version-guarded upsert semantics of the
// real SQL, so we can test PostgresIdempotencyStore's mapping + concurrency rule
// without a live database.
function fakeDb(): Queryable & { table: Map<string, Record<string, unknown>> } {
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
      const key = params[0] as string;
      const incoming = {
        idempotency_key: key,
        corridor_id: params[1],
        state: params[2],
        version: params[3] as number,
        transaction_id: params[4],
        quote_id: params[5],
        stellar_tx_hash: params[6],
        last_error: params[7],
      };
      // create(): INSERT … ON CONFLICT DO NOTHING RETURNING — only the first
      // writer for a key lands a row and gets it back; a conflict returns [].
      if (text.includes("do nothing")) {
        if (table.has(key)) return { rows: [] as R[] };
        table.set(key, incoming);
        return { rows: [{ idempotency_key: key }] as R[] };
      }
      // put(): upsert with version guard.
      const current = table.get(key);
      if (!current || (current.version as number) < incoming.version) {
        table.set(key, incoming);
      }
      return { rows: [] as R[] };
    },
  };
}

describe("PostgresIdempotencyStore", () => {
  it("round-trips a run and maps null columns to undefined", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    const run: StoredRun = {
      idempotencyKey: "k",
      corridorId: "c",
      state: "settled",
      version: 2,
      transactionId: "tx",
    };
    await store.put(run);
    const got = await store.get("k");
    expect(got).toMatchObject({ idempotencyKey: "k", state: "settled", transactionId: "tx" });
    expect(got?.stellarTxHash).toBeUndefined();
    expect(got?.quoteId).toBeUndefined();
  });

  it("ignores a stale write with a lower version (optimistic concurrency)", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    await store.put({ idempotencyKey: "k", corridorId: "c", state: "reconciled", version: 6 });
    await store.put({ idempotencyKey: "k", corridorId: "c", state: "settling", version: 3 });
    const got = await store.get("k");
    expect(got?.state).toBe("reconciled");
    expect(got?.version).toBe(6);
  });
});
