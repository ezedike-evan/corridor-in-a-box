// Probe anchors and record the exact results to a JSON file.
//
//   pnpm probe:sweep [--out sweep.json] [testanchor.stellar.org ...]
//
// Probes each domain exactly once, prints the human-readable outcome,
// and saves the exact ProbeResult array to disk so the attestation step
// can submit what was observed without reprobing.

import { writeFileSync } from "node:fs";
import {
  decodeProbes,
  decodeSeps,
  loadFleet,
  probeAnchor,
  type ProbeResult,
} from "@corridor/probe";

interface SweepArgs {
  outFile: string;
  domains: string[];
}

function parseSweepArgs(args: readonly string[]): SweepArgs {
  let outFile = "sweep.json";
  const domains: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out" && i + 1 < args.length) {
      outFile = args[++i];
    } else if (arg.startsWith("--out=")) {
      outFile = arg.slice("--out=".length);
    } else if (!arg.startsWith("-")) {
      domains.push(arg);
    }
  }
  return { outFile, domains };
}

async function main(): Promise<void> {
  const { outFile, domains } = parseSweepArgs(process.argv.slice(2));
  const targetDomains = domains.length > 0 ? domains : loadFleet().domains;

  console.log(`probing ${targetDomains.length} anchor(s): ${targetDomains.join(" ")}\n`);

  const results: ProbeResult[] = [];
  for (const domain of targetDomains) {
    console.log(`probing ${domain}`);
    const r = await probeAnchor(domain);
    for (const o of r.outcomes) {
      console.log(`  ${o.passed ? "✓" : "✗"} ${o.probe.padEnd(13)} ${o.detail}`);
    }

    const advertised = decodeSeps(r.seps);
    const failed = decodeProbes(r.probesRun).filter(
      (p) => !decodeProbes(r.probesPassed).includes(p),
    );

    console.log(`\n--- attestation for ${r.domain} ---`);
    console.log(`  advertises     ${advertised.map((n) => `SEP-${n}`).join(", ") || "none"}`);
    console.log(`  probes passed  ${decodeProbes(r.probesPassed).join(", ") || "none"}`);
    console.log(`  probes FAILED  ${failed.join(", ") || "none"}`);
    console.log(`  toml_hash      ${r.tomlHash}`);
    console.log(
      `  seps=${r.seps} probes_run=${r.probesRun} probes_passed=${r.probesPassed}\n`,
    );

    results.push(r);
  }

  writeFileSync(outFile, JSON.stringify(results, null, 2) + "\n", "utf8");
  console.log(`✓ wrote ${results.length} probe result(s) to ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
