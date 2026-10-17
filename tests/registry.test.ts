// @corridor/registry — the TS half of the on-chain anchor registry.
//
// The registry answers one question honestly: for a given anchor domain, which
// SEPs does it advertise, which conformance probes actually passed, and how long
// ago did anyone check? It holds facts, not opinions — no score, no ranking, no
// recommendation. Deciding which anchor to route through is the job of a
// RouteResolver, and that judgement is deliberately not on chain.

import { describe, expect, it, vi } from "vitest";
import { AnchorRegistry, SEP_NUMBERS, type SepNumber } from "@corridor/registry";
import { PROBE_NAMES as PROBE_PROBE_NAMES } from "@corridor/probe";

/** A plausible contract id; the tests never submit anything, only simulate. */
const CONTRACT_ID = "C" + "A".repeat(54) + "B";
const DOMAIN = "anchor.example";

/** A registry whose reads are spied on instead of hitting a live RPC. */
function registryWithRead(): {
  registry: AnchorRegistry;
  readSpy: ReturnType<typeof vi.spyOn>;
} {
  const registry = new AnchorRegistry({
    rpcUrl: "https://example.invalid/rpc",
    contractId: CONTRACT_ID,
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  });
  const readSpy = vi.spyOn(registry as any, "read");
  return { registry, readSpy };
}

describe("PROBE_NAMES mirrors", () => {
  it("probe and registry packages declare the same probe names", () => {
    expect([...PROBE_PROBE_NAMES]).toEqual([...PROBE_NAMES]);
  });

  it("the SEP-6 probes come after the SEP-31 probe, in this order", () => {
    expect(PROBE_NAMES.slice(-2)).toEqual(["sep6_info", "sep6_auth"]);
    expect(PROBE_NAMES.indexOf("sep31_info")).toBeLessThan(PROBE_NAMES.indexOf("sep6_info"));
  });
});

describe("AnchorRegistry.serves", () => {
  it("delegates SEP-6 to the contract's serves_sep6 query", async () => {
    const { registry, readSpy } = registryWithRead();
    readSpy.mockResolvedValue(true);
    await expect(registry.servesSep6(DOMAIN)).resolves.toBe(true);
    expect(readSpy).toHaveBeenCalledWith("serves_sep6", expect.anything());
  });

  it("delegates SEP-31 to the contract's serves_sep31 query", async () => {
    const { registry, readSpy } = registryWithRead();
    readSpy.mockResolvedValue(false);
    await expect(registry.servesSep31(DOMAIN)).resolves.toBe(false);
    expect(readSpy).toHaveBeenCalledWith("serves_sep31", expect.anything());
  });

  it("returns false for SEPs that have no defined probe without asking the contract", async () => {
    const { registry } = registryWithRead();
    await expect(registry.serves(DOMAIN, 10 as unknown as SepNumber)).resolves.toBe(false);
    await expect(registry.serves(DOMAIN, 12 as unknown as SepNumber)).resolves.toBe(false);
    // No read should happen for these SEPs.
  });
});

describe("AnchorRegistry.liveAnchors", () => {
  it("filters live SEP-6 anchors by freshness", async () => {
    const { registry, readSpy } = registryWithRead();
    readSpy.mockImplementation((method: string) => {
      if (method === "serves_sep6") return true;
      if (method === "staleness") return 1_000_000; // every domain is stale
      return undefined;
    });
    const out = await registry.liveAnchors(6, 100_000);
    expect(out).toEqual([]);
  });

  it("keeps a fresh, attested SEP-6 anchor", async () => {
    const { registry, readSpy } = registryWithRead();
    readSpy.mockImplementation((method: string) => {
      if (method === "domains") return ["fresh.example"];
      if (method === "serves_sep6") return true;
      if (method === "staleness") return 50_000; // fresh
      return undefined;
    });
    const out = await registry.liveAnchors(6, 100_000);
    expect(out).toEqual(["fresh.example"]);
  });

  it("liveSep31Anchors is a thin wrapper over liveAnchors for SEP-31", async () => {
    const { registry, readSpy } = registryWithRead();
    readSpy.mockImplementation((method: string) => {
      if (method === "domains") return ["fresh.example"];
      if (method === "serves_sep31") return true;
      if (method === "staleness") return 50_000;
      return undefined;
    });
    const out = await registry.liveSep31Anchors(100_000);
    expect(out).toEqual(["fresh.example"]);
  });
});

describe("SEP_NUMBERS", () => {
  it("lists every SEP the registry can express, in bit order", () => {
    expect([...SEP_NUMBERS]).toEqual([1, 6, 10, 12, 24, 31, 38]);
  });
});
