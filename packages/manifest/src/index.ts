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
import { fail, type Err, type Ok, type CorridorError } from "@corridor/types";

const endpointsVerifiedAtSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, YYYY-MM-DD")
  .optional();

/** SEP-31 DIRECT_PAYMENT_SERVER endpoints schema. */
export const Sep31EndpointsSchema = z.object({
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
   */
  endpoints_verified_at: endpointsVerifiedAtSchema,
});

/** SEP-6 TRANSFER_SERVER endpoints schema. */
export const Sep6EndpointsSchema = z.object({
  home_domain: z.string().min(1),
  /** SEP-6 TRANSFER_SERVER (required) */
  transfer_server: z.string().url(),
  /** SEP-10 WEB_AUTH_ENDPOINT */
  web_auth: z.string().url().optional(),
  /** SEP-12 KYC_SERVER */
  kyc_server: z.string().url().optional(),
  /** SEP-38 QUOTE_SERVER */
  quote_server: z.string().url().optional(),
  endpoints_verified_at: endpointsVerifiedAtSchema,
});

/** Bespoke API base URL endpoints schema. */
export const CustomEndpointsSchema = z.object({
  home_domain: z.string().min(1),
  /** Custom API base URL (required) */
  base_url: z.string().url(),
  /** SEP-10 WEB_AUTH_ENDPOINT */
  web_auth: z.string().url().optional(),
  /** SEP-12 KYC_SERVER */
  kyc_server: z.string().url().optional(),
  /** SEP-38 QUOTE_SERVER */
  quote_server: z.string().url().optional(),
  /** Free-form extra configuration for custom adapters */
  extra: z.record(z.string(), z.unknown()).optional(),
  endpoints_verified_at: endpointsVerifiedAtSchema,
});

/** SEP endpoints an anchor exposes. Backward-compatible alias to Sep31EndpointsSchema. */
export const AnchorEndpointsSchema = Sep31EndpointsSchema;

export const Sep31AnchorSchema = z.object({
  name: z.string().min(1),
  asset: z.string().min(1),
  protocol: z.literal("sep31"),
  endpoints: Sep31EndpointsSchema,
});

export const Sep6AnchorSchema = z.object({
  name: z.string().min(1),
  asset: z.string().min(1),
  protocol: z.literal("sep6"),
  endpoints: Sep6EndpointsSchema,
});

export const CustomAnchorSchema = z.object({
  name: z.string().min(1),
  asset: z.string().min(1),
  protocol: z
    .string()
    .regex(/^custom:[a-z0-9-]+$/, "expected protocol to match custom:[a-z0-9-]+") as z.ZodType<
    `custom:${string}`,
    z.ZodTypeDef,
    string
  >,
  endpoints: CustomEndpointsSchema,
});

export type Sep31Anchor = z.infer<typeof Sep31AnchorSchema>;
export type Sep6Anchor = z.infer<typeof Sep6AnchorSchema>;
export type CustomAnchor = z.infer<typeof CustomAnchorSchema>;
export type AnchorConfig = Sep31Anchor | Sep6Anchor | CustomAnchor;
export type DestProtocol = AnchorConfig["protocol"];

/** Returns the protocol declared by a destination anchor. */
export function protocolOf(anchor: AnchorConfig): DestProtocol {
  return anchor.protocol;
}

/**
 * AnchorSchema for source anchors (source-side protocol negotiation is unversioned/thin).
 */
export const AnchorSchema = z.object({
  name: z.string().min(1),
  endpoints: AnchorEndpointsSchema,
  /** Asset this anchor deals in at this leg. Source side: typically "USDC".
   *  Dest side: the off-chain payout asset, e.g. "iso4217:ARS". */
  asset: z.string().min(1),
});

export type SourceAnchorConfig = z.infer<typeof AnchorSchema>;

/**
 * Destination anchor schema with protocol discrimination and legacy fallback.
 *
 * Supported protocols:
 * - `sep31`: Standard SEP-31 anchor, expects `endpoints.transfer_server_sep31`.
 * - `sep6`: SEP-6 deposit/withdraw anchor, expects `endpoints.transfer_server`.
 * - `custom:<name>`: Custom adapter, expects `endpoints.base_url`.
 *
 * Backward compatibility:
 * When `protocol` is omitted on a destination anchor, it defaults to `"sep31"`
 * if the endpoints shape is SEP-31 compatible (no `transfer_server` or `base_url` keys).
 * A deprecation warning is emitted via `parseCorridor`/`loadCorridor` results.
 * If `protocol` is omitted but `transfer_server` is present, the manifest is
 * rejected with a message instructing the author to set `protocol: sep6`.
 * If `protocol` is omitted but `base_url` is present, the manifest is
 * rejected with a message instructing the author to set `protocol: custom:<name>`.
 */
