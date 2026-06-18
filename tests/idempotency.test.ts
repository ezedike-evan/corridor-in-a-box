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
      // upsert with version guard
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
