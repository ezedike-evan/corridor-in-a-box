// Probe every tracked anchor and emit a JSON + markdown report.
//
//   pnpm sweep:anchors --out /tmp/sweep
//   pnpm sweep:anchors testanchor.stellar.org cowrie.exchange --out /tmp/sweep
//   pnpm sweep:anchors
//
// Credential-free and read-only: anyone can run this without keys to answer
// "across every anchor we track, what works today?".

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSweepArgs,
  renderSweepJson,
  renderSweepMarkdown,
  sweepAnchors,
} from "@corridor/probe";

async function main(): Promise<void> {
  const { domains: cliDomains, outDir, concurrency } = parseSweepArgs(process.argv.slice(2));

  let domains = cliDomains;
  if (domains.length === 0) {
    try {
      const anchorsJson = JSON.parse(
        readFileSync(new URL("../contracts/anchors.json", import.meta.url), "utf8"),
      ) as { domains: string[] };
      domains = anchorsJson.domains;
    } catch (e) {
      console.error("✗ failed to load contracts/anchors.json:", e);
      process.exit(1);
    }
  }

  if (domains.length === 0) {
    console.error("✗ no domains to sweep");
    process.exit(1);
  }

  console.log(
    `Sweeping ${domains.length} anchor(s) with concurrency ${concurrency ?? 4}...\n`,
  );

  const results = await sweepAnchors(domains, {
    concurrency,
    onProgress: (r, idx, total) => {
      console.log(`[${idx + 1}/${total}] ${r.domain}: probes passed=${r.probesPassed}`);
    },
  });

  const timestamp = new Date().toISOString();
  const jsonReport = renderSweepJson(results, { timestamp });
  const mdReport = renderSweepMarkdown(results, { timestamp });

  if (outDir) {
    try {
      mkdirSync(outDir, { recursive: true });
      const jsonPath = join(outDir, "sweep.json");
      const mdPath = join(outDir, "sweep.md");
      writeFileSync(jsonPath, jsonReport, "utf8");
      writeFileSync(mdPath, mdReport, "utf8");
      console.log(`\n✓ Wrote reports to:\n  ${jsonPath}\n  ${mdPath}`);
    } catch (e) {
      console.error(`✗ failed to write report files to ${outDir}:`, e);
      process.exit(1);
    }
  } else {
    console.log("\n" + mdReport);
  }
}

main().catch((e) => {
  console.error("✗ sweep failed:", e);
  process.exit(1);
});
