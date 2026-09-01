import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { Sep31Adapter, mapSep31Status, parseRefunds, type Sep10Signer } from "@corridor/sep31";
import type { PaymentIntent } from "@corridor/types";

const PASSPHRASE = "Test SDF Network ; September 2015";

function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url");
  return `header.${payload}.sig`;
}

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
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
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

function corridor(
  endpoints: Record<string, string>,
  settlement: Record<string, string> = {},
): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: { home_domain: "d.example", ...endpoints },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER", ...settlement },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "k",
  corridorId: "test",
  sender: { id: "s" },
  // sep12Id is the customer id the RECEIVING anchor issued at registration. It
  // is what SEP-12 status is looked up by and what SEP-31 open sends as
  // receiver_id; without it the adapter fails closed rather than checking the
  // operator's own account (see tests/security.test.ts).
  recipient: { id: "recipient-acct", sep12Id: "anchor-cust-1" },
  sourceAmount: { asset: "USDC", amount: "100" },
};

describe("SEP-10 auth", () => {
  it("does the challenge/response handshake and attaches the JWT", async () => {
    const token = jwt(900);
    const signer: Sep10Signer = {
      account: "GSIGNER",
      signChallenge: async (xdr, pass) => {
        expect(pass).toBe(PASSPHRASE);
        return `signed(${xdr})`;
      },
    };
    const { fn, calls } = fakeFetch({
      "GET /auth": res({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE }),
      "POST /auth": res({ token }),
      "POST /sep38/quote": res({
        id: "q1",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
      }),
    });
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      web_auth: "https://d.example/auth",
      quote_server: "https://d.example/sep38",
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn, sep10: signer });

    const q = await adapter.requestQuote(intent, c);
    expect(q.ok).toBe(true);

    const quoteCall = calls.find((x) => x.url.includes("/sep38/quote"));
    expect(quoteCall?.headers.authorization).toBe(`Bearer ${token}`);
    // challenge GET happened before the token POST
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("account=GSIGNER");
  });

  it("calls anonymously when no signer is configured", async () => {
    const { fn, calls } = fakeFetch({
      "POST /sep38/quote": res({
        id: "q1",
        price: "1.0",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        sell_amount: "100",
        buy_amount: "100",
      }),
    });
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      web_auth: "https://d.example/auth",
      quote_server: "https://d.example/sep38",
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    const q = await adapter.requestQuote(intent, c);
    expect(q.ok).toBe(true);
    expect(calls.every((x) => !x.url.includes("/auth"))).toBe(true);
  });
});

describe("SEP-38 quote request shape", () => {
  const quoteRoute = {
    "POST /sep38/quote": res({
      id: "q1",
      price: "1.0",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      sell_amount: "100",
      buy_amount: "100",
    }),
  };
  const endpoints = {
    transfer_server_sep31: "https://d.example/sep31",
    quote_server: "https://d.example/sep38",
  };

  // Live anchors reject issuer-less asset ids and quotes without a context —
  // this pins the exact body SEP-38 requires.
  it("sends context=sep31 and an issuer-qualified sell_asset", async () => {
    const { fn, calls } = fakeFetch(quoteRoute);
    const c = corridor(endpoints);
    const q = await new Sep31Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(q.ok).toBe(true);
    const body = calls.find((x) => x.url.includes("/sep38/quote"))?.body as Record<
      string,
      string
    >;
    expect(body.context).toBe("sep31");
    expect(body.sell_asset).toBe("stellar:USDC:GISSUER");
    expect(body.buy_asset).toBe("iso4217:ARS");
    expect(body.sell_amount).toBe("100");
  });

  it("sends stellar:native when the bridge asset is XLM", async () => {
    const { fn, calls } = fakeFetch(quoteRoute);
    const c = corridor(endpoints, { bridge_asset: "XLM" });
    const q = await new Sep31Adapter(c, { fetchImpl: fn }).requestQuote(intent, c);
    expect(q.ok).toBe(true);
    const body = calls.find((x) => x.url.includes("/sep38/quote"))?.body as Record<
      string,
      string
    >;
    expect(body.sell_asset).toBe("stellar:native");
  });
});

