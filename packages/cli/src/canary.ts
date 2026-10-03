import { liveness, type Corridor } from "@corridor/manifest";
import { Sep31Adapter } from "@corridor/sep31";
import { StaticRouteResolver } from "@corridor/router";
import {
  AccountInspector,
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
} from "@corridor/stellar";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  consoleLogger,
  execute,
  type EngineDeps,
  type SettlementRequest,
  type SettlementSubmitter,
} from "@corridor/engine";
import { compareAmounts, type PaymentIntent } from "@corridor/types";
import { DEFAULT_CANARY_MAX_AMOUNT, finalizeCanary, type PaymentVerifier } from "./proof";

export interface CanaryOptions {
  readonly manifestPath: string;
  readonly amount: string;
  readonly write: boolean;
  /** Explicit network opt-in; public corridors require `public`. */
  readonly network?: "public" | "testnet";
  readonly now?: Date;
}

const EXIT_MISSING_ENV = 2;
const EXIT_REFUSED = 3;
const EXIT_NOT_COMPLETED = 5;

function requiredEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function defaultHorizon(network: "public" | "testnet"): string {
  return network === "public"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

function registerCustomer(
  adapter: Sep31Adapter,
  role: "sender" | "receiver",
  type: string,
): Promise<string | undefined> {
  return adapter
    .registerCustomer(
      {
        first_name: process.env[`${role.toUpperCase()}_FIRST_NAME`] ?? "Alice",
        last_name: process.env[`${role.toUpperCase()}_LAST_NAME`] ?? "Example",
        email_address: process.env[`${role.toUpperCase()}_EMAIL`] ?? `${role}@example.com`,
        bank_account_number: "12345678901234",
        bank_number: "021000021",
        bank_account_type: "checking",
        clabe_number: "032180000118359719",
      },
      { type },
    )
    .then((result) => {
      if (!result.ok) {
        console.error(
          `✗ SEP-12 ${role} registration failed: ${result.error.code} — ${result.error.message}`,
        );
        return undefined;
      }
      return result.value;
    });
}

/** Run one real canary payment and emit/write its proof after chain verification. */
export async function runCanary(corridor: Corridor, opts: CanaryOptions): Promise<number> {
  const network = corridor.settlement.network;
  if (opts.network && opts.network !== network) {
    console.error(`✗ --network ${opts.network} does not match manifest network ${network}`);
    return EXIT_REFUSED;
  }
  if (network === "public" && opts.network !== "public") {
    console.error(
      `✗ corridor "${corridor.id}" settles on MAINNET. Re-run with --network public only if you mean it.`,
    );
    return EXIT_REFUSED;
  }

  const live = liveness(corridor);
  if (!live.runnable) {
    console.error(
      `✗ corridor "${corridor.id}" is ${live.state}; fix the manifest before canarying.`,
    );
    for (const warning of live.warnings) console.error(`  ! ${warning}`);
    return EXIT_REFUSED;
  }

  const cap = corridor.proof?.canary_max_amount ?? DEFAULT_CANARY_MAX_AMOUNT;
  const amountComparison = compareAmounts(opts.amount, cap);
  if (!amountComparison.ok) {
    console.error(`✗ invalid canary amount: ${amountComparison.error.message}`);
    return EXIT_REFUSED;
  }
  if (amountComparison.value > 0) {
    console.error(`✗ canary amount ${opts.amount} exceeds the ceiling ${cap}`);
    return EXIT_REFUSED;
  }

  const secret = requiredEnv("CORRIDOR_SIGNER_SECRET");
  if (!secret) {
    console.error("✗ missing required env var CORRIDOR_SIGNER_SECRET");
    return EXIT_MISSING_ENV;
  }
  const horizonUrl = process.env.HORIZON_URL ?? defaultHorizon(network);
  const signer = LocalKeypairSigner.fromSecret(secret);
  const adapter = new Sep31Adapter(corridor, { sep10: new StellarSep10Signer(signer) });
  const settlementSubmitter = new StellarSettlementSubmitter({ signer, horizonUrl });
  let settlement: SettlementRequest | undefined;
  const submitter: SettlementSubmitter = {
    submit: async (request) => {
      settlement = request;
      return settlementSubmitter.submit(request);
    },
    refund: (request) => settlementSubmitter.refund(request),
  };

  const senderSep12Id =
    process.env.SENDER_SEP12_ID ??
    (await registerCustomer(adapter, "sender", corridor.compliance.sep12_sender_type));
  if (!senderSep12Id) return EXIT_NOT_COMPLETED;
  const recipientSep12Id =
    process.env.RECIPIENT_SEP12_ID ??
    (await registerCustomer(adapter, "receiver", corridor.compliance.sep12_receiver_type));
  if (!recipientSep12Id) return EXIT_NOT_COMPLETED;

  const intent: PaymentIntent = {
    idempotencyKey: process.env.IDEMPOTENCY_KEY ?? `canary-${Date.now()}`,
    corridorId: corridor.id,
    sender: {
      id: process.env.SENDER_ID ?? "canary-sender",
      jurisdiction: corridor.compliance.source_jurisdiction,
      sep12Id: senderSep12Id,
    },
    recipient: {
      id: process.env.RECIPIENT_ID ?? "canary-recipient",
      jurisdiction: corridor.compliance.dest_jurisdiction,
      sep12Id: recipientSep12Id,
    },
    sourceAmount: { asset: corridor.settlement.bridge_asset, amount: opts.amount },
    destinationFields: {
      receiver_routing_number: process.env.RECEIVER_ROUTING_NUMBER ?? "021000021",
      receiver_account_number: process.env.RECEIVER_ACCOUNT_NUMBER ?? "12345678901234",
      type: process.env.RECEIVER_DEPOSIT_TYPE ?? "SWIFT",
    },
  };

  const deps: EngineDeps = {
    resolver: new StaticRouteResolver(() => adapter, {
      trustManifestWithoutAttestation: true,
    }),
    submitter,
    idempotency: new InMemoryIdempotencyStore(),
    audit: new InMemoryAuditLog(),
    logger: consoleLogger,
    trustManifestWithoutAttestation: true,
  };

  console.log(`canary: ${corridor.id} on ${network}`);
  console.log(`amount: ${opts.amount} ${corridor.settlement.bridge_asset}`);
  console.log(`horizon: ${horizonUrl}`);

  const run = await execute(intent, corridor, deps);
  if (!run.ok) {
    console.error(`✗ canary failed: ${run.error.code} — ${run.error.message}`);
    return EXIT_NOT_COMPLETED;
  }
  if (run.value.state !== "completed") {
    console.error(`✗ canary terminal state is "${run.value.state}", not "completed"`);
    return EXIT_NOT_COMPLETED;
  }
  if (!settlement) {
    console.error(
      "✗ canary completed without a captured settlement request; no proof written",
    );
    return EXIT_NOT_COMPLETED;
  }

  const verifier: PaymentVerifier = new AccountInspector({ horizonUrl });
  const finalized = await finalizeCanary({
    result: run.value,
    settlement,
    corridor,
    verifier,
    manifestPath: opts.manifestPath,
    write: opts.write,
    now: opts.now,
  });
  if (!finalized.ok) {
    console.error(
      `✗ canary proof rejected: ${finalized.error.code} — ${finalized.error.message}`,
    );
    return EXIT_NOT_COMPLETED;
  }

  console.log(`trail: ${run.value.trail.join(" -> ")}`);
  console.log(finalized.value.yaml);
  if (finalized.value.written) console.log(`wrote proof to ${opts.manifestPath}`);
  return 0;
}

export function canaryUsage(): string {
  return "usage: corridor canary <file.corridor.yaml> --amount <decimal> [--write] [--network public]";
}
