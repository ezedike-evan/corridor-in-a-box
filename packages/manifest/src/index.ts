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
import {
  ok,
  fail,
  type Ok,
  type Err,
  type CorridorError,
  compareAmounts,
} from "@corridor/types";

/** SEP endpoints an anchor exposes. Only home_domain is mandatory; the rest are
 *  discovered from its stellar.toml in practice, but may be pinned here. */
export const AnchorEndpointsSchema = z.object({
  home_domain: z.string().min(1),
  /** SEP-31 DIRECT_PAYMENT_SERVER */
  transfer_server_sep31: z.string().url().optional(),
  /** SEP-10 WEE_AUTH_ENDPOINT */
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

const AnchorBaseSchema = z.object({
  name: z.string().min(1),
  /** Asset this anchor deals in at this leg. Source side: typically "USDC".
   *  Dest side: the off-chain payout asset, e.g. "iso4217:ARS". */
  asset: z.string().min(1),
});

export const AnchorSchema = AnchorBaseSchema.extend({ endpoints: AnchorEndpointsSchema });

// `transfer_server_sep31` stays optional so an incomplete manifest still
// parses; `liveness()` reports a SEP-31 dest without it as NOT runnable.
const Sep31DestSchema = AnchorBaseSchema.extend({
  protocol: z.literal("sep31").default("sep31"),
  endpoints: AnchorEndpointsSchema,
});

const Sep6DestSchema = AnchorBaseSchema.extend({
  protocol: z.literal("sep6"),
  endpoints: z.object({
    home_domain: z.string().min(1),
    transfer_server: z.string().url(),
    web_auth: z.string().url().optional(),
    kyc_server: z.string().url().optional(),
    quote_server: z.string().url().optional(),
    endpoints_verified_at: AnchorEndpointsSchema.shape.endpoints_verified_at,
  }),
});

const CustomDestSchema = AnchorBaseSchema.extend({
  protocol: z.string().regex(/^custom:[a-z0-9]+$/, "expected custom:<lowercase-id>"),
  endpoints: z.object({
    home_domain: z.string().min(1),
    base_url: z.string().url(),
    extra: z.record(z.string(), z.string()).default({}),
    endpoints_verified_at: AnchorEndpointsSchema.shape.endpoints_verified_at,
  }),
});

// A discriminated union discriminates before defaults apply, so default an
// absent `protocol` to "sep31" first (existing manifests unchanged), the same
// way SourceAnchorSchema defaults to "prefunded".
export const DestSchema = z.preprocess(
  (raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw) && !("protocol" in raw)
      ? { ...raw, protocol: "sep31" }
      : raw,
  z.discriminatedUnion("protocol", [Sep31DestSchema, Sep6DestSchema]).or(CustomDestSchema),
);

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

export const FxSchema = z
  .object({
    /** The conversion path, in order. e.g. ["NGN","USDC","ARS"]. >= 2 hops. */
    path: z.array(z.string().min(1)).min(2),
    quote_source: z.enum(["sep38", "external"]).default("sep38"),
    /** Who carries the rate risk between quote-time and settlement. */
    who_holds_risk: z.enum(["sender", "sending_anchor", "receiving_anchor"]),
    /** Firm-quote TTL. The settle leg must hit the chain before this elapses. */
    quote_ttl_seconds: z.number().int().positive().default(60),
    /**
     * Minimum seconds a firm quote must still have left when a settle attempt
     * starts (#152). Covers submit plus Horizon confirmation, so a quote that
     * is technically alive but would expire mid-flight is refused BEFORE our
     * money moves, instead of the anchor rejecting or re-pricing the payout
     * after it has. Enforced by the `quote.window` gate check.
     */
    min_quote_remaining_seconds: z.number().int().positive().default(45),
  })
  .superRefine((fx, ctx) => {
    // A margin at or above the TTL would refuse every firm quote the moment
    // it is minted — a corridor that can never settle, misconfigured rather
    // than cautious.
    if (fx.min_quote_remaining_seconds >= fx.quote_ttl_seconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["min_quote_remaining_seconds"],
        message: `min_quote_remaining_seconds (${fx.min_quote_remaining_seconds}) must be smaller than quote_ttl_seconds (${fx.quote_ttl_seconds})`,
      });
    }
  });

