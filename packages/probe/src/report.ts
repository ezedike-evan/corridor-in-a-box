import { decodeProbes, decodeSeps, type ProbeResult } from "./index";

export function isUsableSep31OffRamp(result: ProbeResult): boolean {
  const seps = decodeSeps(result.seps);
  const probes = decodeProbes(result.probesPassed);
  return seps.includes(31) && probes.includes("sep31_info");
}

export function renderSweepMarkdown(results: readonly ProbeResult[]): string {
  const lines: string[] = [
    "# Anchor Sweep Report",
    "",
    "| Domain | Advertised SEPs | Passed Probes | Failed Probes | Usable SEP-31 Off-Ramp |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const r of results) {
    const seps =
      decodeSeps(r.seps)
        .map((s) => `SEP-${s}`)
        .join(", ") || "none";
    const passed = decodeProbes(r.probesPassed).join(", ") || "none";
    const failedOutcomes = r.outcomes.filter((o) => !o.passed);
    const failed = failedOutcomes.map((o) => `${o.probe} (${o.detail})`).join("; ") || "none";
    const usable = isUsableSep31OffRamp(r) ? "Yes" : "No";

    lines.push(`| ${r.domain} | ${seps} | ${passed} | ${failed} | ${usable} |`);
  }

  lines.push("");
  return lines.join("\n");
}

export function renderSweepJson(results: readonly ProbeResult[]): string {
  return JSON.stringify(results, null, 2) + "\n";
}
