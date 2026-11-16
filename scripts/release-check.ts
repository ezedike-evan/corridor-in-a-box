// Pre-publish checks for a `vX.Y.Z` release, run by
// .github/workflows/release-packages.yml before anything is published.
//
//   pnpm exec tsx scripts/release-check.ts v1.2.3
//
// Refuses (exit 1, one problem per line) when:
//   - a public package's version is not the tag's version
//   - CHANGELOG.md has no section for that version
//   - a public package still exports TypeScript source (nothing to install from npm)
//
// Private packages are skipped: they are never published.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection } from "./changelog-section";

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly exports?: unknown;
}

const rootExport = (exports: unknown): string | undefined => {
  const root =
    typeof exports === "object" && exports !== null
      ? (exports as Record<string, unknown>)["."]
      : exports;
  if (typeof root === "string") return root;
  if (typeof root === "object" && root !== null) {
    const o = root as Record<string, unknown>;
    for (const k of ["import", "default", "types"]) if (typeof o[k] === "string") return o[k];
  }
  return undefined;
};

/** Everything wrong with publishing `packages` at `tag`; empty when it is safe to go. */
export function releaseProblems(
  tag: string,
  packages: readonly PackageManifest[],
  changelog: string,
): string[] {
  const version = tag.replace(/^v/, "");
  const problems: string[] = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    problems.push(`tag "${tag}" is not vX.Y.Z`);
  }
  const published = packages.filter((p) => !p.private);
  if (published.length === 0) problems.push("no public packages to publish");
  for (const p of published) {
    const name = p.name ?? "(unnamed package)";
    if (p.version !== version) {
      problems.push(`${name} is at ${p.version ?? "no version"}, tag is ${version}`);
    }
    const entry = rootExport(p.exports);
    if (entry !== undefined && /(^|\/)src\//.test(entry)) {
      problems.push(
        `${name} exports TypeScript source (${entry}); it needs a built dist first`,
      );
    }
  }
  if (changelogSection(changelog, version) === undefined) {
    problems.push(`CHANGELOG.md has no non-empty "## [${version}]" section`);
  }
  return problems;
}

export function loadPackages(repoRoot: string): PackageManifest[] {
  const dir = join(repoRoot, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => JSON.parse(readFileSync(join(dir, e.name, "package.json"), "utf8")));
}

function main(argv: readonly string[]): number {
  const tag = argv[0];
  if (!tag) {
    console.error("usage: release-check.ts vX.Y.Z");
    return 2;
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = releaseProblems(
    tag,
    loadPackages(root),
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  );
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length === 0) console.log(`release ${tag}: ok`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
