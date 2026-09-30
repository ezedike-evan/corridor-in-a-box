import { describe, expect, it } from "vitest";
import { liveness, parseCorridor } from "@corridor/manifest";

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

describe("recovery.reconcile", () => {
  it("is optional and leaves the fields unset by default", () => {
    const r = parseCorridor(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recovery.reconcile).toBeUndefined();
  });

  it("parses poll_seconds and stall_polls (0 allowed to disable)", () => {
    const r = parseCorridor({
      ...valid,
      recovery: { reconcile: { poll_seconds: 5, stall_polls: 0 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recovery.reconcile).toEqual({ poll_seconds: 5, stall_polls: 0 });
    const partial = parseCorridor({ ...valid, recovery: { reconcile: { stall_polls: 4 } } });
    expect(partial.ok && partial.value.recovery.reconcile?.poll_seconds).toBeUndefined();
  });

  it("rejects non-positive poll_seconds and negative stall_polls", () => {
    for (const reconcile of [
      { poll_seconds: 0 },
      { poll_seconds: 1.5 },
      { stall_polls: -1 },
    ]) {
      expect(parseCorridor({ ...valid, recovery: { reconcile } }).ok).toBe(false);
    }
  });

  it("warns when poll_seconds x stall_polls can never fire before the timeout", () => {
    const mk = (reconcile: object) => {
      const r = parseCorridor({ ...valid, recovery: { timeout_seconds: 60, reconcile } });
      if (!r.ok) throw new Error("invalid");
      return liveness(r.value).warnings.filter((w) =>
        w.includes("stall check can never fire"),
      );
    };
    expect(mk({ poll_seconds: 10, stall_polls: 6 })).toHaveLength(1);
    expect(mk({ poll_seconds: 12, stall_polls: 5 })).toHaveLength(1);
    expect(mk({ poll_seconds: 10, stall_polls: 4 })).toHaveLength(0);
    expect(mk({ poll_seconds: 10, stall_polls: 0 })).toHaveLength(0);
  });
});
