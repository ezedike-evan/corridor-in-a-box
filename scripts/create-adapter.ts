// Scaffolds a new custom AnchorAdapter package.
//
//   pnpm create:adapter --id <slug> [--dir <path>]
//
// The package lands in packages/adapter-<slug> unless --dir says otherwise. Every
// verb returns a "not implemented" failure, so the scaffold compiles and the
// engine fails closed on it until you fill the verbs in. The id becomes the
// manifest's `dest.protocol: custom:<slug>`, so it must match that rule.
//
// Refuses to overwrite an existing directory.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The same slug rule as the manifest's `custom:<id>` protocol. */
export const ADAPTER_ID_PATTERN = /^[a-z0-9-]+$/;

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_URL = "git+https://github.com/ezedike-evan/corridor-in-a-box.git";

export interface CreateAdapterArgs {
  id?: string;
  dir?: string;
}

export function parseArgs(argv: readonly string[]): CreateAdapterArgs {
  const args: CreateAdapterArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flag !== "--id" && flag !== "--dir") throw new Error(`unknown argument: ${argv[i]}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    args[flag === "--id" ? "id" : "dir"] = value;
  }
  return args;
}

/** `my-bank-2` -> `MyBank2`. Null when the id has no alphanumeric part to name a class from. */
function pascalCase(id: string): string | null {
  const parts = id.split("-").filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
}

export interface CreateAdapterOptions {
  id: string;
  /** Where to write the package. Default `packages/adapter-<id>` under `repoRoot`. */
  dir?: string;
  repoRoot?: string;
}

export interface CreateAdapterResult {
  dir: string;
  /** Paths written, relative to `dir`. */
  files: string[];
}

export function createAdapter(opts: CreateAdapterOptions): CreateAdapterResult {
  const { id } = opts;
  const className = ADAPTER_ID_PATTERN.test(id) ? pascalCase(id) : null;
  if (!className) {
    throw new Error(
      `invalid adapter id "${id}": use lowercase letters, digits and hyphens (${ADAPTER_ID_PATTERN})`,
    );
  }
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const dir = resolve(opts.dir ?? join(repoRoot, "packages", `adapter-${id}`));
  if (existsSync(dir)) throw new Error(`refusing to overwrite existing path: ${dir}`);

  const inRepo = relative(repoRoot, dir);
  const directory =
    inRepo && !inRepo.startsWith("..") && !isAbsolute(inRepo) ? inRepo : undefined;

  const pkg = {
    name: `@corridor/adapter-${id}`,
    version: "0.1.0",
    description: `AnchorAdapter for the custom:${id} anchor.`,
    license: "Apache-2.0",
    repository: {
      type: "git",
      url: REPO_URL,
      ...(directory && { directory: directory.split("\\").join("/") }),
    },
    bugs: { url: "https://github.com/ezedike-evan/corridor-in-a-box/issues" },
    homepage: "https://github.com/ezedike-evan/corridor-in-a-box#readme",
    keywords: ["stellar", "corridor", "adapter", `custom:${id}`],
    type: "module",
    engines: { node: ">=22" },
    exports: { ".": "./src/index.ts" },
    main: "./src/index.ts",
    dependencies: {
      "@corridor/adapter-kit": "workspace:*",
      "@corridor/manifest": "workspace:*",
      "@corridor/types": "workspace:*",
    },
  };

  const files: Record<string, string> = {
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    "src/index.ts": indexTemplate(id, className),
    "src/fixture.ts": fixtureTemplate(id),
    "src/adapter.test.ts": testTemplate(id, className),
    "README.md": readmeTemplate(id, className),
  };

  for (const [rel, contents] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return { dir, files: Object.keys(files) };
}

function indexTemplate(id: string, className: string): string {
  return `// AnchorAdapter for the custom:${id} anchor.
//
// Every verb below returns a "not implemented" failure, so the engine fails
// closed on this adapter until you implement it. Fill the verbs in one at a
// time and keep README.md's checklist current. The rules every adapter must
// follow (never throw, always return an Outcome, no PII in messages, never
// treat a malformed response as success) are in docs/adapters.md.

import type {
  AdapterCapabilities,
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  RefundRef,
  TransactionStatus,
} from "@corridor/adapter-kit";
import type { Corridor } from "@corridor/manifest";
import { fail, type Money, type Outcome, type PaymentIntent } from "@corridor/types";

export class ${className}Adapter implements AnchorAdapter {
  readonly name = "${id}";

  capabilities(): AdapterCapabilities {
    return {
      protocol: "custom:${id}",
      quotes: ["native"],
      kyc: "bespoke",
      settlement: ["stellar_payment"],
      refunds: "none",
      callbacks: false,
    };
  }

  async requestQuote(_intent: PaymentIntent, _corridor: Corridor): Promise<Outcome<Quote>> {
    return fail("ANCHOR_UNAVAILABLE", \`\${this.name}: requestQuote not implemented\`);
  }

  async ensureCompliance(
    _intent: PaymentIntent,
    _corridor: Corridor,
  ): Promise<Outcome<KycResult>> {
    return fail("ANCHOR_UNAVAILABLE", \`\${this.name}: ensureCompliance not implemented\`);
  }

  async openTransaction(
    _intent: PaymentIntent,
    _quote: Quote,
    _corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    return fail("ANCHOR_UNAVAILABLE", \`\${this.name}: openTransaction not implemented\`);
  }

  async getTransaction(_transactionId: string): Promise<Outcome<TransactionStatus>> {
    return fail("ANCHOR_UNAVAILABLE", \`\${this.name}: getTransaction not implemented\`);
  }

  async requestRefund(
    _transactionId: string,
    _amount: Money,
    _reason: string,
  ): Promise<Outcome<RefundRef>> {
    return fail("REFUND_UNSUPPORTED", \`\${this.name}: refunds are not supported\`);
  }
}
`;
}

function fixtureTemplate(id: string): string {
  return `import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";

const parsed = parseCorridor({
  id: "${id}-test",
  source: { name: "Source", asset: "USDC", endpoints: { home_domain: "source.example" } },
  dest: {
    name: "${id}",
    asset: "iso4217:XTS",
    protocol: "custom:${id}",
    endpoints: { home_domain: "${id}.example", base_url: "https://${id}.example" },
  },
  fx: {
    path: ["XTS", "USDC", "XTS"],
    quote_source: "native",
    who_holds_risk: "receiving_anchor",
    quote_ttl_seconds: 60,
  },
  compliance: {
    source_jurisdiction: "US",
    dest_jurisdiction: "US",
    travel_rule_profile: "default",
  },
  settlement: {
    bridge_asset: "USDC",
    network: "testnet",
    asset_issuer: "GEXAMPLESTUBISSUERACCOUNT2222222222222222222222222222222",
  },
  recovery: { max_retries: 3, timeout_seconds: 900, rollback: "refund_sender" },
});
if (!parsed.ok) throw new Error(\`fixture corridor invalid: \${parsed.error.message}\`);

/** A throwaway corridor for ${id}, valid against the manifest schema. */
export const corridor: Corridor = parsed.value;

export const intent: PaymentIntent = {
  idempotencyKey: "conformance-1",
  corridorId: "${id}-test",
  sender: { id: "sender" },
  recipient: { id: "recipient" },
  sourceAmount: { asset: "USDC", amount: "100" },
};
`;
}

function testTemplate(id: string, className: string): string {
  return `import { describe, expect, it } from "vitest";
import { runConformance } from "@corridor/adapter-kit";
import { ${className}Adapter } from "./index";
import { corridor, intent } from "./fixture";

describe("${className}Adapter", () => {
  it("declares well-formed capabilities", async () => {
    const report = await runConformance(new ${className}Adapter(), {
      intent,
      corridor,
    });
    const caps = report.results.find((r) => r.name === "capabilities well-formed");
    expect(caps?.passed, caps?.detail).toBe(true);
  });

  // The scaffold's verbs are stubs, so the full harness cannot pass yet. Turn
  // this into a real test (see expectConformance in the repo's tests/helpers)
  // once requestQuote, ensureCompliance, openTransaction and getTransaction are
  // implemented.
  it.todo("passes the full conformance harness");
});
`;
}

function readmeTemplate(id: string, className: string): string {
  return `# @corridor/adapter-${id}

\`AnchorAdapter\` for the \`custom:${id}\` anchor, scaffolded by \`pnpm create:adapter\`.
Every verb in \`src/index.ts\` currently returns a "not implemented" failure.

## Checklist

- [ ] \`capabilities()\` describes what this anchor really supports
- [ ] \`requestQuote\` returns a quote with a future \`expiresAt\`
- [ ] \`ensureCompliance\` maps the anchor's KYC states to \`accepted | pending | rejected\`
- [ ] \`openTransaction\` returns deposit instructions whose \`kind\` is in \`capabilities().settlement\`
- [ ] \`getTransaction\` maps every anchor status, including unknown ones, and flags terminal failures
- [ ] \`requestRefund\` is implemented, or stays \`REFUND_UNSUPPORTED\` and \`capabilities().refunds\` is \`"none"\`
- [ ] No verb throws; every failure is an \`Outcome\` with the right \`retryable\`
- [ ] No PII in any error message
- [ ] The \`it.todo\` in \`src/adapter.test.ts\` is replaced by a passing conformance test
- [ ] A manifest with \`dest.protocol: custom:${id}\` and \`dest.endpoints.base_url\` exists in \`corridors/\`
- [ ] \`${className}Adapter\` is wired where your service builds its adapters

See \`docs/adapters.md\` for the contract and \`examples/adapters/http-stub\` for a worked example.
`;
}

function main(argv: readonly string[]): number {
  try {
    const { id, dir } = parseArgs(argv);
    if (!id) throw new Error("--id <slug> is required");
    const result = createAdapter({ id, ...(dir !== undefined && { dir }) });
    console.log(`created ${result.dir}`);
    for (const f of result.files) console.log(`  ${f}`);
    console.log("\nNext: pnpm install, then implement the verbs in src/index.ts.");
    return 0;
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
