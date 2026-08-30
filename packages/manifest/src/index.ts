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
  /**
   * ISO date (YYYY-MM-DD) on which the URLs above were confirmed against this
   * anchor's PUBLISHED stellar.toml, or — for a self-hosted lane like the Anchor
   * Platform reference server — against a running instance.
   *
   * Presence of a URL proves nothing: a manifest can name an endpoint that has
   * never existed. This field is the difference between "someone typed a URL"
   * and "someone checked it", and it is what `liveness()` requires before it
   * will report a corridor as verified. Leave it unset until you have actually
   * looked. Never set it speculatively.
   */
  endpoints_verified_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, YYYY-MM-DD")
    .optional(),
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
  /**
   * SEP-12 customer `type` for the receiving party.
   *
   * This is NOT free-form and cannot be synthesised from a jurisdiction: it must
   * be one of the types the destination anchor advertises under
   * `sep12.receiver.types` in its `GET /sep31/info` response. Send a type the
   * anchor doesn't publish and registration is rejected. `sep31-receiver` is the
   * conventional name and what the Anchor Platform reference server uses; check
   * /info for anything else.
   */
  sep12_receiver_type: z.string().default("sep31-receiver"),
  /** SEP-12 customer `type` for the sending party, from `sep12.sender.types`. */
  sep12_sender_type: z.string().default("sep31-sender"),
});

export const SettlementSchema = z.object({
  /** The on-chain bridge asset moved between the two anchors. */
  bridge_asset: z.string().default("USDC"),
  network: z.enum(["public", "testnet"]),
  /** Issuer account of the bridge asset on the chosen network. */
  asset_issuer: z.string().min(1),
});

/** Per-corridor payment ceilings. Optional, but a lane with no ceiling accepts
 *  any positive amount the caller asks for — set one before real money. */
export const LimitsSchema = z.object({
  /** Largest single payment this corridor will accept, as a decimal string in
   *  the source asset. Omit for no ceiling (dev/testnet only). */
  max_amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "expected a positive decimal amount")
    .optional(),
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
  limits: LimitsSchema.optional(),
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
  return e.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

// Liveness lives beside the schema because it is a statement ABOUT a manifest:
// whether the lane it describes can actually settle, and whether anyone has
// checked. Both the CLI and the web dashboard read it, so neither can report a
// corridor as healthy on its own authority.
export { liveness, LIVENESS_LABEL, type Liveness, type LivenessState } from "./liveness";
