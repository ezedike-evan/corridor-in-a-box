import { describe, expect, it } from "vitest";
import { StaticRouteResolver } from "@corridor/router";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";

function corridor(id: string): Corridor {
  const r = parseCorridor({
    id,
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: { name: "D", asset: "iso4217:ARS", endpoints: { home_domain: "d.example" } },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent = {
  idempotencyKey: "k",
  corridorId: "test",
  sender: { id: "s" },
} as PaymentIntent;
const adapterStub = { name: "stub" } as AnchorAdapter;

describe("StaticRouteResolver", () => {
  it("returns exactly the adapter the injected factory produced", async () => {
    const resolver = new StaticRouteResolver(() => adapterStub);
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(decision.receiving).toBe(adapterStub);
  });

  it("passes the actual corridor argument through to the factory", async () => {
    const seen: string[] = [];
    const resolver = new StaticRouteResolver((c) => {
      seen.push(c.id);
      return adapterStub;
    });
    await resolver.resolve(intent, corridor("c1"));
    await resolver.resolve(intent, corridor("c2"));
    expect(seen).toEqual(["c1", "c2"]);
  });

  it("never sets split", async () => {
    const resolver = new StaticRouteResolver(() => adapterStub);
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(decision.split).toBeUndefined();
  });

  it("invokes the factory fresh on every call — no memoization", async () => {
    let calls = 0;
    const resolver = new StaticRouteResolver(() => {
      calls++;
      return adapterStub;
    });
    const c = corridor("c1");
    await resolver.resolve(intent, c);
    await resolver.resolve(intent, c);
    expect(calls).toBe(2);
  });
});
