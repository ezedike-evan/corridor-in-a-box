import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Every remote `uses:` reference in a workflow, with its file and line. */
export function usesReferences(file: string, text: string) {
  const refs: { file: string; line: number; ref: string }[] = [];
  text.split("\n").forEach((raw, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*([^\s#]+)/.exec(raw);
    if (!m) return;
    const ref = m[1]!.replace(/^["']|["']$/g, "");
    // Local actions (./) and docker:// images are not resolved through a git ref.
    if (ref.startsWith("./") || ref.startsWith("docker://")) return;
    refs.push({ file, line: i + 1, ref });
  });
  return refs;
}

export function unpinned(refs: ReturnType<typeof usesReferences>) {
  return refs.filter(({ ref }) => !FULL_SHA.test(ref.split("@")[1] ?? ""));
}

describe("workflow action pins", () => {
  it("pins every `uses:` in .github/workflows to a full 40-char commit SHA", () => {
    const refs = readdirSync(WORKFLOWS_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) => usesReferences(f, readFileSync(join(WORKFLOWS_DIR, f), "utf8")));
    expect(refs.length).toBeGreaterThan(0);
    expect(unpinned(refs).map((r) => `${r.file}:${r.line} ${r.ref}`)).toEqual([]);
  });

  it("flags tags, branches and missing refs, and ignores local and docker uses", () => {
    const sha = "a".repeat(40);
    const text = [
      "      - uses: owner/repo@v2",
      "      - uses: owner/repo@stable",
      "      - uses: owner/repo",
      `      - uses: owner/repo@${sha} # v2.0.0`,
      "      - uses: ./local-action",
      "      - uses: docker://alpine:3",
    ].join("\n");
    expect(unpinned(usesReferences("x.yml", text)).map((r) => r.line)).toEqual([1, 2, 3]);
  });
});
