import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { Sep6Adapter, mapSep6Status, parseSep6Info } from "@corridor/sep6";
import type { PaymentIntent } from "@corridor/types";
import type { Quote, Sep10Signer } from "@corridor/adapter-kit";

interface FakeResponse {
  ok: boolean;
  status: number;
  body: unknown;
}
function res(body: unknown, ok = true, status = 200): FakeResponse {
  return { ok, status, body };
}

// Minimal router-style fetch fake. Keyed on `${METHOD} ${substring}`.
function fakeFetch(routes: Record<string, FakeResponse>) {
  const calls: { url: string; method: string; headers?: Record<string, string> }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = init?.headers ? (init.headers as Record<string, string>) : undefined;
    calls.push({ url, method, headers });
    const key = Object.keys(routes).find((k) => {
      const [m, sub] = k.split(" ");
      return m === method && url.includes(sub);
    });
    const r = key ? routes[key] : res({}, false, 404);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const INFO_FIXTURE = {
  withdraw: {
    ARS: {
      enabled: true,
      authentication_required: true,
      min_amount: 10,
      max_amount: 5000,
      fee_fixed: 5,
      fee_percent: 1.5,
      types: {
        bank_account: {
          fields: {
            dest: { description: "Account number" },
            dest_extra: { description: "CBU", optional: true },
            type: { choices: ["A", "B"] },
          },
        },
      },
    },
  },
  "withdraw-exchange": {
    ARS: {
      enabled: true,
      authentication_required: true,
      min_amount: 20,
      max_amount: 8000,
      fee_fixed: 4,
      fee_percent: 2,
      types: {
        bank_account: {
          fields: { dest: { description: "Account number" } },
        },
      },
    },
  },
};

function sep6Corridor(endpoints: Record<string, string> = {}): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      protocol: "sep6",
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server: "https://d.example/sep6",
        ...endpoints,
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

// A legacy SEP-31 dest (no explicit protocol) for the rejection test.
function sep31Corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "USDC",
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
  idempotencyKey: "k",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100" },
};

const quote: Quote = {
  id: "q1",
  price: "1.0",
  expiresAt: Date.now() + 60_000,
  sourceAmount: { asset: "USDC", amount: "100" },
  destAmount: { asset: "iso4217:ARS", amount: "100" },
  firm: true,
};

describe("parseSep6Info", () => {
  it("parses withdraw and withdraw-exchange entries, types and fields", () => {
    const info = parseSep6Info(INFO_FIXTURE);
    const w = info.withdraw.ARS;
    expect(w?.enabled).toBe(true);
    expect(w?.authenticationRequired).toBe(true);
    expect(w?.minAmount).toBe("10");
    expect(w?.maxAmount).toBe("5000");
    expect(w?.feeFixed).toBe("5");
    expect(w?.feePercent).toBe("1.5");
    expect(Object.keys(w?.types ?? {})).toEqual(["bank_account"]);
    expect(w?.types.bank_account?.fields.dest).toEqual({ description: "Account number" });
    expect(w?.types.bank_account?.fields.dest_extra).toEqual({
      description: "CBU",
      optional: true,
    });
    expect(w?.types.bank_account?.fields.type).toEqual({ choices: ["A", "B"] });
    expect(info.withdrawExchange.ARS?.minAmount).toBe("20");
  });

  it("drops malformed sections and entries rather than throwing", () => {
    const info = parseSep6Info({ withdraw: "nope", "withdraw-exchange": { ARS: null } });
    expect(info.withdraw).toEqual({});
    expect(info.withdrawExchange).toEqual({});
  });

  it("ignores amounts that do not survive as plain decimals", () => {
    const info = parseSep6Info({
      "withdraw-exchange": { ARS: { enabled: true, min_amount: 10, max_amount: 1e21 } },
    });
    expect(info.withdrawExchange.ARS?.minAmount).toBe("10");
    expect(info.withdrawExchange.ARS?.maxAmount).toBeUndefined();
  });

  it("treats a non-object document as empty", () => {
    expect(parseSep6Info(null)).toEqual({ withdraw: {}, withdrawExchange: {} });
  });
});

