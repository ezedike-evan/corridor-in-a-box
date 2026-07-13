import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { Sep31Adapter, mapSep31Status, type Sep10Signer } from "@corridor/sep31";
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
  recipient: { id: "recipient-acct" },
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
  it("classifies the SEP-31 lifecycle into settled / terminalFailure / in-flight", () => {
    expect(mapSep31Status("completed")).toEqual({
      status: "completed",
      settled: true,
      terminalFailure: false,
    });
    for (const terminal of ["error", "expired", "refunded"]) {
      expect(mapSep31Status(terminal)).toMatchObject({
        settled: false,
        terminalFailure: true,
      });
    }
    for (const pending of [
      "incomplete",
      "pending_sender",
      "pending_stellar",
      "pending_receiver",
      "pending_external",
      "something_new_we_dont_know",
    ]) {
      expect(mapSep31Status(pending)).toMatchObject({
        settled: false,
        terminalFailure: false,
      });
    }
  });

  it("is case-insensitive on the raw anchor status", () => {
    expect(mapSep31Status("COMPLETED").settled).toBe(true);
    expect(mapSep31Status("Error").terminalFailure).toBe(true);
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
