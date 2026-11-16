// Seeded property tests for the service's untrusted-input boundary: the body of
// POST /payments and the key in GET /payments/:key.
//
// Example tests (service.test.ts) cover the bodies someone thought of. These
// throw random and mutated JSON at `route()` and check what must hold for ALL of
// them: it never throws, never answers 5xx, never moves money for a body that is
// not a valid payment, and never lets a `__proto__` key leak into Object.prototype.
// No property-testing dependency. See tests/helpers/seeded.ts to replay a failure.

import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  type EngineDeps,
  type SettlementSubmitter,
} from "@corridor/engine";
import { createService } from "@corridor/service";
import { forAll, int, pick, seedFromEnv, type Rand } from "./helpers/seeded";

const RUNS = 600;
const SEED = seedFromEnv(0x5e17ce);

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
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function harness() {
  let submits = 0;
  const inner = createMockSubmitter();
  const submitter: SettlementSubmitter = {
    ...inner,
    submit: async (req) => {
      submits += 1;
      return inner.submit(req);
    },
  };
  const deps: EngineDeps = {
    resolver: new StaticRouteResolver(() => createMockAdapter(), {
      trustManifestWithoutAttestation: true,
    }),
    submitter,
    idempotency: new InMemoryIdempotencyStore(),
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
  };
  const service = createService({ corridors: new Map([["test", corridor()]]), deps });
  return { service, submits: () => submits };
}

// --- generators -------------------------------------------------------------

const JUNK_STRINGS = [
  "",
  " ",
  "null",
  "../../etc/passwd",
  "a".repeat(5000),
  "\u0000",
  "'; DROP TABLE corridor_runs; --",
  "<script>alert(1)</script>",
  "\u{1F4A5}",
  "__proto__",
  "constructor",
];

/** Any JSON-shaped value, including hostile keys, built with JSON.parse so `__proto__` is an own key. */
function junk(r: Rand, depth = 0): unknown {
  const kinds = depth > 3 ? 5 : 8;
  switch (int(r, kinds)) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2:
      return pick(r, [0, -1, 1.5, 1e21, Number.MAX_SAFE_INTEGER]);
    case 3:
      return pick(r, JUNK_STRINGS);
    case 4:
      return Math.floor(r() * 1000).toString();
    case 5:
      return Array.from({ length: int(r, 4) }, () => junk(r, depth + 1));
    case 6: {
      const keys = ["id", "amount", "asset", "__proto__", "constructor", "polluted", "x"];
      const entries = Array.from({ length: int(r, 4) }, () => [
        pick(r, keys),
        junk(r, depth + 1),
      ]);
      return JSON.parse(
        `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`,
      );
    }
    default:
      return JSON.parse('{"__proto__":{"polluted":"yes"},"idempotencyKey":"k"}');
  }
}

