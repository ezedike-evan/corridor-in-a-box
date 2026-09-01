// Proves a WHOLE CORRIDOR RUN — quote -> comply -> open -> settle -> reconcile
// -> completed — against the local Anchor Platform reference server.
//
//   scripts/reference-anchor.sh up
//   CORRIDOR_SIGNER_SECRET=S... pnpm verify:corridor
//
// This is the counterpart to `pnpm verify:settle`, and the two prove different
// things:
//
//   verify:settle    the settle leg alone, on live testnet, with no anchor.
//   verify:corridor  every leg, against a conformant SEP-31 counterparty.
//
// Unlike `pnpm testnet`, which drives one payment against whatever anchor the
// manifest names and prints a trail to paste into the README, this is a PASS/FAIL
// gate: it exits non-zero unless the run's terminal state is `completed`, so it
// can sit in CI or in front of a release.
//
// It fails loudly and early rather than hanging: the stack is checked with
// `reference-anchor.sh doctor` before a payment is opened, because a run against
// a sick stack does not fail fast — it polls for the whole of
// recovery.timeout_seconds and then reports SETTLEMENT_TIMEOUT.
//
//   CORRIDOR_SIGNER_SECRET=S...   testnet distribution account seed (required)
//   REFERENCE_ANCHOR_URL=...      local reference server (default localhost:8080)
//   HORIZON_URL=...               default https://horizon-testnet.stellar.org
//   MANIFEST=...                  default corridors/reference.corridor.yaml
//   AMOUNT=...                    default 10.00
//   SKIP_DOCTOR=1                 skip the preflight (stack managed elsewhere)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCorridor } from "@corridor/manifest";
import type { Corridor } from "@corridor/manifest";
import { StaticRouteResolver } from "@corridor/router";
import { Sep31Adapter } from "@corridor/sep31";
import {
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
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

const ANCHOR = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const AMOUNT = process.env.AMOUNT ?? "10.00";

// Exit codes, so a CI job can tell "the stack was not ready" from "the corridor
// ran and did not complete".
const EXIT_MANIFEST = 1;
const EXIT_MISSING_ENV = 2;
const EXIT_REFUSED = 3;
const EXIT_STACK_UNFIT = 4;
const EXIT_NOT_COMPLETED = 5;

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`✗ missing required env var ${name}`);
    console.error(`  A testnet distribution account seed. Never a mainnet seed — see`);
    console.error(`  docs/key-management.md.`);
    process.exit(EXIT_MISSING_ENV);
  }
  return v;
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

/** Point every leg at the local reference server, whatever the manifest says.
 *  This runner exists to test THAT counterparty; silently driving a payment at
 *  a remote anchor because a manifest was edited is not a failure mode worth
 *  leaving open. */
