import { describe, expect, it } from "vitest";
import { changelogSection } from "../scripts/changelog-section";
import { releaseProblems } from "../scripts/release-check";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- something pending

## [1.2.0] - 2026-10-01

### Added

- the new thing

### Fixed

- the old bug

## [1.1.0]

- earlier

## [0.1.0] - 2026-09-01

- first

[Unreleased]: https://example.test/compare/v1.2.0...HEAD
[1.2.0]: https://example.test/compare/v1.1.0...v1.2.0
`;

describe("changelogSection", () => {
  it("returns the body of a dated section, up to the next heading", () => {
    const s = changelogSection(CHANGELOG, "1.2.0");
    expect(s).toContain("### Added");
    expect(s).toContain("- the old bug");
    expect(s).not.toContain("earlier");
    expect(s).not.toContain("something pending");
  });

  it("accepts a leading v and an undated heading", () => {
    expect(changelogSection(CHANGELOG, "v1.1.0")).toBe("- earlier");
  });

  it("drops the trailing link-reference block from the last section it can reach", () => {
    expect(changelogSection(CHANGELOG, "0.1.0")).toBe("- first");
  });

  it("is undefined for a missing version, and does not match a prefix of one", () => {
    expect(changelogSection(CHANGELOG, "9.9.9")).toBeUndefined();
    expect(changelogSection(CHANGELOG, "1.2")).toBeUndefined();
    expect(changelogSection(CHANGELOG, "1.2.00")).toBeUndefined();
  });

  it("is undefined for a section with nothing under it", () => {
    expect(changelogSection("## [2.0.0] - 2026-11-01\n\n## [1.0.0]\n\n- x\n", "2.0.0")).toBe(
      undefined,
    );
  });

  it("does not treat dots in the version as wildcards", () => {
    expect(changelogSection("## [1x2x0]\n\n- x\n", "1.2.0")).toBeUndefined();
  });
});

describe("releaseProblems", () => {
  const built = {
    exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
  };
  const ok = [
    { name: "@corridor/a", version: "1.2.0", ...built },
    { name: "@corridor/b", version: "1.2.0", ...built },
  ];

  it("is empty when every public package matches the tag and has notes", () => {
    expect(releaseProblems("v1.2.0", ok, CHANGELOG)).toEqual([]);
  });

  it("refuses a public package whose version is not the tag's", () => {
    const problems = releaseProblems(
      "v1.2.0",
      [...ok, { name: "@corridor/c", version: "1.1.0", ...built }],
      CHANGELOG,
    );
    expect(problems).toEqual(["@corridor/c is at 1.1.0, tag is 1.2.0"]);
  });

  it("ignores a private package at any version", () => {
    expect(
      releaseProblems(
        "v1.2.0",
        [...ok, { name: "x", version: "0.0.1", private: true }],
        CHANGELOG,
      ),
    ).toEqual([]);
  });

  it("refuses when the CHANGELOG has no section for the version", () => {
    const problems = releaseProblems(
      "v1.3.0",
      ok.map((p) => ({ ...p, version: "1.3.0" })),
      CHANGELOG,
    );
    expect(problems).toEqual(['CHANGELOG.md has no non-empty "## [1.3.0]" section']);
  });

  it("refuses a package that still exports TypeScript source", () => {
    const problems = releaseProblems(
      "v1.2.0",
      [{ name: "@corridor/src", version: "1.2.0", exports: { ".": "./src/index.ts" } }],
      CHANGELOG,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("exports TypeScript source");
  });

  it("refuses a tag that is not vX.Y.Z, and a release with nothing to publish", () => {
    expect(releaseProblems("latest", ok, CHANGELOG)[0]).toContain("is not vX.Y.Z");
    expect(
      releaseProblems("v1.2.0", [{ name: "p", version: "1.2.0", private: true }], CHANGELOG),
    ).toContain("no public packages to publish");
  });
});
