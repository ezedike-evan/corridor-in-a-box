import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  createMockSubmitter,
  execute,
  hasRequestedRefund,
  migrate,
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
        refund_id: params[7],
        last_error: params[8],
        owner: params[9],
      };
      // create(): INSERT … ON CONFLICT DO NOTHING RETURNING — only the first
      // writer for a key lands a row and gets it back; a conflict returns [].
      if (text.includes("do nothing")) {
        if (table.has(key)) return { rows: [] as R[] };
        table.set(key, incoming);
        return { rows: [{ idempotency_key: key }] as R[] };
      }
      // put(): upsert with version guard. `refund_id` is coalesced, not
      // overwritten, mirroring the real SQL: once a refund has been requested
      // the stored id must survive a writer that lost it.
      const current = table.get(key);
      if (!current || (current.version as number) < incoming.version) {
        table.set(key, {
          ...incoming,
          refund_id: current?.refund_id ?? incoming.refund_id,
        });
      }
      return { rows: [] as R[] };
    },
  };
}

describe("state round-trips", () => {
  // refund_pending is just a string to both stores — but a run parked in it
  // is a run with money in motion, so "it comes back exactly as written and
  // still reads as non-terminal" is asserted rather than assumed.
  it("InMemoryIdempotencyStore persists and reads back refund_pending", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "k-rp",
      corridorId: "c",
      state: "refund_pending",
      version: 4,
      stellarTxHash: "hash_rp",
    });
    const got = await store.get("k-rp");
    expect(got?.state).toBe("refund_pending");
    expect(got?.stellarTxHash).toBe("hash_rp");
  });

  it("PostgresIdempotencyStore persists and reads back refund_pending", async () => {
    const db = fakeDb();
    const store = new PostgresIdempotencyStore(db);
    await store.put({
      idempotencyKey: "k-rp",
      corridorId: "c",
      state: "refund_pending",
      version: 4,
      stellarTxHash: "hash_rp",
    });
    const got = await store.get("k-rp");
    expect(got?.state).toBe("refund_pending");
    expect(got?.stellarTxHash).toBe("hash_rp");
  });
});

describe("hasRequestedRefund", () => {
  it("is the gate the refund request path asks before issuing another", () => {
    expect(hasRequestedRefund({ refundId: "hash_back" })).toBe(true);
    expect(hasRequestedRefund({})).toBe(false);
    expect(hasRequestedRefund({ refundId: undefined })).toBe(false);
    // An empty id is not evidence of anything.
    expect(hasRequestedRefund({ refundId: "" })).toBe(false);
  });
});

describe("refund state round-trips", () => {
  // A run that records the payment but not the refund can request a second
  // refund after a crash — the same class of bug the idempotency gate exists
  // to prevent, one leg further on.
  it("InMemoryIdempotencyStore round-trips refundId", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "k-rf",
      corridorId: "c",
      state: "refunded",
      version: 4,
      stellarTxHash: "hash_out",
      refundId: "hash_back",
    });
    expect((await store.get("k-rf"))?.refundId).toBe("hash_back");

    await store.create({
      idempotencyKey: "k-none",
      corridorId: "c",
      state: "created",
      version: 0,
    });
    expect((await store.get("k-none"))?.refundId).toBeUndefined();
  });

  it("PostgresIdempotencyStore round-trips refundId", async () => {
    const store = new PostgresIdempotencyStore(fakeDb());
    await store.put({
      idempotencyKey: "k-rf",
      corridorId: "c",
      state: "refunded",
      version: 4,
      stellarTxHash: "hash_out",
      refundId: "hash_back",
    });
    const got = await store.get("k-rf");
    expect(got?.refundId).toBe("hash_back");
    expect(got?.stellarTxHash).toBe("hash_out");
  });

  it("PostgresIdempotencyStore never lets a later write erase refundId", async () => {
    const store = new PostgresIdempotencyStore(fakeDb());
    await store.put({
      idempotencyKey: "k-rf",
      corridorId: "c",
      state: "refunded",
      version: 4,
      refundId: "hash_back",
    });
    await store.put({
      idempotencyKey: "k-rf",
      corridorId: "c",
      state: "refunded",
      version: 5,
    });
    expect((await store.get("k-rf"))?.refundId).toBe("hash_back");
  });

  it("ships the refund_id column in BOTH the create DDL and the additive migration", async () => {
    // Putting it only in CREATE_TABLE_SQL would leave every deployment that
    // predates this change without the column, silently — the `owner` column
    // is the precedent and the comment above ALTER_TABLE_SQL explains why.
    const seen: string[] = [];
    await migrate({
      async query(text: string) {
        seen.push(text);
        return { rows: [] };
      },
    });
    expect(seen[0]).toContain("refund_id");
    expect(seen.slice(1).join("\n")).toContain("add column if not exists refund_id");
  });
});

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
