// Mirrors the *.corridor.yaml manifests in ../corridors. Kept as plain data so
// the demo UI is self-contained; in a real deployment these come from the engine
// (via @corridor/service) or the manifest loader.

export interface Endpoints {
  home_domain: string;
  transfer_server_sep31?: string;
  web_auth?: string;
  kyc_server?: string;
  quote_server?: string;
}

export interface Corridor {
  id: string;
  status_note?: string;
  source: { name: string; asset: string; endpoints: Endpoints };
  dest: { name: string; asset: string; endpoints: Endpoints };
  fx: { path: string[]; quote_source: "sep38" | "external"; who_holds_risk: string; quote_ttl_seconds: number };
  compliance: { source_jurisdiction: string; dest_jurisdiction: string };
  settlement: { bridge_asset: string; network: "public" | "testnet"; asset_issuer: string };
  recovery: { max_retries: number; timeout_seconds: number; rollback: string };
}

export const corridors: Corridor[] = [
  {
    id: "reference-testnet",
    status_note: "Anchor Platform reference server on testnet. Run it yourself, no agreements.",
    source: { name: "Local Sending Anchor", asset: "USDC", endpoints: { home_domain: "localhost:8080" } },
    dest: {
      name: "Anchor Platform Reference",
      asset: "iso4217:USD",
      endpoints: {
        home_domain: "localhost:8080",
        transfer_server_sep31: "http://localhost:8080/sep31",
        web_auth: "http://localhost:8080/auth",
        kyc_server: "http://localhost:8080/sep12",
        quote_server: "http://localhost:8080/sep38",
      },
    },
    fx: { path: ["USD", "USDC", "USD"], quote_source: "sep38", who_holds_risk: "receiving_anchor", quote_ttl_seconds: 60 },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "US" },
    settlement: { bridge_asset: "USDC", network: "testnet", asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    recovery: { max_retries: 3, timeout_seconds: 900, rollback: "refund_sender" },
  },
  {
    id: "mx-bitso",
    status_note: "Destination runs SEP-31 receive-side. Verify endpoints from the live stellar.toml.",
    source: { name: "USD Sending Anchor", asset: "USDC", endpoints: { home_domain: "sending-anchor.example" } },
    dest: {
      name: "Mexico Off-Ramp (Bitso-class)",
      asset: "iso4217:MXN",
      endpoints: {
        home_domain: "anchor.example.mx",
        transfer_server_sep31: "https://anchor.example.mx/sep31",
        web_auth: "https://anchor.example.mx/auth",
        kyc_server: "https://anchor.example.mx/sep12",
        quote_server: "https://anchor.example.mx/sep38",
      },
    },
    fx: { path: ["USD", "USDC", "MXN"], quote_source: "sep38", who_holds_risk: "receiving_anchor", quote_ttl_seconds: 60 },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "MX" },
    settlement: { bridge_asset: "USDC", network: "public", asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    recovery: { max_retries: 3, timeout_seconds: 900, rollback: "refund_sender" },
  },
  {
    id: "ng-cn",
    status_note: "PENDING — no compliant RMB SEP-31 off-ramp exists yet. dest endpoints unfilled.",
    source: { name: "Nigeria On-Ramp (cNGN/Cowrie-class)", asset: "USDC", endpoints: { home_domain: "example-ng-anchor.invalid" } },
    dest: {
      name: "China RMB Off-Ramp (does not exist yet)",
      asset: "iso4217:CNY",
      endpoints: { home_domain: "example-cn-anchor.invalid" },
    },
    fx: { path: ["NGN", "USDC", "CNY"], quote_source: "sep38", who_holds_risk: "sending_anchor", quote_ttl_seconds: 45 },
    compliance: { source_jurisdiction: "NG", dest_jurisdiction: "CN" },
    settlement: { bridge_asset: "USDC", network: "public", asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    recovery: { max_retries: 2, timeout_seconds: 1200, rollback: "refund_sender" },
  },
];

export function getCorridor(id: string): Corridor | undefined {
  return corridors.find((c) => c.id === id);
}

export interface Liveness {
  runnable: boolean;
  warnings: string[];
}

// Mirrors `corridor plan` in packages/cli.
export function liveness(c: Corridor): Liveness {
  const warnings: string[] = [];
  if (!c.dest.endpoints.transfer_server_sep31) {
    warnings.push("dest has no SEP-31 transfer server — corridor cannot settle. NOT runnable.");
  }
  if (c.fx.quote_source === "sep38" && !c.dest.endpoints.quote_server) {
    warnings.push("fx.quote_source=sep38 but dest exposes no SEP-38 quote server — quotes will fail.");
  }
  if (!c.dest.endpoints.kyc_server) {
    warnings.push("dest has no SEP-12 KYC server — assuming 1:1 delivery with no per-customer KYC.");
  }
  return { runnable: Boolean(c.dest.endpoints.transfer_server_sep31), warnings };
}

export const VERBS = [
  { step: 1, verb: "quote", sep: "SEP-38  POST /quote" },
  { step: 2, verb: "comply", sep: "SEP-10 auth + SEP-12 KYC handoff" },
  { step: 3, verb: "open", sep: "SEP-31  POST /transactions" },
  { step: 4, verb: "settle", sep: "native Stellar payment of bridge asset" },
  { step: 5, verb: "reconcile", sep: "SEP-31  GET /transactions/:id" },
] as const;
