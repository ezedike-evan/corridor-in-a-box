// Runnable end-to-end demo. Run with: pnpm example
//
// It wires the mock anchor + mock submitter + static router + in-memory store,
// loads the reference manifest, and runs a full payment through the engine. The
// orchestration is REAL; only the anchor I/O and the on-chain submit are mocked.
//
// To make it move real money: swap createMockAdapter() -> new Sep31Adapter(corridor)
// and createMockSubmitter() -> your @stellar/stellar-sdk-backed SettlementSubmitter,
// then point the manifest at a live testnet/mainnet anchor.

import { fileURLToPath } from "node:url";
import { loadCorridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import { InMemoryIdempotencyStore, createMockSubmitter, execute } from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

const manifestPath = fileURLToPath(
  new URL("../corridors/reference.corridor.yaml", import.meta.url),
);

async function main(): Promise<void> {
  const loaded = loadCorridor(manifestPath);
  if (!loaded.ok) {
    console.error(`manifest error: ${loaded.error.message}`);
    process.exit(1);
  }
  const corridor = loaded.value;

  const deps = {
    resolver: new StaticRouteResolver(() => createMockAdapter({ name: corridor.dest.name })),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
  };

  const intent: PaymentIntent = {
    idempotencyKey: "demo-0001",
    corridorId: corridor.id,
    sender: { id: "sender-1", jurisdiction: "US" },
    recipient: { id: "recipient-1", jurisdiction: "US" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };

  console.log(`running corridor "${corridor.id}" with intent ${intent.idempotencyKey}\n`);

  const result = await execute(intent, corridor, deps);

  if (result.ok) {
    console.log("✓ payment completed");
    console.log(`  state:       ${result.value.state}`);
    console.log(`  stellar tx:  ${result.value.stellarTxHash}`);
    console.log(`  trail:       ${result.value.trail.join(" -> ")}`);
  } else {
    console.log(`✗ payment failed: ${result.error.code} — ${result.error.message}`);
  }

  // Replaying the same idempotencyKey must NOT settle twice.
  const replay = await execute(intent, corridor, deps);
  console.log(
    `\nreplay with same key -> ${
      replay.ok ? `idempotent return (state=${replay.value.state})` : replay.error.code
    }`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
