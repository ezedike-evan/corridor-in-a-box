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
import { fail, type CorridorError } from "@corridor/types";

// Shared verified-at schema to avoid repetition.
const endpointsVerifiedAtSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, YYYY-MM-DD")
  .optional();

/** SEP-31 endpoints schema (DIRECT_PAYMENT_SERVER and friends).
 *  Only home_domain is mandatory; the rest are discovered from the anchor's
 *  stellar.toml in practice, but may be pinned here. */
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
  endpoints_verified_at: endpointsVerifiedAtSchema,
});

/** Backward-compat alias — SEP-31 endpoints are the only shape currently in use. */
export const Sep31EndpointsSchema = AnchorEndpointsSchema;

/**
 * Destination anchor schema with explicit protocol discriminator.
 *
 * The `protocol` field declares how the destination anchor is reached:
 * - `"sep31"` — standard SEP-31 DIRECT_PAYMENT_SERVER anchor.
 *
 * Manifests that omit `protocol` default to `"sep31"` for backward
 * compatibility (legacy flat endpoint shape). New manifests must declare
 * `protocol: sep31` explicitly to suppress a deprecation warning.
 */
export const DestAnchorSchema = z.preprocess(
  (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const obj = raw as Record<string, unknown>;
    // Backward compat: manifests without protocol default to sep31.
    if (!("protocol" in obj)) {
      return { protocol: "sep31", ...obj, _legacyProtocol: true };
    }
    return obj;
  },
  z.object({
    name: z.string().min(1),
    /** Asset this anchor deals in at this leg, e.g. "iso4217:NGN". */
    asset: z.string().min(1),
    /**
     * How the destination anchor is reached. Must be "sep31" (the only
     * protocol supported today). Omitting `protocol` is deprecated — set it
     * explicitly to suppress the deprecation warning emitted by parseCorridor.
     */
    protocol: z.literal("sep31"),
    endpoints: AnchorEndpointsSchema,
    /** Internal marker: true when protocol was defaulted (not explicitly set). */
    _legacyProtocol: z.boolean().optional(),
  }),
);

/** Source anchor schema (source-side protocol is unversioned/thin for now). */
export const AnchorSchema = z.object({
  name: z.string().min(1),
  endpoints: AnchorEndpointsSchema,
  /** Asset this anchor deals in at this leg. Source side: typically "USDC".
   *  Dest side: the off-chain payout asset, e.g. "iso4217:ARS". */
  asset: z.string().min(1),
});

/**
 * How the SENDING side is reached. Schema only: the engine does not act on this
 * yet (the source-anchor adapter and fund step come later), it only lets a
 * manifest say whether the operator already holds the bridge asset or on-ramps
 * through an anchor deposit.
 *
 *  - `prefunded` (default when `protocol` is absent): the operator's own
 *    treasury. Needs only `name` / `asset`; `endpoints` is optional.
 *  - `sep6`: SEP-6 deposit; requires `endpoints.transfer_server`.
 *  - `sep24`: SEP-24 interactive deposit; requires
 *    `endpoints.transfer_server_sep24` and `endpoints.web_auth`.
 *  - `custom:<id>`: bespoke integration; requires `endpoints.base_url`.
 */
const SourceBase = { name: z.string().min(1), asset: z.string().min(1) };
const SourceEndpointsBase = AnchorEndpointsSchema.partial({ home_domain: true });

export const PrefundedSourceSchema = z.object({
  ...SourceBase,
  protocol: z.literal("prefunded"),
  endpoints: SourceEndpointsBase.optional(),
});
export const Sep6SourceSchema = z.object({
  ...SourceBase,
  protocol: z.literal("sep6"),
  endpoints: AnchorEndpointsSchema.extend({ transfer_server: z.string().url() }),
});
export const Sep24SourceSchema = z.object({
  ...SourceBase,
  protocol: z.literal("sep24"),
  endpoints: AnchorEndpointsSchema.extend({
    transfer_server_sep24: z.string().url(),
    web_auth: z.string().url(),
  }),
});
export const CustomSourceSchema = z.object({
  ...SourceBase,
  protocol: z
    .string()
    .regex(/^custom:[A-Za-z0-9_.-]+$/, "expected prefunded, sep6, sep24 or custom:<id>"),
  endpoints: AnchorEndpointsSchema.extend({ base_url: z.string().url() }),
});

export const SourceAnchorSchema = z.preprocess(
  (raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw) && !("protocol" in raw)
      ? { ...raw, protocol: "prefunded" }
      : raw,
  z.union([PrefundedSourceSchema, Sep6SourceSchema, Sep24SourceSchema, CustomSourceSchema]),
);
export type DestProtocol = "sep31";
export type AnchorConfig = z.infer<typeof DestAnchorSchema>;

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