/** How KYC for the receiving party is established.
  *
   *  - `sep12`: SEP-12 customer registration; the intent carries a customer
  *    reference (`sep12Id` / `anchorCustomerId`) and the adapter checks
  *    `GET /customer` for accepted status.
  *  - `sep6_fields`: SEP-6 anchors accept KYC fields inline on the transfer
  *    request. The manifest carries field NAMES and operator-supplied
  *    references, never raw PII.
  *  - `bespoke`: the anchor has its own onboarding; the engine only
  *    propagates the operator-supplied customer reference.
  *  - `none`: no KYC is required for this corridor.
  *
  * Default derivation (applied in `CorridorSchema.superRefine`): `sep12` when
  *  the destination advertises a `kyc_server`, otherwise `none`.
  */
export const ComplianceProtocolSchema = z.enum(["sep12", "sep6_fields", "bespoke", "none"]);

export const ComplianceSchema = z.object({
  source_jurisdiction: z.string().min(1),
  dest_jurisdiction: z.string().min(1),
  travel_rule_profile: z.string().default("default"),
  /**
   * How KYC for the receiving party is established. Omit to derive from the
   * destination endpoints (`sep12` when a kyc_server is configured, else
   * `none`). See `ComplianceProtocolSchema`.
   */
  method: ComplianceProtocolSchema.optional(),
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
  /**
   * For `compliance.method: "sep6_fields"`, the SEP-6 KYC field NAMES the
   * anchor expects inline on the transfer request. NAME only — the values
   * are operator-supplied at run time and must not flow through the engine.
   */
  sep6_kyc_fields: z.array(z.string().min(1)).optional(),
  /**
   * Operator-supplied references for bespoke onboarding (e.g. a tenant id
   * or a provider name). NAME only, no raw PII.
   */
  bespoke_references: z.record(z.string(), z.string()).optional(),
}).superRefine((compliance, ctx) => {
  if (compliance.method === "sep6_fields" && !compliance.sep6_kyc_fields) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sep6_kyc_fields"],
      message: 'compliance.method "sep6_fields" requires sep6_kyc_fields',
    });
  }
});

export const SettlementSchema = z.object({
  /** The on-chain bridge asset moved between the two anchors. */
  bridge_asset: z.string().default("USDC"),
  network: z.enum(["public", "testnet"]),
  /** Issuer account of the bridge asset on the chosen network. */
  asset_issuer: z.string().min(1),
});

/** Per-corridor payment limits (floor and ceiling). Optional, but a lane with no ceiling accepts
 *  any positive amount the caller asks for — set one before real money. */
export const LimitsSchema = z.object({
  /** Smallest single payment this corridor will accept, as a decimal string in
   *  the source asset. Omit for no floor. */
  min_amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "expected a positive decimal amount")
    .optional(),
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
  /** Seconds a pending_external/pending_receiver status may stay unchanged before it counts as stalled. */
  external_stall_seconds: z.number().int().positive().default(21_600),
});

export const BreakerSchema = z.object({
  /**
   * Consecutive lane-level failures after which the corridor halts.
   *
   * This is a "last resort" circuit breaker for the whole corridor. Per-anchor
   * breakers (failures against a single anchor) are handled elsewhere.
   */
  failure_threshold: z.number().int().positive().default(5),
  /** Seconds the corridor stays halted before a half-open probe. */
  cooldown_seconds: z.number().int().positive().default(300),
});

