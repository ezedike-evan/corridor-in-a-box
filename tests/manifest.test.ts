import { describe, expect, it } from "vitest";
import { parseCorridor } from "@corridor/manifest";

const valid = {
  id: "t",
  source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
  dest: {
    name: "D",
    asset: "iso4217:ARS",
    endpoints: {
      home_domain: "d.example",
      transfer_server_sep31: "https://d.example/sep31",
      quote_server: "https://d.example/sep38",
    },
  },
  fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
  compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
  settlement: { network: "public", asset_issuer: "GISSUER" },
  recovery: {},
};

describe("manifest", () => {
  it("parses a valid corridor and applies defaults", () => {
    const r = parseCorridor(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("t");
      expect(r.value.fx.quote_ttl_seconds).toBe(60); // default applied
      expect(r.value.settlement.bridge_asset).toBe("USDC"); // default applied
      expect(r.value.recovery.rollback).toBe("refund_sender"); // default applied
    }
  });

  it("rejects an FX path with fewer than two hops", () => {
    const r = parseCorridor({ ...valid, fx: { path: ["ARS"], who_holds_risk: "sender" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MANIFEST_INVALID");
  });

  it("rejects a missing source", () => {
    const { source, ...rest } = valid;
    void source;
    const r = parseCorridor(rest);
    expect(r.ok).toBe(false);
  });

  describe("source.protocol", () => {
    const withSource = (source: unknown) => parseCorridor({ ...valid, source });

    it("defaults an absent protocol to prefunded (existing manifests unchanged)", () => {
      const r = parseCorridor(valid);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.source.protocol).toBe("prefunded");
    });

    it("accepts prefunded with only name and asset", () => {
      const r = withSource({ name: "Treasury", asset: "USDC", protocol: "prefunded" });
      expect(r.ok).toBe(true);
    });

    it("accepts sep6 with transfer_server and rejects it without", () => {
      const base = { name: "S", asset: "USDC", protocol: "sep6" };
      const good = withSource({
        ...base,
        endpoints: { home_domain: "s.example", transfer_server: "https://s.example/sep6" },
      });
      expect(good.ok).toBe(true);
      const bad = withSource({ ...base, endpoints: { home_domain: "s.example" } });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("MANIFEST_INVALID");
    });

    it("accepts sep24 with transfer_server_sep24 + web_auth and rejects a missing one", () => {
      const base = { name: "S", asset: "USDC", protocol: "sep24" };
      const good = withSource({
        ...base,
        endpoints: {
          home_domain: "s.example",
          transfer_server_sep24: "https://s.example/sep24",
          web_auth: "https://s.example/auth",
        },
      });
      expect(good.ok).toBe(true);
      const noAuth = withSource({
        ...base,
        endpoints: {
          home_domain: "s.example",
          transfer_server_sep24: "https://s.example/sep24",
        },
      });
      expect(noAuth.ok).toBe(false);
    });

    it("accepts custom:<id> with base_url and rejects unknown protocols", () => {
      const good = withSource({
        name: "S",
        asset: "USDC",
        protocol: "custom:acme",
        endpoints: { home_domain: "s.example", base_url: "https://s.example/api" },
      });
      expect(good.ok).toBe(true);
      const noUrl = withSource({
        name: "S",
        asset: "USDC",
        protocol: "custom:acme",
        endpoints: { home_domain: "s.example" },
      });
      expect(noUrl.ok).toBe(false);
      const unknown = withSource({ name: "S", asset: "USDC", protocol: "sep99" });
      expect(unknown.ok).toBe(false);
    });
  });
});
