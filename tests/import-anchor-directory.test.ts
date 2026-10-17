import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffDomains,
  extractDomains,
  formatDiff,
} from "../examples/import-anchor-directory.js";

const FIXTURE_PATH = resolve(
  import.meta.dirname,
  "fixtures/anchor-directory.json",
);

async function loadFixture(): Promise<unknown> {
  const raw = await readFile(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as unknown;
}

describe("extractDomains", () => {
  it("extracts and normalizes home domains from the directory fixture", async () => {
    const feed = await loadFixture();
    const domains = extractDomains(feed);
    expect(domains).toContain({
      domain: "cowrie.exchange",
    });
    expect(domains).toContain({
      domain: "testanchor.stellar.org",
    });
    expect(domains).toContain({
      domain: "anchor.example.org",
    });
  });

  it("deduplicates and sorts domains", async () => {
    const feed = await loadFixture();
    const domains = extractDomains(feed);
    const sorted = [...domains].sort();
    expect(domains).toEqual(sorted);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("handles a bare array feed", () => {
    const domains = extractDomains([
      { domain: "A.example.org" },
      { home_domain: "b.example.org" },
    ]);
    expect(domains).toEqual(["a.example.org", "b.example.org"]);
  });

  it("strips scheme and path from domains", () => {
    const domains = extractDomains([
      { domain: "https://Cowrie.Exchange/sep10/info" },
    ]);
    expect(domains).toEqual(["cowrie.exchange"]);
  });

  it("returns an empty array for an empty feed", () => {
    expect(extractDomains({})).toEqual([]);
    expect(extractDomains([])).toEqual([]);
  });
});

describe("diffDomains", () => {
  it("reports added, removed, and unchanged", () => {
    const diff = diffDomains(
      ["cowrie.exchange", "new.anchor"],
      ["cowrie.exchange", "stellar.org"],
    );
    expect(diff.added).toEqual(["new.anchor"]);
    expect(diff.removed).toEqual(["stellar.org"]);
    expect(diff.unchanged).toEqual(["cowrie.exchange"]);
  });

  it("is case-insensitive", () => {
    const diff = diffDomains(["Cowrie.Exchange"], ["cowrie.exchange"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("reports an empty diff when both sides match", () => {
    const diff = diffDomains(["a.org", "b.org"], ["b.org", "a.org"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual(["a.org", "b.org"]);
  });
});

describe("formatDiff", () => {
  it("prints added and removed domains", () => {
    const out = formatDiff({
      added: ["new.anchor"],
      removed: ["stellar.org"],
      unchanged: ["cowrie.exchange"],
    });
    expect(out).toContain("+ new.anchor");
    expect(out).toContain("- stellar.org");
    expect(out).toContain("no files were written");
  });

  it("says none when there is nothing to add or remove", () => {
    const out = formatDiff({
      added: [],
      removed: [],
      unchanged: ["cowrie.exchange"],
    });
    expect(out).toContain("+ (added): none");
    expect(out).toContain("- (removed): none");
  });
});