/** The full corridor definition. This is the object the engine acts on. */
export const CorridorSchema = z.object({
  /** Stable identifier for this corridor, e.g. "NGN-ARS". */
  id: z.string().min(1),
  /** Human-readable name, e.g. "Nigeria to Argentina". */
  name: z.string().min(1),
  /** The source anchor (and how the engine reaches it). */
  source: SourceAnchorSchema,
  /** The destination anchor (and how the engine reaches it). */
  dest: DestSchema,
  /** The conversion path. */
  fx: FxSchema,
  /** How KYC is established for this corridor. */
  compliance: ComplianceSchema,
  /** How the bridge asset is moved between anchors. */
  settlement: SettlementSchema,
  /** Per-corridor payment limits. */
  limits: LimitsSchema.optional(),
  /** How patiently to poll after settling. */
  reconcile: ReconcileSchema.optional(),
  /** Lane-level circuit breaker. */
  breaker: BreakerSchema.optional(),
}).superRefine((corridor, ctx) => {
  // Derive compliance.method when omitted: sep12 when the destination advertises a
  // kyc_server, otherwise none. This keeps existing manifests working without
  // forcing every one to declare a compliance method explicitly.
  if (corridor.compliance.method === undefined) {
    const endpoints = corridor.dest.endpoints as unknown as { kyc_server?: string };
    const derived = endpoints?.kyc_server ? "sep12" : "none";
    corridor.compliance.method = derived;
  }
});

export type Corridor = z.infer<typeof CorridorSchema>;
export type Compliance = z.infer<typeof ComplianceSchema>;

// ------------------------------------------------------------------------------
// Loading and validation
// ------------------------------------------------------------------------------

/** Parse a corridor manifest from a YAML string. */
export function parseCorridorManifest(yaml: string): Ok<Corridor> | Err<CorridorError> {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (e) {
    return fail({
      code: "MANIFEST_PARSE_ERROR",
      message: `YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const result = CorridorSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return fail({
      code: "MANIFEST_VALIDATION_ERROR",
      message: `invalid corridor manifest:\n  ${issues.join("\n  ")}`,
    });
  }

  return ok(result.data);
}

/** Load and parse a corridor manifest from a file path. */
export function loadCorridorManifest(path: string): Ok<Corridor> | Err<CorridorError> {
  let yaml: string;
  try {
    yaml = readFileSync(path, "utf-8");
  } catch (e) {
    return fail({
      code: "MANIFEST_READ_ERROR",
      message: `could not read manifest at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  return parseCorridorManifest(yaml);
}

/** The result of a liveness check on a corridor. */
export interface LivenessResult {
  /** True only when every endpoint the corridor needs is confirmed and fresh. */
  verified: boolean;
  /** Human-readable reasons the corridor is not verified (empty when verified). */
  reasons: string[];
}

/** How old an `endpoints_verified_at` date may be before it counts as stale. */
const MAX_VERIFIED_AGE_DAYS = 30;

/**
 * Report whether a corridor is runnable and verified. A corridor is verified
 * only when every endpoint it needs carries a fresh `endpoints_verified_at`.
 */
export function liveness(corridor: Corridor): LivenessResult {
  const reasons: string[] = [];
  const now = Date.now();
  const maxAgeMs = MAX_VERIFIED_AGE_DAYS * 24 * 60 * 60 * 1000;

  const checkEndpoints = (label: string, endpoints: { endpoints_verified_at?: string } | undefined) => {
    if (!endpoints) {
      reasons.push(`${label} has no endpoints configured`);
      return;
    }
    const verifiedAt = endpoints.endpoints_verified_at;
    if (!verifiedAt) {
      reasons.push(`${label} endpoints have not been verified (no endpoints_verified_at)`);
      return;
    }
    const ageMs = now - Date.parse(verifiedAt);
    if (Number.isNaN(ageMs) || ageMs > maxAgeMs) {
      reasons.push(`${label} endpoints were verified at ${verifiedAt}, which is stale`);
    }
  };

  checkEndpoints("source", corridor.source.endpoints);
  checkEndpoints("dest", corridor.dest.endpoints);

  // A sep31 dest without a transfer server cannot be settled to.
  if (corridor.dest.protocol === "sep31") {
    const ts = (corridor.dest.endpoints as { transfer_server_sep31?: string }).transfer_server_sep31;
    if (!ts) {
      reasons.push("dest is sep31 but has no transfer_server_sep31");
    }
  }

  return { verified: reasons.length === 0, reasons };
}

/** Compare two amounts in the same asset, returning -1, 0 or 1. */
export function compareCorridorAmounts(a: string, b: string): number {
  return compareAmounts(a, b);
}
