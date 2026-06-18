// @corridor/manifest — the corridor abstraction made physical.
//
// THIS is where the multi-corridor design lives. A corridor is a validated data
// object, never code. Adding Mexico or Argentina or (one day) China is a new YAML
// file that parses to this schema — not a fork of the engine.
//
// Keep this schema deliberately THIN. Do not add a field until a second real
// corridor proves you need it; over-specifying here is the same premature
// generalization trap, just relocated into Zod.

import { z } from "zod";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ok, fail, type Outcome } from "@corridor/types";

/** SEP endpoints an anchor exposes. Only home_domain is mandatory; the rest are
 *  discovered from its stellar.toml in practice, but may be pinned here. */
export const AnchorEndpointsSchema = z.object({
  home_domain: z.string().min(1),
  /** SEP-31 DIRECT_PAYMENT_SERVER */
  transfer_server_sep31: z.string().url().optional(),
  /** SEP-10 WEB_AUTH_ENDPOINT */
  web_auth: z.string().url().optional(),
  /** SEP-12 KYC_SERVER */
  kyc_server: z.string().url().optional(),
  /** SEP-38 QUOTE_SERVER */
  quote_server: z.string().url().optional(),
});

export const AnchorSchema = z.object({
  name: z.string().min(1),
  endpoints: AnchorEndpointsSchema,
  /** Asset this anchor deals in at this leg. Source side: typically "USDC".
   *  Dest side: the off-chain payout asset, e.g. "iso4217:ARS". */
  asset: z.string().min(1),
});

export const FxSchema = z.object({
  /** The conversion path, in order. e.g. ["NGN","USDC","ARS"]. >= 2 hops. */
  path: z.array(z.string().min(1)).min(2),
  quote_source: z.enum(["sep38", "external"]).default("sep38"),
  /** Who carries the rate risk between quote-time and settlement. */
  who_holds_risk: z.enum(["sender", "sending_anchor", "receiving_anchor"]),
  /** Firm-quote TTL. The settle leg must hit the chain before this elapses. */
  quote_ttl_seconds: z.number().int().positive().default(60),
});

export const ComplianceSchema = z.object({
  source_jurisdiction: z.string().min(1),
  dest_jurisdiction: z.string().min(1),
  travel_rule_profile: z.string().default("default"),
});

export const SettlementSchema = z.object({
  /** The on-chain bridge asset moved between the two anchors. */
  bridge_asset: z.string().default("USDC"),
  network: z.enum(["public", "testnet"]),
  /** Issuer account of the bridge asset on the chosen network. */
  asset_issuer: z.string().min(1),
});

export const RecoverySchema = z.object({
  max_retries: z.number().int().nonnegative().default(3),
  timeout_seconds: z.number().int().positive().default(900),
  rollback: z.enum(["refund_sender", "hold", "manual"]).default("refund_sender"),
});

export const CorridorSchema = z.object({
  id: z.string().min(1),
  /** Human note. Use it to record liveness, e.g. "pending: no RMB SEP-31 anchor". */
  status_note: z.string().optional(),
  source: AnchorSchema,
  dest: AnchorSchema,
  fx: FxSchema,
  compliance: ComplianceSchema,
  settlement: SettlementSchema,
  recovery: RecoverySchema,
});

export type Corridor = z.infer<typeof CorridorSchema>;
export type AnchorConfig = z.infer<typeof AnchorSchema>;

/** Parse + validate a corridor manifest from an object already in memory. */
export function parseCorridor(raw: unknown): Outcome<Corridor> {
  const parsed = CorridorSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("MANIFEST_INVALID", formatZodError(parsed.error), { cause: parsed.error });
  }
  return ok(parsed.data);
}

/** Read + validate a *.corridor.yaml file from disk. */
export function loadCorridor(path: string): Outcome<Corridor> {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    return fail("MANIFEST_INVALID", `cannot read or parse ${path}`, { cause });
  }
  return parseCorridor(raw);
}

function formatZodError(e: z.ZodError): string {
  return e.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
