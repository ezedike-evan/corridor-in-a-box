// Liveness — can this corridor actually move money, and do we KNOW that?
//
// The distinction this file exists to enforce: a manifest naming an endpoint is
// not evidence the endpoint exists. Anyone can write
//
//     transfer_server_sep31: https://anchor.example.mx/sep31
//
// into a YAML file. Reporting that lane as "runnable" because the string is
// non-empty is how tooling ends up asserting a fictional corridor is healthy.
//
// So liveness has THREE states, not two:
//
//   not-runnable  a required endpoint is missing outright — cannot settle
//   unverified    endpoints are present but nobody has confirmed they resolve
//   verified      endpoints were checked against the anchor's published
//                 stellar.toml (or a running instance) on a recorded date
//
// Only `verified` is green. `unverified` is the honest default for any lane
// whose endpoints have not been looked at, and it is where every corridor
// starts. Earning `verified` requires setting `endpoints_verified_at` on the
// dest anchor, which a human does only after actually checking.

import type { Corridor } from "./index";

export type LivenessState = "verified" | "unverified" | "not-runnable";

export interface Liveness {
  readonly state: LivenessState;
  /**
   * True only when `state === "verified"`. Gate execution and UI affordances on
   * this — never on the mere presence of an endpoint URL.
   */
  readonly runnable: boolean;
  /** ISO date the dest endpoints were last confirmed, when known. */
  readonly verifiedAt?: string;
  readonly warnings: readonly string[];
}

/** Human-readable label for each state. Shared so the CLI and the web app can
 *  never drift into describing the same corridor differently. */
export const LIVENESS_LABEL: Record<LivenessState, string> = {
  verified: "verified",
  unverified: "unverified",
  "not-runnable": "not runnable",
};

export function liveness(c: Corridor): Liveness {
  const warnings: string[] = [];
  const endpoints = c.dest.endpoints;
  const verifiedAt = endpoints.endpoints_verified_at;

  if (!endpoints.transfer_server_sep31) {
    warnings.push(
      "dest has no SEP-31 transfer server — corridor cannot settle. NOT runnable.",
    );
  } else if (!verifiedAt) {
    warnings.push(
      "dest endpoints are UNVERIFIED — the URLs below have never been confirmed against " +
        "a published stellar.toml. Do not treat this lane as runnable. Set " +
        "dest.endpoints.endpoints_verified_at once you have checked them.",
    );
  }

  if (c.fx.quote_source === "sep38" && !endpoints.quote_server) {
    warnings.push(
      "fx.quote_source=sep38 but dest exposes no SEP-38 quote server — quotes will fail.",
    );
  }
  if (!endpoints.kyc_server) {
    warnings.push(
      "dest has no SEP-12 KYC server — assuming 1:1 delivery with no per-customer KYC.",
    );
  }

  const state: LivenessState = !endpoints.transfer_server_sep31
    ? "not-runnable"
    : verifiedAt
      ? "verified"
      : "unverified";

  return { state, runnable: state === "verified", verifiedAt, warnings };
}
