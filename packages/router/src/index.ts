// @corridor/router — the open-core line drawn in code.
//
// The interface and a dumb default ship here, in the open repo. The REAL resolver
// — health-weighted, rate-aware, split-routing, fed by the anchor conformance
// dataset (the Stellar-Intel/Tideline brain) — is proprietary and injected at
// runtime. Anyone can run the open engine; only you have the routing intelligence.

import type { Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";

export interface RouteDecision {
  /** The receiving anchor chosen for this payment. */
  readonly receiving: AnchorAdapter;
  /** Reserved for split routing across multiple anchors (weights sum to 1). */
  readonly split?: ReadonlyArray<{ adapter: AnchorAdapter; weight: number }>;
}

export interface RouteResolver {
  resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision>;
}

/**
 * Default resolver: use the single anchor the manifest declares. No intelligence.
 * Swap this out for the proprietary resolver by passing a different RouteResolver
 * to the engine — that is the entire open/closed boundary.
 */
export class StaticRouteResolver implements RouteResolver {
  constructor(private readonly adapterFor: (corridor: Corridor) => AnchorAdapter) {}

  async resolve(_intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    return { receiving: this.adapterFor(corridor) };
  }
}
