// @corridor/router — the RouteResolver seam drawn in code.
//
// The interface and two open resolvers ship here: StaticRouteResolver (trust the
// manifest) and RegistryRouteResolver (require a fresh on-chain attestation). A
// resolver weighted by anchor health, conformance, latency, and proprietary
// routing data could be supplied separately in the future; no such proprietary
// component is included or injected here.

import type { Corridor } from "@corridor/manifest";
import type { AnchorAdapter, SourceAnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";

export interface RouteDecision {
  /** The receiving anchor chosen for this payment. */
  readonly receiving: AnchorAdapter;
  /** The source anchor that on-ramps the bridge asset, present when the route specifies one. */
  readonly sending?: SourceAnchorAdapter;
  /** How the route decision was reached: verified against on-chain evidence or assumed from manifest. */
  readonly trust: "attested" | "manifest";
}

export interface RouteResolver {
  resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision>;
}

export interface StaticRouteResolverOptions {
  readonly trustManifestWithoutAttestation?: boolean;
  /** Optional source adapter factory for the on-ramp leg. */
  readonly sourceAdapterFor?: (corridor: Corridor) => SourceAnchorAdapter;
}

/**
 * Default resolver: use the single anchor the manifest declares. No intelligence.
 * Swap this out for another RouteResolver implementation if one is developed;
 * the interface is an extension seam, not evidence of a separate closed repo.
 */
export class StaticRouteResolver implements RouteResolver {
  private readonly sourceAdapterFor?: (corridor: Corridor) => SourceAnchorAdapter;

  constructor(
    private readonly adapterFor: (corridor: Corridor) => AnchorAdapter,
    options?: StaticRouteResolverOptions,
  ) {
    if (!options?.trustManifestWithoutAttestation) {
      throw new Error(
        "StaticRouteResolver requires explicit { trustManifestWithoutAttestation: true }. Use RegistryRouteResolver for verified routing.",
      );
    }
    this.sourceAdapterFor = options.sourceAdapterFor;
  }

  async resolve(_intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    const receiving = this.adapterFor(corridor);
    const sending = this.sourceAdapterFor?.(corridor);
    return {
      receiving,
      ...(sending ? { sending } : {}),
      trust: "manifest",
    };
  }
}

// The registry-backed resolver: the evidence-based resolver, in code.
// StaticRouteResolver above trusts the manifest; this one requires evidence.
export { RegistryRouteResolver } from "./registry-resolver";
export { UnattestedAnchorError } from "./registry-resolver";
export { isUnattestedDomainAllowed } from "./registry-resolver";
export type { AttestationSource, RegistryResolverOptions } from "./registry-resolver";