describe("SEP-31 status mapping", () => {
  it("classifies `completed` as settled and nothing else", () => {
    expect(mapSep31Status("completed")).toEqual({
      status: "completed",
      settled: true,
      terminalFailure: false,
      awaitingInput: false,
    });
  });

  it("classifies the terminal non-success statuses as terminalFailure", () => {
    for (const terminal of ["error", "expired", "refunded"]) {
      expect(mapSep31Status(terminal)).toEqual({
        status: terminal,
        settled: false,
        terminalFailure: true,
        awaitingInput: false,
      });
    }
  });

  it("classifies the Anchor Platform's in-flight statuses as in-flight", () => {
    for (const pending of [
      "pending_sender",
      "pending_receiver",
      "pending_external",
      "pending_anchor",
      "pending_stellar",
    ]) {
      expect(mapSep31Status(pending)).toEqual({
        status: pending,
        settled: false,
        terminalFailure: false,
        awaitingInput: false,
      });
    }
  });

  it("flags the statuses that are blocked on someone else's input", () => {
    // Still in flight — the engine keeps polling — but the hold-up is a party
    // owing the anchor information, not the anchor doing its work.
    for (const blocked of [
      "incomplete",
      "pending_customer_info_update",
      "pending_transaction_info_update",
    ]) {
      expect(mapSep31Status(blocked)).toEqual({
        status: blocked,
        settled: false,
        terminalFailure: false,
        awaitingInput: true,
      });
    }
  });

  it("treats an unrecognised status as in-flight, never as settled", () => {
    expect(mapSep31Status("something_new_we_dont_know")).toEqual({
      status: "something_new_we_dont_know",
      settled: false,
      terminalFailure: false,
      awaitingInput: false,
    });
    expect(mapSep31Status("").settled).toBe(false);
  });

  it("is case-insensitive on the raw anchor status", () => {
    expect(mapSep31Status("COMPLETED").settled).toBe(true);
    expect(mapSep31Status("Error").terminalFailure).toBe(true);
    expect(mapSep31Status("Pending_Customer_Info_Update").awaitingInput).toBe(true);
    expect(mapSep31Status("PENDING_ANCHOR").awaitingInput).toBe(false);
  });

  it("getTransaction reflects the mapping for the anchor's reported status", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    for (const [raw, settled, terminal] of [
      ["completed", true, false],
      ["pending_receiver", false, false],
      ["error", false, true],
      ["refunded", false, true],
    ] as const) {
      const { fn } = fakeFetch({
        "GET /sep31/transactions/": res({ transaction: { status: raw } }),
      });
      const adapter = new Sep31Adapter(c, { fetchImpl: fn });
      const r = await adapter.getTransaction("tx-1");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.settled).toBe(settled);
        expect(r.value.terminalFailure ?? false).toBe(terminal);
      }
    }
  });

  // --- SEP-31 `refunds` (#56) --------------------------------------------
  //
  // A refund flips the status to `refunded`, which the mapping above already
  // classifies as a terminal failure. What was missing is everything else: how
  // much came back, what the anchor kept, and whether the refund was partial.

  const REFUND_ASSET = "stellar:USDC:GISSUER";

  async function getTx(transaction: Record<string, unknown>) {
    const c = corridor(
      { transfer_server_sep31: "https://d.example/sep31" },
      {
        bridge_asset: "USDC",
      },
    );
    const { fn } = fakeFetch({
      "GET /sep31/transactions/": res({ transaction }),
    });
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });
    return adapter.getTransaction("tx-1");
  }

  it("leaves refunds absent when the anchor does not report any", async () => {
    const r = await getTx({
      status: "completed",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.refunds).toBeUndefined();
    // Absent, not a zero-filled placeholder: "refunded nothing" and "said
    // nothing" must stay distinguishable.
    expect(r.value.settled).toBe(true);
  });

  it("parses a full refund and classifies it as full", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100.0000000",
      amount_in_asset: REFUND_ASSET,
      refunds: {
        amount_refunded: "100",
        amount_fee: "0",
        payments: [{ id: "abc123", id_type: "stellar", amount: "100", fee: "0" }],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Terminal-failure classification is unchanged by refund parsing.
    expect(r.value.terminalFailure).toBe(true);
    expect(r.value.refunds?.completeness).toBe("full");
    // "100" vs "100.0000000" — equal as money, unequal as strings.
    expect(r.value.refunds?.amountRefunded).toEqual({ asset: REFUND_ASSET, amount: "100" });
    expect(r.value.refunds?.amountFee).toEqual({ asset: REFUND_ASSET, amount: "0" });
    expect(r.value.refunds?.payments).toEqual([
      {
        id: "abc123",
        idType: "stellar",
        amount: { asset: REFUND_ASSET, amount: "100" },
        fee: { asset: REFUND_ASSET, amount: "0" },
      },
    ]);
  });

  it("distinguishes a partial refund from a full one", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: { amount_refunded: "40.5", amount_fee: "1.25", payments: [] },
    });
    expect(r.ok && r.value.refunds?.completeness).toBe("partial");
    expect(r.ok && r.value.refunds?.amountRefunded.amount).toBe("40.5");
    expect(r.ok && r.value.refunds?.amountFee.amount).toBe("1.25");
  });

  it("carries multiple payments entries", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: {
        amount_refunded: "100",
        amount_fee: "2",
        payments: [
          { id: "p1", id_type: "stellar", amount: "60", fee: "1" },
          { id: "p2", id_type: "external", amount: "40", fee: "1" },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.refunds?.payments).toHaveLength(2);
    expect(r.value.refunds?.payments.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(r.value.refunds?.payments[1]?.idType).toBe("external");
  });

  it("falls back to the corridor's bridge asset when the anchor names none", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      refunds: { amount_refunded: "100" },
    });
    expect(r.ok && r.value.refunds?.amountRefunded.asset).toBe("USDC");
  });

  it("reports completeness as unknown when there is nothing to compare against", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in_asset: REFUND_ASSET,
      refunds: { amount_refunded: "40" },
    });
    // No amount_in: the caller is told we do not know, not handed a guess.
    expect(r.ok && r.value.refunds?.completeness).toBe("unknown");
  });

  it("treats an over-refund as full rather than partial", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: { amount_refunded: "101" },
    });
    expect(r.ok && r.value.refunds?.completeness).toBe("full");
  });

  it("never throws and never changes the classification on garbage refunds", async () => {
    const garbage: unknown[] = [
      null,
      "refunded",
      [],
      42,
      {},
      { amount_refunded: null },
      // A number has already been through a float64 — refuse it rather than
      // laundering the lost precision into a Money.
      { amount_refunded: 100 },
      { amount_refunded: "not-a-number" },
      { amount_refunded: "1e5" },
    ];

    for (const refunds of garbage) {
      const r = await getTx({
        status: "refunded",
        amount_in: "100",
        amount_in_asset: REFUND_ASSET,
        refunds,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.refunds).toBeUndefined();
      // The status classification is decided independently and is untouched.
      expect(r.value.status).toBe("refunded");
      expect(r.value.terminalFailure).toBe(true);
    }
  });

  it("drops an unreadable payments entry without dropping the refund", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: {
        amount_refunded: "100",
        payments: [
          { id: "good", amount: "100", fee: "0" },
          { id: "no-amount" },
          { amount: "10" },
          null,
          "nonsense",
          { id: "bad-amount", amount: 10 },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.refunds?.payments.map((p) => p.id)).toEqual(["good"]);
    // Totals still describe the refund even though entries were dropped.
    expect(r.value.refunds?.amountRefunded.amount).toBe("100");
  });

  it("defaults a missing or unreadable fee to zero, not to undefined", async () => {
    const r = await getTx({
      status: "refunded",
      amount_in: "100",
      amount_in_asset: REFUND_ASSET,
      refunds: { amount_refunded: "100", amount_fee: {} },
    });
    expect(r.ok && r.value.refunds?.amountFee.amount).toBe("0");
  });

  it("parseRefunds is directly callable and pure", () => {
    expect(parseRefunds(undefined, "USDC", "100")).toBeUndefined();
    expect(parseRefunds({ amount_refunded: "  50  " }, "USDC", "100")).toEqual({
      amountRefunded: { asset: "USDC", amount: "50" },
      amountFee: { asset: "USDC", amount: "0" },
      payments: [],
      completeness: "partial",
    });
  });
});

