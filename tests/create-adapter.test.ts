import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runConformance } from "@corridor/adapter-kit";
import { ADAPTER_ID_PATTERN, createAdapter, parseArgs } from "../scripts/create-adapter";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "create-adapter-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("create:adapter", () => {
  it("parses --id and --dir, in both spellings", () => {
    expect(parseArgs(["--id", "demo", "--dir", "/tmp/x"])).toEqual({
      id: "demo",
      dir: "/tmp/x",
    });
    expect(parseArgs(["--id=demo"])).toEqual({ id: "demo" });
    expect(parseArgs([])).toEqual({});
  });

  it("rejects unknown flags and flags with no value", () => {
    expect(() => parseArgs(["--nope", "x"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--id"])).toThrow(/--id needs a value/);
    expect(() => parseArgs(["--id", "--dir", "x"])).toThrow(/--id needs a value/);
  });

  it("validates the id against the manifest slug rule", () => {
    expect(ADAPTER_ID_PATTERN.test("demo-1")).toBe(true);
    for (const bad of ["Demo", "a_b", "a b", "a/b", "../x", ""]) {
      expect(ADAPTER_ID_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it("rejects an invalid id without creating anything", () => {
    for (const id of ["Bad Id", "../escape", "", "---"]) {
      const dir = join(root, `bad-${id.length}`);
      expect(() => createAdapter({ id, dir })).toThrow(/invalid adapter id/);
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("generates the package layout", () => {
    const dir = join(root, "demo");
    const result = createAdapter({ id: "demo-bank", dir });
    expect(result.dir).toBe(dir);
    expect([...result.files].sort()).toEqual(
      [
        "README.md",
        "package.json",
        "src/adapter.test.ts",
        "src/fixture.ts",
        "src/index.ts",
      ].sort(),
    );
    for (const f of result.files) expect(existsSync(join(dir, f)), f).toBe(true);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("@corridor/adapter-demo-bank");
    expect(pkg.license).toBe("Apache-2.0");
    const src = readFileSync(join(dir, "src/index.ts"), "utf8");
    expect(src).toContain("export class DemoBankAdapter implements AnchorAdapter");
    expect(src).toContain('protocol: "custom:demo-bank"');
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("## Checklist");
  });

  it("defaults to packages/adapter-<id> under the repo root", () => {
    const result = createAdapter({ id: "demo", repoRoot: root });
    expect(result.dir).toBe(join(root, "packages", "adapter-demo"));
    const pkg = JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8"));
    expect(pkg.repository.directory).toBe("packages/adapter-demo");
  });

  it("refuses to overwrite an existing directory", () => {
    const dir = join(root, "exists");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep.txt"), "mine");
    expect(() => createAdapter({ id: "demo", dir })).toThrow(/refusing to overwrite/);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
  });

  it("generated adapter loads against a valid fixture and declares well-formed capabilities", async () => {
    const dir = join(root, "runs");
    createAdapter({ id: "demo-bank", dir });
    // The fixture throws if its corridor does not parse, which a type-check cannot see.
    const { corridor, intent } = await import(join(dir, "src/fixture.ts"));
    const { DemoBankAdapter } = await import(join(dir, "src/index.ts"));
    const report = await runConformance(new DemoBankAdapter(), { intent, corridor });
    const caps = report.results.find((r) => r.name === "capabilities well-formed");
    expect(caps?.passed, caps?.detail).toBe(true);
    const quote = await new DemoBankAdapter().requestQuote(intent, corridor);
    expect(quote.ok).toBe(false);
  });

  it("generated package type-checks, tests included", () => {
    const dir = join(root, "typed");
    createAdapter({ id: "demo", dir });
    const nodeModules = join(REPO_ROOT, "node_modules");
    const src = (p: string) => [join(REPO_ROOT, "packages", p, "src/index.ts")];
    const tsconfig = join(root, "tsconfig.json");
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          typeRoots: [join(nodeModules, "@types")],
          types: ["node"],
          paths: {
            "@corridor/adapter-kit": src("adapter-kit"),
            "@corridor/manifest": src("manifest"),
            "@corridor/probe": src("probe"),
            "@corridor/types": src("types"),
            vitest: [join(nodeModules, "vitest")],
          },
        },
        files: [
          join(dir, "src/index.ts"),
          join(dir, "src/fixture.ts"),
          join(dir, "src/adapter.test.ts"),
        ],
      }),
    );
    const tsc = join(nodeModules, ".bin", "tsc");
    expect(() => execFileSync(tsc, ["-p", tsconfig], { stdio: "pipe" })).not.toThrow();
  }, 120_000);
});