function validBody(r: Rand): Record<string, unknown> {
  return {
    idempotencyKey: `key-${int(r, 1e9)}`,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

const TOP_LEVEL = ["idempotencyKey", "corridorId", "sender", "recipient", "sourceAmount"];

/** A valid body with one or two things broken: dropped, retyped, extended or oversized. */
function mutated(r: Rand): unknown {
  const body = validBody(r);
  for (let i = 0; i <= int(r, 2); i++) {
    const key = pick(r, TOP_LEVEL);
    switch (int(r, 5)) {
      case 0:
        delete body[key];
        break;
      case 1:
        body[key] = junk(r);
        break;
      case 2:
        // defineProperty: plain assignment to `__proto__` would set the prototype, not add the key.
        Object.defineProperty(
          body,
          pick(r, ["extra", "__proto__", "isAdmin", "constructor"]),
          {
            value: junk(r),
            enumerable: true,
            configurable: true,
            writable: true,
          },
        );
        break;
      case 3:
        body.idempotencyKey = pick(r, [
          "",
          "a b",
          "a/b",
          "x".repeat(129),
          "x".repeat(100_000),
        ]);
        break;
      default:
        body.sourceAmount = {
          asset: pick(r, ["USDC", "", 7, null]),
          amount: pick(r, ["-1", "0", "1e3", "1,5", "NaN", "9".repeat(60), "0.00000001", 100]),
        };
    }
  }
  return JSON.parse(JSON.stringify(body));
}

function anyBody(r: Rand): unknown {
  return r() < 0.35 ? junk(r) : mutated(r);
}

/**
 * An independent statement of "this is a valid payment body", written from the
 * documented rules rather than copied from the parser, so the two can disagree.
 * Deliberately conservative: it says valid only when every rule is plainly met.
 */
function plainlyValid(b: unknown): boolean {
  if (typeof b !== "object" || b === null || Array.isArray(b)) return false;
  const o = b as Record<string, unknown>;
  if (
    Object.keys(o).some(
      (k) =>
        ![
          "idempotencyKey",
          "corridorId",
          "sender",
          "recipient",
          "sourceAmount",
          "destinationFields",
        ].includes(k),
    )
  )
    return false;
  if (
    typeof o.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(o.idempotencyKey)
  )
    return false;
  if (o.corridorId !== "test") return false;
  const party = (p: unknown) =>
    typeof p === "object" &&
    p !== null &&
    typeof (p as { id?: unknown }).id === "string" &&
    (p as { id: string }).id !== "";
  if (!party(o.sender) || !party(o.recipient)) return false;
  const a = o.sourceAmount as { asset?: unknown; amount?: unknown } | null;
  return (
    !!a &&
    a.asset === "USDC" &&
    typeof a.amount === "string" &&
    /^[1-9]\d{0,8}(\.\d{1,2})?$/.test(a.amount)
  );
}

describe("service properties: POST /payments body", () => {
  it(`never throws or answers 5xx, over ${RUNS} generated bodies`, async () => {
    const { service } = harness();
    await forAll(SEED, RUNS, anyBody, async (body) => {
      const res = await service.route({ method: "POST", path: "/payments", body });
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBeGreaterThanOrEqual(200);
    });
  });

  it(`never moves money for a body that is not a valid payment, over ${RUNS} bodies`, async () => {
    await forAll(SEED + 1, RUNS, anyBody, async (body) => {
      const { service, submits } = harness();
      const res = await service.route({ method: "POST", path: "/payments", body });
      if (submits() > 0) {
        // Money moved, so the body must have been valid and the run must have said so.
        expect(plainlyValid(body), "settled for a body the oracle calls invalid").toBe(true);
        expect(res.status).toBe(200);
      }
      if (!plainlyValid(body) && res.status === 200) {
        // Rare but legal: the parser is more permissive than the oracle. It must still be
        // a body the parser would accept, which means no money moved without a valid run.
        expect(submits()).toBeLessThanOrEqual(1);
      }
    });
  });

  it("refuses with 400 a body the oracle can show is broken at the top level", async () => {
    const { service, submits } = harness();
    await forAll(
      SEED + 2,
      RUNS,
      (r) => {
        const b = validBody(r);
        const key = pick(r, TOP_LEVEL);
        if (r() < 0.5) delete b[key];
        else b[key] = pick(r, [null, 1, true, [], {}]);
        return b;
      },
      async (body) => {
        const res = await service.route({ method: "POST", path: "/payments", body });
        expect(res.status).toBe(400);
      },
    );
    expect(submits()).toBe(0);
  });

  it("does not let a __proto__ key in the body pollute Object.prototype", async () => {
    const { service } = harness();
    await forAll(SEED + 3, RUNS, junk, async (body) => {
      await service.route({ method: "POST", path: "/payments", body });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.keys(Object.prototype)).toEqual([]);
    });
  });

  it("accepts the valid body the generators start from (the oracle and parser agree here)", async () => {
    const { service } = harness();
    await forAll(SEED + 4, 50, validBody, async (body) => {
      expect(plainlyValid(body)).toBe(true);
      const res = await service.route({ method: "POST", path: "/payments", body });
      expect(res.status).toBe(200);
    });
  });
});

describe("service properties: GET /payments/:key", () => {
  it(`never throws or answers 5xx for an arbitrary key, over ${RUNS} paths`, async () => {
    const { service } = harness();
    await forAll(
      SEED + 5,
      RUNS,
      (r) => {
        const chars = "abcXYZ019._:-%/\\ ?#<>'\"\u0000é💥";
        const key = Array.from({ length: int(r, 40) }, () => pick(r, [...chars])).join("");
        return pick(r, ["__proto__", "constructor", key, encodeURIComponent(key)]);
      },
      async (key) => {
        const res = await service.route({ method: "GET", path: `/payments/${key}` });
        expect(res.status).toBeLessThan(500);
      },
    );
  });
});