describe("SEP-12 compliance", () => {
  it("treats a corridor with no kyc_server as 1:1 accepted", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const adapter = new Sep31Adapter(c, { fetchImpl: fakeFetch({}).fn });
    const r = await adapter.ensureCompliance(intent, c);
    expect(r.ok && r.value.status).toBe("accepted");
  });

  it("maps SEP-12 statuses to accepted / pending / rejected", async () => {
    const c = corridor({
      transfer_server_sep31: "https://d.example/sep31",
      kyc_server: "https://d.example/sep12",
    });
    for (const [sep12, expected] of [
      ["ACCEPTED", "accepted"],
      ["PROCESSING", "pending"],
      ["NEEDS_INFO", "pending"],
      ["REJECTED", "rejected"],
    ] as const) {
      const { fn } = fakeFetch({ "GET /sep12/customer": res({ id: "c1", status: sep12 }) });
      const adapter = new Sep31Adapter(c, { fetchImpl: fn });
      const r = await adapter.ensureCompliance(intent, c);
      expect(r.ok && r.value.status).toBe(expected);
    }
  });
});

describe("refund initiation (deliberately unsupported)", () => {
  // SEP-31 has no sender-initiated refund endpoint: a refund is initiated by
  // the RECEIVING anchor and only reported back on the transaction record.
  // The generic adapter must fail closed rather than invent an endpoint.
  it("fails closed with a non-retryable REFUND_UNSUPPORTED", async () => {
    const c = corridor({ transfer_server_sep31: "https://d.example/sep31" });
    const { fn, calls } = fakeFetch({});
    const adapter = new Sep31Adapter(c, { fetchImpl: fn });

    const r = await adapter.requestRefund("tx-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REFUND_UNSUPPORTED");
      expect(r.error.retryable).toBe(false);
      // The message must carry the reason and the alternative, so an operator
      // reading a run's lastError knows this is protocol, not an outage.
      expect(r.error.message).toContain("no sender-initiated refund endpoint");
      expect(r.error.message).toContain("out-of-band");
    }
    // Fail-closed means CLOSED: no bespoke HTTP call dressed up as SEP-31.
    expect(calls).toHaveLength(0);
  });
});
