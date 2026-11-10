import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES_DIR = fileURLToPath(new URL("../packages/", import.meta.url));
const REPO_URL = "git+https://github.com/ezedike-evan/corridor-in-a-box.git";

type PackageJson = Record<string, unknown>;

/** Names of the problems with one package.json; empty when it is publishable metadata-wise. */
export function metadataProblems(dir: string, pkg: PackageJson): string[] {
  const problems: string[] = [];
  const text = (k: string) => typeof pkg[k] === "string" && (pkg[k] as string).trim() !== "";
  for (const k of ["name", "description", "homepage"])
    if (!text(k)) problems.push(`${k} missing`);
  if (pkg.license !== "Apache-2.0") problems.push("license must be Apache-2.0");
  const repo = pkg.repository as
    { type?: string; url?: string; directory?: string } | undefined;
  if (repo?.url !== REPO_URL) problems.push("repository.url missing or wrong");
  if (repo?.directory !== `packages/${dir}`)
    problems.push(`repository.directory must be packages/${dir}`);
  // Published as built output: exports point at dist (with types), only dist ships, and
  // the package can build itself. `source` keeps in-repo tooling on the TypeScript.
  const exportsMap = pkg.exports as Record<string, Record<string, string>> | undefined;
  for (const [subpath, conditions] of Object.entries(exportsMap ?? {})) {
    for (const condition of ["types", "import"]) {
      if (!conditions?.[condition]?.startsWith("./dist/")) {
        problems.push(`exports["${subpath}"].${condition} must point into ./dist/`);
      }
    }
  }
  if (!exportsMap || Object.keys(exportsMap).length === 0) problems.push("exports missing");
  if (!Array.isArray(pkg.files) || !pkg.files.includes("dist"))
    problems.push('files must include "dist"');
  if ((pkg.scripts as Record<string, string> | undefined)?.build === undefined) {
    problems.push("build script missing");
  }
  const bugs = pkg.bugs as { url?: string } | undefined;
  if (!bugs?.url) problems.push("bugs.url missing");
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0)
    problems.push("keywords missing");
  return problems;
}

const packages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe("package metadata", () => {
  it("finds the workspace packages", () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  it.each(packages)("@corridor/%s carries the required fields", (dir) => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGES_DIR, dir, "package.json"), "utf8"),
    ) as PackageJson;
    expect(pkg.name).toBe(`@corridor/${dir}`);
    expect(metadataProblems(dir, pkg)).toEqual([]);
  });

  it("fails when a required field is removed", () => {
    const full: PackageJson = {
      name: "@corridor/x",
      description: "d",
      license: "Apache-2.0",
      repository: { type: "git", url: REPO_URL, directory: "packages/x" },
      bugs: { url: "https://example.test/issues" },
      homepage: "https://example.test",
      keywords: ["k"],
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          source: "./src/index.ts",
          import: "./dist/index.js",
        },
      },
      files: ["dist"],
      scripts: { build: "tsup" },
    };
    expect(metadataProblems("x", full)).toEqual([]);
    for (const field of Object.keys(full)) {
      const { [field]: _removed, ...rest } = full;
      expect(metadataProblems("x", rest), `without ${field}`).not.toEqual([]);
    }
  });
});
