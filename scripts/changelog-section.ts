// Extracts one version's section from CHANGELOG.md, for the GitHub Release body.
//
//   pnpm exec tsx scripts/changelog-section.ts 1.2.3 [CHANGELOG.md]
//
// Prints the text under `## [1.2.3]` (a leading `v` on the version is ignored,
// and a ` - date` after the heading is fine) up to the next `## [` heading.
// Exits 1, printing nothing to stdout, when the section is missing or empty, so
// a release cannot go out with no notes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The body of `## [version]` in `changelog`, trimmed; undefined when absent or empty. */
export function changelogSection(changelog: string, version: string): string | undefined {
  const v = version.replace(/^v/, "");
  const heading = new RegExp(`^## \\[${escapeRegExp(v)}\\](?:[^\\S\\n].*)?$`, "m");
  const start = heading.exec(changelog);
  if (!start) return undefined;
  const rest = changelog.slice(start.index + start[0].length);
  const next = /^## \[/m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest)
    // The trailing link-reference block ("[1.2.3]: https://...") is not release notes.
    .replace(/\n\[[^\]]+\]: \S+[\s\S]*$/, "\n")
    .trim();
  return body === "" ? undefined : body;
}

function main(argv: readonly string[]): number {
  const [version, file = "CHANGELOG.md"] = argv;
  if (!version) {
    console.error("usage: changelog-section.ts <version> [CHANGELOG.md]");
    return 2;
  }
  const section = changelogSection(readFileSync(file, "utf8"), version);
  if (section === undefined) {
    console.error(`CHANGELOG.md has no non-empty "## [${version.replace(/^v/, "")}]" section`);
    return 1;
  }
  process.stdout.write(section + "\n");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
