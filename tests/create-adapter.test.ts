import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createAdapter, parseArgs, ADAPTER_ID_PATTERN } from "../scripts/create-adapter";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "create-adapter-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("create:adapter", () => {
  it("parses --id and --dir", () => {
    expect(parseArgs(["--id", "demo", "--dir", "/tmp/x"])).toEqual({
      id: "demo",
      dir: "/tmp/x",
    });
  });

  it("validates the id against the manifest slug rule", () => {
    expect(ADAPTER_ID_PATTERN.test("demo-1")).toBe(true);
    expect(ADAPTER_ID_PATTERN.test("Demo")).toBe(false);
    expect(ADAPTER_ID_PATTERN.test("a_b")).toBe(false);
    expect(ADAPTER_ID_PATTERN.test("")).toBe(false);
  });

  it("rejects an invalid id without creating anything", () => {
    const dir = join(root, "bad");
    expect(() => createAdapter({ id: "Bad Id", dir })).toThrow(/invalid adapter id/);
    expect(existsSync(dir)).toBe(false);
  });

  it("generates the package layout", () => {
    const dir = join(root, "demo");
    const result = createAdapter({ id: "demo", dir });
    expect(result.files.sort()).toEqual(
      ["README.md", "package.json", "src/adapter.test.ts", "src/index.ts"].sort(),
    );
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("@corridor/adapter-demo");
    const src = readFileSync(join(dir, "src/index.ts"), "utf8");
    expect(src).toContain("export class DemoAdapter implements AnchorAdapter");
    expect(src).toContain('protocol: "custom:demo"');
  });

  it("refuses to overwrite an existing directory", () => {
    const dir = join(root, "exists");
    mkdirSync(dir);
    expect(() => createAdapter({ id: "demo", dir })).toThrow(/refusing to overwrite/);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  });

  it("generated package type-checks", () => {
    const dir = join(root, "typed");
    createAdapter({ id: "demo", dir });
    const tsc = join(process.cwd(), "node_modules", ".bin", "tsc");
    const tsconfig = join(root, "tsconfig.json");
    const repoRoot = process.cwd();
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          baseUrl: repoRoot,
          paths: {
            "@corridor/adapter-kit": [join(repoRoot, "packages/adapter-kit/src/index.ts")],
            "@corridor/manifest": [join(repoRoot, "packages/manifest/src/index.ts")],
            "@corridor/types": [join(repoRoot, "packages/types/src/index.ts")],
          },
        },
        files: [join(dir, "src/index.ts")],
      }),
    );
    execFileSync(tsc, ["-p", tsconfig], { stdio: "pipe" });
  });
});

import { writeFileSync } from "node:fs";
