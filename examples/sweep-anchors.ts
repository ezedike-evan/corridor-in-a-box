// Probe anchors and emit a JSON + markdown report.
//
//   pnpm sweep:anchors [--out <dir|file.json>] [domain ...]   (alias: pnpm probe:sweep)
//
// Probes each domain exactly once, prints the human-readable outcome, and writes
// the exact ProbeResult array (`sweep.json`) plus a markdown table (`sweep.md`).
// `--out` is a directory (default `sweep/`) or a `.json` file path. The workflow
// attests from `sweep.json` (`pnpm attest --from`), so what is attested is what was
// observed, not a second probe.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  decodeProbes,
  decodeSeps,
  loadFleet,
  probeAnchor,
  renderSweepJson,
  renderSweepMarkdown,
  type ProbeResult,
} from "@corridor/probe";

interface SweepArgs {
  out: string;
  domains: string[];
}

function parseSweepArgs(args: readonly string[]): SweepArgs {
  let out = "sweep";
  const domains: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out" && i + 1 < args.length) {
      out = args[++i];
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (!arg.startsWith("-")) {
      domains.push(arg);
    }
  }
  return { out, domains };
}

async function main(): Promise<void> {
  const { out, domains } = parseSweepArgs(process.argv.slice(2));
  const targetDomains = domains.length > 0 ? domains : loadFleet().domains;

  console.log(`probing ${targetDomains.length} anchor(s): ${targetDomains.join(" ")}\n`);

  const results: ProbeResult[] = [];
  const failedDomains: string[] = [];
  for (const domain of targetDomains) {
    console.log(`probing ${domain}`);
    try {
      const r = await probeAnchor(domain);
      for (const o of r.outcomes) {
        console.log(`  ${o.passed ? "✓" : "✗"} ${o.probe.padEnd(13)} ${o.detail}`);
      }

      const advertised = decodeSeps(r.seps);
      const failed = decodeProbes(r.probesRun).filter(
        (p) => !decodeProbes(r.probesPassed).includes(p),
      );

      console.log(`\n--- attestation for ${r.domain} ---`);
      console.log(
        `  advertises     ${advertised.map((n) => `SEP-${n}`).join(", ") || "none"}`,
      );
      console.log(`  probes passed  ${decodeProbes(r.probesPassed).join(", ") || "none"}`);
      console.log(`  probes FAILED  ${failed.join(", ") || "none"}`);
      console.log(`  toml_hash      ${r.tomlHash}`);
      console.log(
        `  seps=${r.seps} probes_run=${r.probesRun} probes_passed=${r.probesPassed}\n`,
      );

      results.push(r);
    } catch (err) {
      console.error(`  ✗ failed to probe ${domain}:`, err);
      failedDomains.push(domain);
    }
  }

  // Determine output file paths
  let jsonPath: string;
  let mdPath: string;
  if (out.endsWith(".json")) {
    jsonPath = out;
    mdPath = out.replace(/\.json$/, ".md");
    const dir = dirname(out);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } else {
    // Directory target
    if (!existsSync(out)) mkdirSync(out, { recursive: true });
    jsonPath = join(out, "sweep.json");
    mdPath = join(out, "sweep.md");
  }

  writeFileSync(jsonPath, renderSweepJson(results), "utf8");
  writeFileSync(mdPath, renderSweepMarkdown(results), "utf8");
  console.log(`✓ wrote sweep report to ${jsonPath} and ${mdPath}`);

  // A probe that could not run at all is not a finding about the anchor; fail the
  // run (after the report is written) rather than silently attesting a short list.
  if (failedDomains.length > 0) {
    console.error(`✗ could not probe: ${failedDomains.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
