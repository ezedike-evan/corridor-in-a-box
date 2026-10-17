// Probe anchors and emit a JSON + markdown report.
//
//   pnpm sweep:anchors [--out <dir|file>] [domain ...]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  decodeProbes,
  decodeSeps,
  probeAnchor,
  renderSweepJson,
  renderSweepMarkdown,
  type ProbeResult,
} from "@corridor/probe";

function load<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as T;
}

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
  const targetDomains =
    domains.length > 0
      ? domains
      : load<{ domains: string[] }>("../contracts/anchors.json").domains;

  console.log(`probing ${targetDomains.length} anchor(s): ${targetDomains.join(" ")}\n`);

  const results: ProbeResult[] = [];
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
