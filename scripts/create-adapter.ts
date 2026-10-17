#!/usr/bin/env tsx
/**
 * Scaffold a custom AnchorAdapter package.
 *
 * Usage:
 *   pnpm create:adapter --id demo [--dir packages/adapter-demo]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ID_PATTERN = /^[a-z0-9-]+$/;

export interface CreateAdapterOptions {
  id: string;
  dir?: string;
  root?: string;
}

export interface CreateAdapterResult {
  id: string;
  dir: string;
  files: string[];
}

export class AdapterGenerationError extends Error {}

function toPackageName(id: string): string {
  return `interstellar-adapter-${id}`;
}

function toClassName(id: string): string {
  const parts = id.split(/[-_]+/).filter(Boolean);
  return `${parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("")}Adapter`;
}

function packageJson(id: string): string {
  const name = toPackageName(id);
  return `${JSON.stringify(
    {
      name,
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      scripts: {
        build: "tsc -p tsconfig.build.json",
        test: "vitest run",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        "@interstellar/adapter-kit": "workspace:*",
      },
      devDependencies: {
        typescript: "catalog:",
        vitest: "catalog:",
      },
    },
    null,
    2,
  )}\n`;
}

function tsconfigJson(): string {
  return `${JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        outDir: "./dist",
        rootDir: "./src",
        composite: false,
      },
      include: ["src/**/*.ts", "tests/**/*.ts"],
      exclude: ["dist", "node_modules"],
    },
    null,
    2,
  )}\n`;
}

function tsconfigBuildJson(): string {
  return `${JSON.stringify(
    {
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: false,
        declaration: true,
        declarationMap: true,
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  )}\n`;
}

function indexTs(id: string): string {
  const className = toClassName(id);
  return `import type {
  AnchorAdapter,
  AdapterCapabilities,
  AdapterContext,
  AdapterResult,
  AnchorTransferRequest,
  AnchorReceiveRequest,
} from "@interstellar/adapter-kit";
import { fail } from "@interstellar/adapter-kit";

export class ${className} implements AnchorAdapter {
  readonly id = "custom:${id}";

  capabilities(): AdapterCapabilities {
    return {
      transfer: false,
      receive: false,
    };
  }

  async transfer(
    _ctx: AdapterContext,
    _req: AnchorTransferRequest,
  ): Promise<AdapterResult> {
    return fail(this.id, "transfer", "not implemented");
  }

  async receive(
    _ctx: AdapterContext,
    _req: AnchorReceiveRequest,
  ): Promise<AdapterResult> {
    return fail(this.id, "receive", "not implemented");
  }
}

export default ${className};
`;
}

function testTs(id: string): string {
  const className = toClassName(id);
  return `import { describe, it } from "vitest";
import { runConformance } from "@interstellar/adapter-kit/testing";
import ${className} from "../src/index.js";

describe("${className}", () => {
  it("satisfies the conformance harness", async () => {
    await runConformance(new ${className}());
  });
});
`;
}

function readme(id: string): string {
  const name = toPackageName(id);
  return `# ${name}

Custom AnchorAdapter for "interstellar" (id: \`custom:${id}\`).

This package was scaffolded with \`--id ${id}\`.

## Checklist

- [ ] Implement \`capabilities()\` to reflect the features this adapter supports.
- [ ] Implement \`transfer()\` and/or \`receive()\` with real logic.
- [ ] Replace the \`not implemented\` failures with success/error results.
- [ ] Keep the conformance test in \`tests/index.test.ts\` passing.
- [ ] Register the adapter in the host configuration under \`custom:${id}\`.

## Scripts

- \`pnpm build\`
- \`pnpm test\`
- \`pnpm typecheck\`
`;
}

export function createAdapter(options: CreateAdapterOptions): CreateAdapterResult {
  const { id } = options;
  if (!ID_PATTERN.test(id)) {
    throw new AdapterGenerationError(
      `Invalid adapter id "${id}": must match ${ID_PATTERN.source}`,
    );
  }

  const root = resolve(options.root ?? process.cwd());
  const targetDir = options.dir
    ? resolve(root, options.dir)
    : join(root, "packages", `adapter-${id}`);

  if (existsSync(targetDir)) {
    throw new AdapterGenerationError(
      `Refusing to overwrite existing directory: ${targetDir}`,
    );
  }

  const files: Record<string, string> = {
    "package.json": packageJson(id),
    "tsconfig.json": tsconfigJson(),
    "tsconfig.build.json": tsconfigBuildJson(),
    "src/index.ts": indexTs(id),
    "tests/index.test.ts": testTs(id),
    "README.md": readme(id),
  };

  mkdirSync(targetDir, { recursive: true });
  const written: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(targetDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    written.push(fullPath);
  }

  return { id, dir: targetDir, files: written };
}

function parseArgs(argv: string[]): CreateAdapterOptions {
  const options: Partial<CreateAdapterOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") {
      options.id = argv[++i];
    } else if (arg.startsWith("--id=")) {
      options.id = arg.slice("--id=".length);
    } else if (arg === "--dir") {
      options.dir = argv[++i];
    } else if (arg.startsWith("--dir=")) {
      options.dir = arg.slice("--dir".length + 1);
    } else {
      throw new AdapterGenerationError(`Unknown argument: ${arg}`);
    }
  }
  if (!options.id) {
    throw new AdapterGenerationError(
      "Missing required --id <slug> argument",
    );
  }
  return options as CreateAdapterOptions;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const result = createAdapter(parseArgs(process.argv.slice(2)));
    console.log(`Created adapter "${result.id}" at ${result.dir}`);
    for (const file of result.files) {
      console.log(`  ${file}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
