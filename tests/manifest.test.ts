import { describe, expect, it } from "vitest";
import { parseCorridor, parseCorridorWithWarnings, protocolOf } from "@corridor/manifest";
import { Sep31Adapter } from "@corridor/sep31";

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

  describe("protocol union and backward compatibility", () => {
    it("parses a legacy manifest with no protocol and sets protocolOf(c.dest) === 'sep31'", () => {
      const r = parseCorridor(valid);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.dest.protocol).toBe("sep31");
        expect(protocolOf(r.value.dest)).toBe("sep31");
      }
    });

    it("emits a deprecation warning for a legacy manifest without protocol", () => {
      const r = parseCorridor(valid);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.warnings).toBeDefined();
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.warnings.some((w) => w.includes("sep31") && w.includes("deprecated"))).toBe(
          true,
        );
      }

      const rWith = parseCorridorWithWarnings(valid);
      expect(rWith.ok).toBe(true);
      if (rWith.ok) {
        expect(rWith.warnings.length).toBeGreaterThan(0);
      }
    });

    it("does not emit deprecation warnings when protocol is explicitly set", () => {
      const explicit = {
        ...valid,
        dest: {
          ...valid.dest,
          protocol: "sep31",
        },
      };
      const r = parseCorridor(explicit);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.warnings).toEqual([]);
      }
    });

    it("rejects a manifest with no protocol but a transfer_server key with a message to set protocol: sep6", () => {
      const legacyWithSep6Key = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          endpoints: {
            home_domain: "d.example",
            transfer_server: "https://d.example/sep6",
          },
        },
      };
      const r = parseCorridor(legacyWithSep6Key);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("MANIFEST_INVALID");
        expect(r.error.message).toContain("transfer_server");
        expect(r.error.message).toContain("protocol: sep6");
      }
    });

    it("rejects a manifest with no protocol but a base_url key with a message to set protocol: custom:<name>", () => {
      const legacyWithCustomKey = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          endpoints: {
            home_domain: "d.example",
            base_url: "https://d.example/api",
          },
        },
      };
      const r = parseCorridor(legacyWithCustomKey);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("MANIFEST_INVALID");
        expect(r.error.message).toContain("base_url");
        expect(r.error.message).toContain("custom:<name>");
      }
    });

    it("accepts a protocol: sep6 dest with transfer_server and rejects one missing it", () => {
      const validSep6 = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "sep6",
          endpoints: {
            home_domain: "d.example",
            transfer_server: "https://d.example/sep6",
          },
        },
      };
      const r1 = parseCorridor(validSep6);
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        expect(protocolOf(r1.value.dest)).toBe("sep6");
      }

      const invalidSep6 = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "sep6",
          endpoints: {
            home_domain: "d.example",
          },
        },
      };
      const r2 = parseCorridor(invalidSep6);
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.error.code).toBe("MANIFEST_INVALID");
        expect(r2.error.message).toContain("transfer_server");
      }
    });

    it("accepts protocol: custom:acme with base_url, rejects protocol: custom: and protocol: sep24", () => {
      const validCustom = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "custom:acme",
          endpoints: {
            home_domain: "d.example",
            base_url: "https://d.example/api",
            extra: { tenantId: "123" },
          },
        },
      };
      const r1 = parseCorridor(validCustom);
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        expect(protocolOf(r1.value.dest)).toBe("custom:acme");
      }

      const invalidCustomMissingBaseUrl = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "custom:acme",
          endpoints: {
            home_domain: "d.example",
          },
        },
      };
      const r2 = parseCorridor(invalidCustomMissingBaseUrl);
      expect(r2.ok).toBe(false);

      const invalidCustomMalformed = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "custom:",
          endpoints: {
            home_domain: "d.example",
            base_url: "https://d.example/api",
          },
        },
      };
      const r3 = parseCorridor(invalidCustomMalformed);
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.error.message).toContain("custom:");
      }

      const invalidProtocolSep24 = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "sep24",
          endpoints: {
            home_domain: "d.example",
          },
        },
      };
      const r4 = parseCorridor(invalidProtocolSep24);
      expect(r4.ok).toBe(false);
      if (!r4.ok) {
        expect(r4.error.message).toContain("sep24");
      }
    });

    it("validates valid + invalid manifest per protocol branch", () => {
      // SEP-31 valid + invalid
      const validSep31 = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "sep31",
          endpoints: {
            home_domain: "d.example",
            transfer_server_sep31: "https://d.example/sep31",
          },
        },
      };
      expect(parseCorridor(validSep31).ok).toBe(true);

      const invalidSep31 = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "sep31",
          endpoints: {
            home_domain: "d.example",
            transfer_server_sep31: "not-a-url",
          },
        },
      };
      expect(parseCorridor(invalidSep31).ok).toBe(false);

      // SEP-6 valid + invalid
      const validSep6 = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "sep6",
          endpoints: {
            home_domain: "d.example",
            transfer_server: "https://d.example/sep6",
          },
        },
      };
      expect(parseCorridor(validSep6).ok).toBe(true);

      const invalidSep6 = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "sep6",
          endpoints: {
            home_domain: "d.example",
            transfer_server: "not-a-valid-url",
          },
        },
      };
      expect(parseCorridor(invalidSep6).ok).toBe(false);

      // Custom valid + invalid
      const validCustom = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "custom:my-adapter",
          endpoints: {
            home_domain: "d.example",
            base_url: "https://d.example/api",
          },
        },
      };
      expect(parseCorridor(validCustom).ok).toBe(true);

      const invalidCustom = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "custom:my-adapter",
          endpoints: {
            home_domain: "d.example",
            base_url: "not-a-valid-url",
          },
        },
      };
      expect(parseCorridor(invalidCustom).ok).toBe(false);
    });

    it("Sep31Adapter returns a clear error when constructed with a non-sep31 dest", () => {
      const sep6Corridor = {
        ...valid,
        dest: {
          name: "D",
          asset: "iso4217:ARS",
          protocol: "sep6" as const,
          endpoints: {
            home_domain: "d.example",
            transfer_server: "https://d.example/sep6",
          },
        },
      };
      const parsed = parseCorridor(sep6Corridor);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(() => new Sep31Adapter(parsed.value)).toThrowError(
          /Sep31Adapter requires a sep31 dest anchor, got sep6/,
        );
      }
    });
  });
});
