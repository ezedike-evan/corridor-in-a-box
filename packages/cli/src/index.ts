#!/usr/bin/env node
// corridor — a tiny CLI to validate manifests and dry-run the plan offline.
//
//   corridor validate <file.corridor.yaml>
//   corridor plan     <file.corridor.yaml>
//
// `plan` is the cheap pre-flight: it tells you whether a corridor is actually
// runnable (does the dest anchor expose SEP-31? a SEP-38 quote server?) before
// you ever touch the network. This is the off-ramp check from the conversation,
// reduced to one command.

import { loadCorridor, type Corridor } from "@corridor/manifest";

function main(argv: string[]): number {
  const [cmd, file] = argv;
  if (!cmd || (cmd !== "validate" && cmd !== "plan")) {
    console.error("usage: corridor <validate|plan> <file.corridor.yaml>");
    return 2;
  }
  if (!file) {
    console.error(`usage: corridor ${cmd} <file.corridor.yaml>`);
    return 2;
  }

  const loaded = loadCorridor(file);
  if (!loaded.ok) {
    console.error(`✗ ${loaded.error.code}: ${loaded.error.message}`);
    return 1;
  }
  const c = loaded.value;

  if (cmd === "validate") {
    console.log(`✓ ${file} is a valid corridor manifest (id="${c.id}")`);
    return 0;
  }

  printPlan(c);
  return 0;
}

function printPlan(c: Corridor): void {
  const line = (s = "") => console.log(s);
  line(`corridor: ${c.id}`);
  if (c.status_note) line(`note:     ${c.status_note}`);
  line(
    `route:    ${c.fx.path.join(" -> ")}   (risk: ${c.fx.who_holds_risk}, ttl ${c.fx.quote_ttl_seconds}s)`,
  );
  line(`source:   ${c.source.name}  [${c.source.asset}]  ${c.source.endpoints.home_domain}`);
  line(`dest:     ${c.dest.name}  [${c.dest.asset}]  ${c.dest.endpoints.home_domain}`);
  line(`bridge:   ${c.settlement.bridge_asset} on ${c.settlement.network}`);
  line(
    `recovery: retries=${c.recovery.max_retries}, timeout=${c.recovery.timeout_seconds}s, rollback=${c.recovery.rollback}`,
  );
  line();
  line("steps:");
  line("  1. quote      SEP-38  POST /quote");
  line("  2. comply     SEP-10 auth + SEP-12 KYC handoff");
  line("  3. open       SEP-31  POST /transactions");
  line("  4. settle     native Stellar payment of bridge asset");
  line("  5. reconcile  SEP-31  GET /transactions/:id");
  line();

  const warnings: string[] = [];
  if (!c.dest.endpoints.transfer_server_sep31) {
    warnings.push(
      "dest has no SEP-31 transfer server — corridor cannot settle. NOT runnable.",
    );
  }
  if (c.fx.quote_source === "sep38" && !c.dest.endpoints.quote_server) {
    warnings.push(
      "fx.quote_source=sep38 but dest exposes no SEP-38 quote server — quotes will fail.",
    );
  }
  if (!c.dest.endpoints.kyc_server) {
    warnings.push(
      "dest has no SEP-12 KYC server — assuming 1:1 delivery with no per-customer KYC.",
    );
  }

  if (warnings.length === 0) {
    line("liveness: ✓ endpoints present for all five steps");
  } else {
    line("liveness warnings:");
    for (const w of warnings) line(`  ! ${w}`);
  }
}

process.exit(main(process.argv.slice(2)));
