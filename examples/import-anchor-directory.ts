/**
 * Import anchor candidates from the Stellar Anchor Directory.
 *
 * Usage:
 *   pndx ts examples/import-anchor-directory.ts
 *
 * The script fetches the directory feed, reads the current contracts/anchors.json,
 * and prints a diff of domains that are in the directory but not yet in the
 * fleet (and vice versa). It never writes to contracts/anchors.json — a
 * human opens the PR.
 *
 * The directory feed is published as a JSON array of anchor records at:
 *   https://anchors.stellar.org/api/anchors
 * (confirmed at time of writing; see the issue for the link and field mapping.)
 */

import { readFileSync } from "node:fs";
import {join} from "node:path";

export interface DirectoryAnchor {
  /** Home domain of the anchor (e.g. "anchor.example"). */
  home_domain: string;
  /** Countries the anchor serves, ISO 3166-1 alpha-2 codes. */
  countries?: string[];
  /** Currencies the anchor supports, ISO 4217 or custom codes. */
  currencies?: string[];
  /** SEPs the anchor claims to implement (e.g. [6, 24, 31]). */
  seps?: number[];
}

export interface FleetAnchor {
  home_domain: string;
}

export interface DiffResult {
  /** Domains present in the directory but missing from the fleet. */
  missingFromFleet: DirectoryAnchor[];
  /** Domains in the fleet that are not in the directory. */
  missingFromDirectory: FleetAnchor;
}

const DIRECTORY_URL = "https://anchors.stellar.org/api/anchors";

const FLEET_PATH = join(process.cwd(), "contracts", "anchors.json");

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

export function computeDiff(
  directory: DirectoryAnchor[],
  fleet: FleetAnchor[],
): DiffResult {
  const fleetDomains = new Set(fleet.map((a) => normalizeDomain(a.home_domain)));
  const directoryDomains = new Set(
    directory.map((a) => normalizeDomain(a.home_domain)),
  );

  const missingFromFleet = directory.filter(
    (a) => !fleetDomains.has(normalizeDomain(a.home_domain)),
  );
  const missingFromDirectory = fleet.filter(
    (a) => !directoryDomains.has(normalizeDomain(a.home_domain)),
  );

  return { missingFromFleet, missingFromDirectory };
}

export function formatDiff(diff: DiffResult): string {
  const lines: string[] = [];

  if (diff.missingFromFleet.length === 0 && diff.missingFromDirectory.length === 0) {
    return "No diff: the fleet matches the Stellar Anchor Directory.\n";
  }

  if (diff.missingFromFleet.length > 0) {
    lines.push("Anchors in the directory but not in contracts/anchors.json:");
    for (const anchor of diff.missingFromFleet) {
      lines.push(
        `${anchor.home_domain}${formatMetadata(anchor)}`,
      );
    }
    lines.push("");
  }

  if (diff.missingFromDirectory.length > 0) {
    lines.push("Anchors in contracts/anchors.json but not in the directory:");
    for (const anchor of diff.missingFromDirectory) {
      lines.push(anchor.home_domain);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function formatMetadata(anchor: DirectoryAnchor): string {
  const parts: string[] = [];
  if (anchor.countries && anchor.countries.length > 0) {
    parts.push(`countries=${anchor.countries.join(",")}`);
  }
  if (anchor.currencies && anchor.currencies.length > 0) {
    parts.push(`currencies=${anchor.currencies.join(",")}`);
  }
  if (anchor.seps && anchor.seps.length > 0) {
    parts.push(`seps=${anchor.seps.join(",")}`);
  }
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

export function readFleet(path: string = FLEET_PATH): FleetAnchor[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array`);
  }
  return parsed.map((entry: unknown, index: number) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { home_domain?: unknown }).home_domain !== "string"
    ) {
      throw new Error(
        `${path}[${index}] is missing a string home_domain`,
      );
    }
    return { home_domain: (entry as { home_domain: string }).home_domain };
  });
}

export async function fetchDirectory(url: string = DIRECTORY_URL): Promise<DirectoryAnchor[]> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`Expected an array from ${url}`);
  }
  return body.map((node: unknown, index: number) => {
    if (
      typeof node !== "object" ||
      node === null ||
      typeof (node as { home_domain?: unknown }).home_domain !== "string"
    ) {
      throw new Error(`Directory entry ${index} is missing a string home_domain`);
    }
    const record = node as {
      home_domain: string;
      countries?: unknown;
      currencies?: unknown;
      seps?: unknown;
    };
    return {
      home_domain: record.home_domain,
      countries: stringArray(record.countries),
      currencies: stringArray(record.currencies),
      seps: numberArray(record.seps),
    };
  });
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is number => typeof v === "number");
}

async function main(): Promise<void> {
  const directory = await fetchDirectory();
  const fleet = readFleet();
  const diff = computeDiff(directory, fleet);
  process.stdout.write(formatDiff(diff));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode(1);
  });
}