export const DestAnchorSchema: z.ZodType<AnchorConfig, z.ZodTypeDef, unknown> = z.preprocess(
  (val) => {
    if (typeof val === "object" && val !== null) {
      const raw = val as Record<string, unknown>;
      if (raw.protocol === undefined) {
        const endpoints =
          raw.endpoints && typeof raw.endpoints === "object"
            ? (raw.endpoints as Record<string, unknown>)
            : undefined;
        if (endpoints && "transfer_server" in endpoints) {
          return {
            ...raw,
            protocol: "__missing_protocol_transfer_server__",
          };
        }
        if (endpoints && "base_url" in endpoints) {
          return {
            ...raw,
            protocol: "__missing_protocol_base_url__",
          };
        }
        return { ...raw, protocol: "sep31" };
      }
    }
    return val;
  },
  z.any().transform((val, ctx): AnchorConfig => {
    if (typeof val !== "object" || val === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expected dest to be an object",
      });
      return z.NEVER;
    }
    const raw = val as Record<string, unknown>;
    if (raw.protocol === "__missing_protocol_transfer_server__") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol"],
        message:
          "manifest dest specifies transfer_server with no protocol; set protocol: sep6",
      });
      return z.NEVER;
    }
    if (raw.protocol === "__missing_protocol_base_url__") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol"],
        message:
          "manifest dest specifies base_url with no protocol; set protocol: custom:<name>",
      });
      return z.NEVER;
    }
    if (typeof raw.protocol !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol"],
        message: "missing required protocol",
      });
      return z.NEVER;
    }
    if (raw.protocol === "sep31") {
      const res = Sep31AnchorSchema.safeParse(val);
      if (!res.success) {
        for (const issue of res.error.issues) ctx.addIssue(issue);
        return z.NEVER;
      }
      return res.data;
    }
    if (raw.protocol === "sep6") {
      const res = Sep6AnchorSchema.safeParse(val);
      if (!res.success) {
        for (const issue of res.error.issues) ctx.addIssue(issue);
        return z.NEVER;
      }
      return res.data;
    }
    if (/^custom:[a-z0-9-]+$/.test(raw.protocol)) {
      const res = CustomAnchorSchema.safeParse(val);
      if (!res.success) {
        for (const issue of res.error.issues) ctx.addIssue(issue);
        return z.NEVER;
      }
      return res.data;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["protocol"],
      message: `invalid protocol: ${raw.protocol}; must be "sep31", "sep6", or match custom:[a-z0-9-]+`,
    });
    return z.NEVER;
  }),
);

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
  dest: DestAnchorSchema,
  fx: FxSchema,
  compliance: ComplianceSchema,
  settlement: SettlementSchema,
  recovery: RecoverySchema,
  limits: LimitsSchema.optional(),
});

export type Corridor = z.infer<typeof CorridorSchema>;

export type ParseCorridorOk = Ok<Corridor> & { readonly warnings: string[] };
export type ParseCorridorOutcome = ParseCorridorOk | Err<CorridorError>;

/** Parse + validate a corridor manifest from an object already in memory. */
export function parseCorridor(raw: unknown): ParseCorridorOutcome {
  const warnings: string[] = [];
  if (typeof raw === "object" && raw !== null && "dest" in raw) {
    const dest = (raw as Record<string, unknown>).dest;
    if (typeof dest === "object" && dest !== null && !("protocol" in dest)) {
      warnings.push(
        "dest anchor specifies no protocol; defaulting to 'sep31'. " +
          "Explicitly set dest.protocol: 'sep31' as unversioned endpoint manifests are deprecated.",
      );
    }
  }

  const parsed = CorridorSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("MANIFEST_INVALID", formatZodError(parsed.error), { cause: parsed.error });
  }
  return { ok: true, value: parsed.data, warnings };
}

/** Read + validate a *.corridor.yaml file from disk. */
export function loadCorridor(path: string): ParseCorridorOutcome {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    return fail("MANIFEST_INVALID", `cannot read or parse ${path}`, { cause });
  }
  return parseCorridor(raw);
}

export const parseCorridorWithWarnings = parseCorridor;
export const loadCorridorWithWarnings = loadCorridor;

function formatZodError(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

// Liveness lives beside the schema because it is a statement ABOUT a manifest:
// whether the lane it describes can actually settle, and whether anyone has
// checked. Both the CLI and the web dashboard read it, so neither can report a
// corridor as healthy on its own authority.
export { liveness, LIVENESS_LABEL, type Liveness, type LivenessState } from "./liveness";
