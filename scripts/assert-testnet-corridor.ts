// Refuses to proceed unless a corridor manifest settles on testnet.
//
// The guard exists so a job that signs and settles cannot be pointed at
// `network: public` by an edit to a manifest, a workflow input, or an env var.
// The runners carry their own mainnet guard; this is the first line, run before
// any container is started or any key is read.
//
// Parsed with the repo's own loader rather than grepped: a restructured YAML
// cannot slip a mainnet corridor past a pattern match.
//
//   pnpm exec tsx scripts/assert-testnet-corridor.ts corridors/reference.corridor.yaml
//
// Exits 0 when the corridor is testnet, 1 with a named reason otherwise.

import { loadCorridor } from "@corridor/manifest";

const path = process.argv[2] ?? process.env.MANIFEST;

if (!path) {
  console.error("assert-testnet-corridor: pass a manifest path or set MANIFEST");
  process.exit(1);
}

const result = loadCorridor(path);
if (!result.ok) {
  console.error(`assert-testnet-corridor: ${path} is unreadable: ${result.error.message}`);
  process.exit(1);
}

const network = result.value.settlement.network;
if (network !== "testnet") {
  console.error(
    `assert-testnet-corridor: refusing to run — corridor "${result.value.id}" settles on ` +
      `"${network}", and this path is testnet-only.`,
  );
  process.exit(1);
}

console.log(`corridor "${result.value.id}" settles on ${network}`);