describe("Sep6Adapter", () => {
  it("rejects a non-SEP-6 destination with a clear error", () => {
    expect(() => new Sep6Adapter(sep31Corridor())).toThrow(
      'Sep6Adapter cannot handle protocol "sep31"',
    );
  });

  it("parses GET /info and derives capabilities from it", async () => {
    const { fn, calls } = fakeFetch({ "GET /info": res(INFO_FIXTURE) });
    const adapter = new Sep6Adapter(sep6Corridor(), { fetchImpl: fn });

    // Before discovery nothing is known, so no settlement kind is claimed.
    expect(adapter.capabilities().settlement).toEqual([]);

    const info = await adapter.info();
    expect(info.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const caps = adapter.capabilities();
    expect(caps.protocol).toBe("sep6");
    expect(caps.settlement).toEqual(["adapter_reported"]);
    // No kyc_server / quote_server on this corridor.
    expect(caps.kyc).toBe("sep6_fields");
    expect(caps.quotes).toEqual(["none"]);
    expect(caps.refunds).toBe("none");
    expect(caps.callbacks).toBe(false);
  });

  it("reports no settlement kinds when withdraw-exchange omits the dest asset", async () => {
    const fixture = { "withdraw-exchange": { USD: { enabled: true, types: {} } } };
    const adapter = new Sep6Adapter(sep6Corridor(), {
      fetchImpl: fakeFetch({ "GET /info": res(fixture) }).fn,
    });
    await adapter.info();
    expect(adapter.capabilities().settlement).toEqual([]);
  });

  it("reflects quote_server and kyc_server in capabilities", async () => {
    const adapter = new Sep6Adapter(
      sep6Corridor({
        quote_server: "https://d.example/sep38",
        kyc_server: "https://d.example/sep12",
      }),
      { fetchImpl: fakeFetch({ "GET /info": res(INFO_FIXTURE) }).fn },
    );
    await adapter.info();
    expect(adapter.capabilities().quotes).toEqual(["sep38_firm"]);
    expect(adapter.capabilities().kyc).toBe("sep12");
  });

  it("caches /info per instance", async () => {
    const { fn, calls } = fakeFetch({ "GET /info": res(INFO_FIXTURE) });
    const adapter = new Sep6Adapter(sep6Corridor(), { fetchImpl: fn });
    await adapter.info();
    await adapter.info();
    expect(calls).toHaveLength(1);
    await adapter.info(true);
    expect(calls).toHaveLength(2);
  });

  it("fails closed when /info is unavailable", async () => {
    const adapter = new Sep6Adapter(sep6Corridor(), {
      fetchImpl: fakeFetch({ "GET /info": res({}, false, 500) }).fn,
    });
    const result = await adapter.info();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("fails closed on the verbs that are not implemented yet", async () => {
    const adapter = new Sep6Adapter(sep6Corridor(), { fetchImpl: fakeFetch({}).fn });
    const c = sep6Corridor();
    const outcomes = await Promise.all([
      adapter.requestQuote(intent, c),
      adapter.ensureCompliance(intent, c),
      adapter.openTransaction(intent, quote, c),
      adapter.requestRefund("tx1", { asset: "USDC", amount: "1" }, "why"),
    ]);
    for (const r of outcomes) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("ANCHOR_UNAVAILABLE");
    }
  });
});

describe("mapSep6Status", () => {
  const cases: Array<{
    status: string;
    expected: {
      settled: boolean;
      terminalFailure: boolean;
      awaitingInput: boolean;
      phase?: "anchor" | "external";
    };
  }> = [
    // Success / settled
    {
      status: "completed",
      expected: { settled: true, terminalFailure: false, awaitingInput: false },
    },
    // Terminal failures
    {
      status: "refunded",
      expected: { settled: false, terminalFailure: true, awaitingInput: false },
    },
    {
      status: "expired",
      expected: { settled: false, terminalFailure: true, awaitingInput: false },
    },
    {
      status: "error",
      expected: { settled: false, terminalFailure: true, awaitingInput: false },
    },
    {
      status: "no_market",
      expected: { settled: false, terminalFailure: true, awaitingInput: false },
    },
    {
      status: "too_small",
      expected: { settled: false, terminalFailure: true, awaitingInput: false },
    },
    {
      status: "too_large",
      expected: { settled: false, terminalFailure: true, awaitingInput: false },
    },
    // Awaiting input
    {
      status: "pending_customer_info_update",
      expected: { settled: false, terminalFailure: false, awaitingInput: true },
    },
    {
      status: "pending_transaction_info_update",
      expected: { settled: false, terminalFailure: false, awaitingInput: true },
    },
    {
      status: "pending_user",
      expected: { settled: false, terminalFailure: false, awaitingInput: true },
    },
    // In-flight
    {
      status: "pending_anchor",
      expected: { settled: false, terminalFailure: false, awaitingInput: false },
    },
    {
      status: "pending_stellar",
      expected: { settled: false, terminalFailure: false, awaitingInput: false },
    },
    {
      status: "pending_external",
      expected: {
        settled: false,
        terminalFailure: false,
        awaitingInput: false,
        phase: "external",
      },
    },
    {
      status: "pending_trust",
      expected: { settled: false, terminalFailure: false, awaitingInput: false },
    },
    {
      status: "pending_user_transfer_start",
      expected: { settled: false, terminalFailure: false, awaitingInput: false },
    },
    {
      status: "pending_user_transfer_complete",
      expected: { settled: false, terminalFailure: false, awaitingInput: false },
    },
  ];

  it.each(cases)("maps '$status' correctly", ({ status, expected }) => {
    const res = mapSep6Status(status);
    expect(res.status).toBe(status);
    expect(res.settled).toBe(expected.settled);
    expect(res.terminalFailure).toBe(expected.terminalFailure);
    expect(res.awaitingInput).toBe(expected.awaitingInput);
    if (expected.phase) {
      expect(res.phase).toBe(expected.phase);
    }
  });

  it("handles case insensitivity for all statuses", () => {
    expect(mapSep6Status("COMPLETED").settled).toBe(true);
    expect(mapSep6Status("Pending_User").awaitingInput).toBe(true);
    expect(mapSep6Status("ERROR").terminalFailure).toBe(true);
  });

  it("unknown status maps to in-flight, never settled", () => {
    const unknownStatuses = ["unknown_future_status", "processing", "foo_bar", ""];
    for (const raw of unknownStatuses) {
      const res = mapSep6Status(raw);
      expect(res.settled).toBe(false);
      expect(res.terminalFailure).toBe(false);
      expect(res.awaitingInput).toBe(false);
    }
  });
});

describe("Sep6Adapter.getTransaction", () => {
  const dummySep10: Sep10Signer = {
    account: "GBXGQJWVUFD7NAFFG2TG6VNW2L647G6B5Q2Q4D5B3N6E6F2H5I5J5K5L",
    signChallenge: async () => "signed-challenge-xdr",
  };

  it("sends auth header on poll when sep10 is configured", async () => {
    const fakeAuthRoutes = {
      "GET /auth": res({
        transaction: "challenge-tx-xdr",
        network_passphrase: "Test SDF Network ; September 2015",
      }),
      "POST /auth": res({ token: "sep10-jwt-token" }),
      "GET /transaction": res({
        transaction: {
          id: "tx-sep6-1",
          status: "completed",
          amount_in: "100.00",
        },
      }),
    };

    const { fn, calls } = fakeFetch(fakeAuthRoutes);
    const corridor = sep6Corridor({
      web_auth: "https://d.example/auth",
      home_domain: "d.example",
    });
    const adapter = new Sep6Adapter(corridor, {
      fetchImpl: fn,
      sep10: dummySep10,
    });

    const result = await adapter.getTransaction("tx-sep6-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settled).toBe(true);
      expect(result.value.status).toBe("completed");
    }

    const txCall = calls.find((c) => c.method === "GET" && c.url.includes("/transaction"));
    expect(txCall).toBeDefined();
    expect(txCall?.headers?.authorization).toBe("Bearer sep10-jwt-token");
    expect(txCall?.url).toContain("id=tx-sep6-1");
  });

  it("correctly parses transaction fields and refunds", async () => {
    const txResponse = {
      transaction: {
        id: "tx-refunded",
        status: "refunded",
        amount_in: "100.00",
        amount_in_asset: "stellar:USDC:GISSUER",
        withdraw_anchor_account: "GBANK12345",
        withdraw_memo: "memo-test",
        withdraw_memo_type: "text",
        refunds: {
          amount_refunded: "100.00",
          amount_fee: "2.00",
          payments: [
            {
              id: "pay-1",
              id_type: "stellar",
              amount: "98.00",
              fee: "2.00",
            },
          ],
        },
      },
    };

    const { fn } = fakeFetch({ "GET /transaction": res(txResponse) });
    const adapter = new Sep6Adapter(sep6Corridor(), { fetchImpl: fn });

    const result = await adapter.getTransaction("tx-refunded");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const tx = result.value;
      expect(tx.status).toBe("refunded");
      expect(tx.settled).toBe(false);
      expect(tx.terminalFailure).toBe(true);
      expect(tx.depositAddress).toBe("GBANK12345");
      expect(tx.memo).toBe("memo-test");
      expect(tx.memoType).toBe("text");
      expect(tx.amountIn).toEqual({ asset: "stellar:USDC:GISSUER", amount: "100.00" });
      expect(tx.refunds).toBeDefined();
      expect(tx.refunds?.amountRefunded).toEqual({
        asset: "stellar:USDC:GISSUER",
        amount: "100.00",
      });
      expect(tx.refunds?.completeness).toBe("full");
      expect(tx.refunds?.payments).toHaveLength(1);
    }
  });

  it("handles HTTP errors failing closed with ANCHOR_UNAVAILABLE", async () => {
    const { fn } = fakeFetch({ "GET /transaction": res({}, false, 503) });
    const adapter = new Sep6Adapter(sep6Corridor(), { fetchImpl: fn });

    const result = await adapter.getTransaction("tx-fail");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ANCHOR_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("handles invalid response format gracefully", async () => {
    const { fn } = fakeFetch({ "GET /transaction": res({ transaction: null }) });
    const adapter = new Sep6Adapter(sep6Corridor(), { fetchImpl: fn });

    const result = await adapter.getTransaction("tx-invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ANCHOR_UNAVAILABLE");
    }
  });
});