/** How patiently this corridor polls the receiving anchor after settling. Both
 *  fields are optional: an unset field falls back to `EngineDeps`, then to the
 *  engine default (2s poll, stall after 10 identical polls). */
export const ReconcileSchema = z.object({
  /** Seconds between reconcile polls. */
  poll_seconds: z.number().int().positive().optional(),
  /** Consecutive identical-status polls before `RECONCILE_STALLED`. 0 disables. */
  stall_polls: z.number().int().nonnegative().optional(),
});

export const RecoverySchema = z.object({
  max_retries: z.number().int().nonnegative().default(3),
  timeout_seconds: z.number().int().positive().default(900),
  rollback: z.enum(["refund_sender", "hold", "manual"]).default("refund_sender"),
  reconcile: ReconcileSchema.optional(),
});

/** True when the YYYY-MM-DD part names a real calendar day. `Date` alone is no help:
 *  it rolls 2026-02-30 over to 2 March instead of rejecting it. */
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

/** Canary payment evidence proving this exact lane successfully moved money. */
export const ProofSchema = z.object({
  /** ISO date or timestamp on which the canary payment reached completed. */
  canary_completed_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/,
      "expected an ISO date (YYYY-MM-DD) or timestamp",
    )
    .refine(isRealCalendarDate, "not a real calendar date"),
  /** 64-hex Stellar transaction hash for the on-chain settlement leg. */
  stellar_tx_hash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "expected a 64-character hex transaction hash"),
  /** Destination anchor's external transaction / order ID. */
  anchor_transaction_id: z.string().min(1),
  /** Amount delivered or transferred in the canary payment, as a decimal string. */
  amount: z.string().regex(/^\d+(\.\d+)?$/, "expected a positive decimal amount"),
  /** Max validity age of the proof in days before becoming stale. Default 30. */
  max_age_days: z.number().int().positive().default(30),
  /** Optional canary max amount ceiling. */
  canary_max_amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "expected a positive decimal amount")
    .optional(),
});

export const CorridorSchema = z.object({
  id: z.string().min(1),
  /** Human note. Use it to record liveness, e.g. "pending: no RMB SEP-31 anchor". */
  status_note: z.string().optional(),
  source: SourceAnchorSchema,
  /** Destination anchor. Must declare `protocol: sep31` explicitly (omitting is deprecated). */
  dest: DestAnchorSchema,
  fx: FxSchema,
  compliance: ComplianceSchema,
  settlement: SettlementSchema,
  recovery: RecoverySchema,
  limits: LimitsSchema.optional(),
  proof: ProofSchema.optional(),
});

export type Corridor = z.infer<typeof CorridorSchema>;
export type SourceAnchorConfig = z.infer<typeof SourceAnchorSchema>;
export type Proof = z.infer<typeof ProofSchema>;

/**
 * Result of `parseCorridor` / `loadCorridor`.
 * On success, `warnings` carries any deprecation notices (currently: missing
 * `dest.protocol`, which defaults to `"sep31"` for backward compat).
 */
export type ParseCorridorResult =
  { ok: true; value: Corridor; warnings: string[] } | { ok: false; error: CorridorError };

/** Parse + validate a corridor manifest from an object already in memory.
 *
 * Returns a `ParseCorridorResult` — on success, check `.warnings` for
 * deprecation notices (e.g. missing explicit `dest.protocol`).
 */
export function parseCorridor(raw: unknown): ParseCorridorResult {
  const warnings: string[] = [];

  // Detect missing dest.protocol before Zod fills the default, so we can warn.
  if (typeof raw === "object" && raw !== null && "dest" in raw) {
    const dest = (raw as Record<string, unknown>).dest;
    if (typeof dest === "object" && dest !== null && !("protocol" in dest)) {
      warnings.push(
        "dest.protocol is not set — defaulting to 'sep31'. " +
          "Set `protocol: sep31` explicitly under dest: to silence this warning.",
      );
    }
  }

  const parsed = CorridorSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("MANIFEST_INVALID", formatZodError(parsed.error), { cause: parsed.error });
  }

  // Strip the internal _legacyProtocol marker before returning the clean value.
  const value = parsed.data;
  if (value.dest._legacyProtocol) {
    const { _legacyProtocol: _, ...cleanDest } = value.dest;
    return { ok: true, value: { ...value, dest: cleanDest as typeof value.dest }, warnings };
  }

  return { ok: true, value, warnings };
}

/** Read + validate a *.corridor.yaml file from disk. */
export function loadCorridor(path: string): ParseCorridorResult {
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
