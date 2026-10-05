import { describe, expect, it, vi } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import {
  ExternalQuoteProvider,
  createMockAdapter,
  type ExternalQuoteFn,
} from "@corridor/adapter-kit";
import { Sep31Adapter } from "@corridor/sep31";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  execute,
  type EngineDeps,
} from "@corridor/engine";
import { fail, ok, type PaymentIntent } from "@corridor/types";

function corridor(
  fx: Record<string, unknown> = {},
  endpoints: Record<string, string> = {},
): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:NGN",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
        ...endpoints,
      },
    },
    fx: {
      path: ["USDC", "NGN"],
      who_holds_risk: "sender",
      quote_source: "external",
      ...fx,
    },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "NG" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: { max_retries: 2 },
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

const intent: PaymentIntent = {
  idempotencyKey: "ext-1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

function deps(over: Partial<EngineDeps> = {}, adapterOpts = {}): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
    ...over,
  };
}

const feed: ExternalQuoteFn = async () => ok({ price: "1500.5" });

describe("quote_source: external", () => {
  it("reaches completed with an injected provider", async () => {
    const spy = vi.fn(feed);
    const r = await execute(intent, corridor(), deps({ externalQuote: spy }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.state).toBe("completed");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("makes no SEP-38 HTTP call (spy fetchImpl) and never calls adapter.requestQuote", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network must not be touched for a quote");
    });
    const c = corridor({}, { quote_server: "https://d.example/sep38" });
    const sep31 = new Sep31Adapter(c, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const requestQuote = vi.spyOn(sep31, "requestQuote");
    const d = deps({
      resolver: new StaticRouteResolver(() => sep31, {
        trustManifestWithoutAttestation: true,
      }),
      externalQuote: feed,
    });
    await execute(intent, c, d); // later steps may fail against the fake fetch; only quoting matters
    expect(requestQuote).not.toHaveBeenCalled();
    const quoteCalls = (fetchImpl.mock.calls as unknown[][]).filter((a) =>
      String(a[0]).includes("/sep38"),
    );
    expect(quoteCalls).toHaveLength(0);
  });

  it("fails before quoted when no provider is injected", async () => {
    const r = await execute(intent, corridor(), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("QUOTE_UNAVAILABLE");
      expect(r.error.message).toContain("externalQuote");
    }
  });

  it("propagates a provider failure as a failed run", async () => {
    const r = await execute(
      intent,
      corridor(),
      deps({ externalQuote: async () => fail("QUOTE_UNAVAILABLE", "feed down") }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("feed down");
  });

  it("converts a throwing provider into QUOTE_UNAVAILABLE", async () => {
    const r = await execute(
      intent,
      corridor(),
      deps({
        externalQuote: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUOTE_UNAVAILABLE");
  });
});

describe("external + who_holds_risk: receiving_anchor", () => {
  const c = () => corridor({ who_holds_risk: "receiving_anchor" });

  it("is refused before open when the adapter has no native quotes", async () => {
    const spy = vi.fn(feed);
    const r = await execute(intent, c(), deps({ externalQuote: spy }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("MANIFEST_INVALID");
      expect(r.error.message).toContain("receiving_anchor");
      expect(r.error.message).toContain("native");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("never opens a transaction when refused", async () => {
    const openTransaction = vi.fn();
    const adapter = { ...createMockAdapter(), openTransaction };
    const r = await execute(
      intent,
      c(),
      deps({
        resolver: new StaticRouteResolver(() => adapter, {
          trustManifestWithoutAttestation: true,
        }),
        externalQuote: feed,
      }),
    );
    expect(r.ok).toBe(false);
    expect(openTransaction).not.toHaveBeenCalled();
  });

  it("is allowed when the adapter reports native quotes", async () => {
    const r = await execute(
      intent,
      c(),
      deps({ externalQuote: feed }, { capabilities: { quotes: ["native"] } }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("ExternalQuoteProvider", () => {
  const c = corridor();

  it("returns a non-firm quote with derived destAmount and default expiry", async () => {
    const p = new ExternalQuoteProvider(feed, () => 1_000);
    const q = await p.quote(intent, c);
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.firm).toBe(false);
      expect(q.value.price).toBe("1500.5");
      expect(q.value.destAmount).toEqual({ asset: "iso4217:NGN", amount: "150050" });
      expect(q.value.expiresAt).toBe(1_000 + c.fx.quote_ttl_seconds * 1000);
    }
  });

  it("honours a provider destAmount and expiresAt", async () => {
    const p = new ExternalQuoteProvider(async () =>
      ok({
        price: "2",
        destAmount: { asset: "iso4217:NGN", amount: "199" },
        expiresAt: 42,
      }),
    );
    const q = await p.quote(intent, c);
    expect(q.ok && q.value.destAmount.amount).toBe("199");
    expect(q.ok && q.value.expiresAt).toBe(42);
  });

  it.each(["0", "-1", "abc", ""])("rejects price %j", async (price) => {
    const q = await new ExternalQuoteProvider(async () => ok({ price })).quote(intent, c);
    expect(q.ok).toBe(false);
  });

  it("an expired non-firm external quote does not trip QUOTE_EXPIRED", async () => {
    const r = await execute(
      intent,
      corridor(),
      deps({ externalQuote: async () => ok({ price: "1", expiresAt: 1 }) }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("capabilities()", () => {
  it("Sep31Adapter reports quotes: none without a quote_server", () => {
    const caps = new Sep31Adapter(corridor()).capabilities();
    expect(caps.quotes).toEqual(["none"]);
    expect(caps.kyc).toBe("none");
    expect(caps.refunds).toBe("report_only");
  });

  it("Sep31Adapter reports sep38_firm and sep12 when servers are configured", () => {
    const caps = new Sep31Adapter(
      corridor(
        {},
        { quote_server: "https://d.example/sep38", kyc_server: "https://d.example/kyc" },
      ),
    ).capabilities();
    expect(caps.quotes).toEqual(["sep38_firm"]);
    expect(caps.kyc).toBe("sep12");
  });

  it("mock adapter capabilities are overridable", () => {
    expect(createMockAdapter().capabilities().quotes).toEqual(["sep38_firm"]);
    expect(
      createMockAdapter({
        capabilities: { quotes: ["native"], callbacks: true },
      }).capabilities(),
    ).toMatchObject({ quotes: ["native"], callbacks: true, protocol: "mock" });
  });
});
