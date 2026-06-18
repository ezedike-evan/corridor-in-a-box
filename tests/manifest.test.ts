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
});