function pinToReferenceAnchor(corridor: Corridor): Corridor {
  const host = ANCHOR.replace(/^https?:\/\//, "");
  return {
    ...corridor,
    dest: {
      ...corridor.dest,
      endpoints: {
        ...corridor.dest.endpoints,
        home_domain: host,
        transfer_server_sep31: `${ANCHOR}/sep31`,
        web_auth: `${ANCHOR}/auth`,
        kyc_server: `${ANCHOR}/sep12`,
        quote_server: `${ANCHOR}/sep38`,
      },
    },
  };
}

/** `reference-anchor.sh doctor`, so "the stack is not up" is a named failure a
 *  second in rather than a SETTLEMENT_TIMEOUT fifteen minutes in. */
function preflightDoctor(): void {
  if (process.env.SKIP_DOCTOR === "1") {
    console.log("• preflight: skipped (SKIP_DOCTOR=1)\n");
    return;
  }
  const script = fileURLToPath(new URL("../scripts/reference-anchor.sh", import.meta.url));
  const run = spawnSync(script, ["doctor"], { stdio: "inherit" });
  if (run.error) {
    console.error(`✗ could not run ${script}: ${run.error.message}`);
    console.error(
      `  Start the stack with 'scripts/reference-anchor.sh up', or set SKIP_DOCTOR=1`,
    );
    console.error(`  if it is managed elsewhere.`);
    process.exit(EXIT_STACK_UNFIT);
  }
  if (run.status !== 0) {
    console.error(
      `\n✗ the reference anchor is not fit to run a corridor (doctor exit ${run.status}).`,
    );
    console.error(
      `  Fix the checks above — 'scripts/reference-anchor.sh up' reseeds the observer`,
    );
    console.error(`  cursor, which is the usual culprit.`);
    process.exit(EXIT_STACK_UNFIT);
  }
  console.log();
}

/** SEP-38 `/info` is the anchor's own statement of which assets it will quote,
 *  as `stellar:CODE:ISSUER`. A bridge asset it does not list fails well after
 *  the quote with nothing pointing at the cause, so name it up front. */
async function assertAssetQuotable(corridor: Corridor): Promise<void> {
  const issuer = corridor.settlement.asset_issuer;
  if (!issuer) return;
  const code = corridor.settlement.bridge_asset;
  const want = `stellar:${code}:${issuer}`;

  let body: { assets?: { asset?: string }[] };
  try {
    const res = await fetch(`${ANCHOR}/sep38/info`);
    body = (await res.json()) as { assets?: { asset?: string }[] };
  } catch (e) {
    console.error(`✗ could not read ${ANCHOR}/sep38/info: ${String(e)}`);
    process.exit(EXIT_STACK_UNFIT);
  }

  const assets = (body.assets ?? []).map((a) => a.asset ?? "");
  if (assets.includes(want)) return;

  console.error(`✗ ${ANCHOR} does not quote ${want}.`);
  const sameCode = assets.filter((a) => a.startsWith(`stellar:${code}:`));
  if (sameCode.length > 0) {
    console.error(`  It quotes: ${sameCode.join(", ")}`);
    console.error(`  Set settlement.asset_issuer in the manifest to one of those issuers.`);
  } else {
    console.error(
      `  It quotes no ${code} at all. Available: ${assets.join(", ") || "(none)"}`,
    );
  }
  process.exit(EXIT_REFUSED);
}

async function main(): Promise<void> {
  const loaded = loadCorridor(resolveManifestPath());
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(EXIT_MANIFEST);
  }

  // Same mainnet guard as `pnpm testnet` and `pnpm serve`, with no escape hatch:
  // this runner drives payments at a LOCAL reference server, so a mainnet
  // corridor here is always a mistake rather than a decision.
  if (loaded.value.settlement.network === "public") {
    console.error(
      `✗ corridor "${loaded.value.id}" settles on MAINNET (network=public). This runner ` +
        `verifies against a local reference anchor and will not move real money.`,
    );
    process.exit(EXIT_REFUSED);
  }

  const corridor = pinToReferenceAnchor(loaded.value);

  preflightDoctor();
  await assertAssetQuotable(corridor);

  const signer = LocalKeypairSigner.fromSecret(env("CORRIDOR_SIGNER_SECRET"));
  const adapter = new Sep31Adapter(corridor, { sep10: new StellarSep10Signer(signer) });
  const audit = new InMemoryAuditLog();
  const store = new InMemoryIdempotencyStore();

  const deps: EngineDeps = {
    resolver: new StaticRouteResolver(() => adapter),
    submitter: new StellarSettlementSubmitter({ signer, horizonUrl: HORIZON }),
    idempotency: store,
    audit,
    logger: consoleLogger,
  };

  // SEP-12 identifies both parties to the receiving anchor. The sending side
  // holds the PII and registers; the engine only ever carries the returned ids.
  const register = async (role: "receiver" | "sender", type: string): Promise<string> => {
    console.log(`registering ${role} (SEP-12)…`);
    const reg = await adapter.registerCustomer(
      {
        first_name: "Alice",
        last_name: "Example",
        email_address: `${role}@example.com`,
        bank_account_number: "12345678901234",
        bank_number: "021000021",
        bank_account_type: "checking",
        clabe_number: "032180000118359719",
      },
      { type },
    );
    if (!reg.ok) {
      console.error(
        `✗ SEP-12 ${role} registration failed: ${reg.error.code} — ${reg.error.message}`,
      );
      console.error(
        `  Read the anchor's GET /sep12/customer response for the fields it needs.`,
      );
      process.exit(EXIT_NOT_COMPLETED);
    }
    console.log(`  ${role}: ${reg.value}`);
    return reg.value;
  };

  const senderSep12Id =
    process.env.SENDER_SEP12_ID ??
    (await register("sender", corridor.compliance.sep12_sender_type));
  const recipientSep12Id =
    process.env.RECIPIENT_SEP12_ID ??
    (await register("receiver", corridor.compliance.sep12_receiver_type));

  const intent: PaymentIntent = {
    idempotencyKey: process.env.IDEMPOTENCY_KEY ?? `verify-corridor-${Date.now()}`,
    corridorId: corridor.id,
    sender: {
      id: "sender-1",
      jurisdiction: corridor.compliance.source_jurisdiction,
      sep12Id: senderSep12Id,
    },
    recipient: {
      id: "recipient-1",
      jurisdiction: corridor.compliance.dest_jurisdiction,
      sep12Id: recipientSep12Id,
    },
    sourceAmount: { asset: corridor.settlement.bridge_asset, amount: AMOUNT },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };

  console.log(`\nverifying corridor "${corridor.id}" against ${ANCHOR}`);
  console.log(`  signer:  ${signer.publicKey}`);
  console.log(`  horizon: ${HORIZON}`);
  console.log(
    `  intent:  ${intent.idempotencyKey} (${AMOUNT} ${corridor.settlement.bridge_asset})\n`,
  );

  const result = await execute(intent, corridor, deps);

  // The trail comes from the audit sink rather than RunResult, so a FAILED run
  // prints one too — which is the case where it is actually worth reading.
  const trail =
    audit.entries.length > 0
      ? [audit.entries[0].from, ...audit.entries.map((e) => e.to)]
      : ((result.ok ? result.value.trail : []) as readonly string[]);
  const stored = await store.get(intent.idempotencyKey);

  console.log(`\ntrail: ${trail.join(" -> ")}`);
  if (stored?.stellarTxHash) {
    console.log(`stellar tx: ${stored.stellarTxHash}`);
    console.log(
      `explorer:   https://stellar.expert/explorer/testnet/tx/${stored.stellarTxHash}`,
    );
  }

  if (!result.ok) {
    console.error(`\n✗ ${result.error.code} — ${result.error.message}`);
    console.error(`  terminal state: ${stored?.state ?? "unknown"}`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  if (result.value.state !== "completed") {
    console.error(`\n✗ terminal state is "${result.value.state}", not "completed"`);
    if (stored?.lastError) console.error(`  last error: ${stored.lastError}`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  console.log(`\n✓ corridor completed end to end against the reference anchor`);
  console.log(`  ${audit.entries.length} transitions recorded`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
