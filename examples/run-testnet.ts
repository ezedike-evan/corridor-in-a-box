// One-command REAL run against a live SEP-31 anchor. This is the wiring behind
// the README "Going live" list and docs/operations.md §1 — it swaps every mock
// for the production implementation and drives one payment end to end, then
// prints the trail + Stellar tx hash you paste into the README.
//
//   CORRIDOR_SIGNER_SECRET=S...            # testnet distribution account seed
//   HORIZON_URL=https://horizon-testnet.stellar.org
//   MANIFEST=corridors/reference.corridor.yaml
//   DATABASE_URL=postgres://...            # optional; falls back to in-memory
//   pnpm testnet
//
// SAFETY: refuses to run a `public` (mainnet) corridor unless you set
// CORRIDOR_ALLOW_MAINNET=1 — this moves real money. Read docs/key-management.md
// before pointing it at a mainnet seed (use a KMS-backed ExternalSigner, never a
// raw secret in env, for anything but throwaway testnet keys).

import { fileURLToPath } from "node:url";
import { loadCorridor } from "@corridor/manifest";
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
  PostgresIdempotencyStore,
  consoleLogger,
  execute,
  migrate,
  type EngineDeps,
  type IdempotencyStore,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`✗ missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  // Allow both repo-relative (default) and absolute/cwd-relative paths.
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

async function buildStore(): Promise<{ store: IdempotencyStore; close: () => Promise<void> }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("• idempotency: in-memory (set DATABASE_URL for a durable run)");
    return { store: new InMemoryIdempotencyStore(), close: async () => {} };
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: dbUrl });
  await migrate(pool);
  console.log("• idempotency: Postgres (migrated)");
  return { store: new PostgresIdempotencyStore(pool), close: () => pool.end() };
}

async function main(): Promise<void> {
  const loaded = loadCorridor(resolveManifestPath());
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(1);
  }
  const corridor = loaded.value;

  if (corridor.settlement.network === "public" && process.env.CORRIDOR_ALLOW_MAINNET !== "1") {
    console.error(
      `✗ corridor "${corridor.id}" settles on MAINNET (network=public). This moves real ` +
        `money. Re-run with CORRIDOR_ALLOW_MAINNET=1 only if you mean it.`,
    );
    process.exit(3);
  }

  if (!corridor.dest.endpoints.transfer_server_sep31) {
    console.error(
      `✗ corridor "${corridor.id}" has no dest SEP-31 transfer server — not runnable. ` +
        `Fill dest.endpoints from the anchor's stellar.toml first (see 'pnpm cli plan').`,
    );
    process.exit(1);
  }

  const signer = LocalKeypairSigner.fromSecret(env("CORRIDOR_SIGNER_SECRET"));
  const horizonUrl = env("HORIZON_URL", "https://horizon-testnet.stellar.org");

  const adapter = new Sep31Adapter(corridor, { sep10: new StellarSep10Signer(signer) });
  const submitter = new StellarSettlementSubmitter({ signer, horizonUrl });
  const { store, close } = await buildStore();
  const audit = new InMemoryAuditLog();

  const deps: EngineDeps = {
    resolver: new StaticRouteResolver(() => adapter),
    submitter,
    idempotency: store,
    audit,
    logger: consoleLogger,
  };

  const intent: PaymentIntent = {
    idempotencyKey: process.env.IDEMPOTENCY_KEY ?? `testnet-${Date.now()}`,
    corridorId: corridor.id,
    sender: {
      id: process.env.SENDER_ID ?? "sender-1",
      jurisdiction: corridor.compliance.source_jurisdiction,
    },
    recipient: {
      id: process.env.RECIPIENT_ID ?? "recipient-1",
      jurisdiction: corridor.compliance.dest_jurisdiction,
    },
    sourceAmount: {
      asset: corridor.settlement.bridge_asset,
      amount: process.env.AMOUNT ?? "10.00",
    },
  };

  console.log(`\nrunning corridor "${corridor.id}" on ${corridor.settlement.network}`);
  console.log(`signer:     ${signer.publicKey}`);
  console.log(`horizon:    ${horizonUrl}`);
  console.log(`anchor:     ${corridor.dest.endpoints.transfer_server_sep31}`);
  console.log(
    `intent:     ${intent.idempotencyKey} (${intent.sourceAmount.amount} ${intent.sourceAmount.asset})\n`,
  );

  try {
    const result = await execute(intent, corridor, deps);
    if (result.ok) {
      console.log("\n✓ payment completed");
      console.log(`  state:       ${result.value.state}`);
      console.log(`  stellar tx:  ${result.value.stellarTxHash}`);
      console.log(`  trail:       ${result.value.trail.join(" -> ")}`);
      console.log(`  audit:       ${audit.entries.length} transitions recorded`);
      console.log(`\nPaste the trail + stellar tx into the README to close the Phase-1 item.`);
    } else {
      console.error(`\n✗ payment failed: ${result.error.code} — ${result.error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
