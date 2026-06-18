// Docs content registry. Markdown lives here as strings so the docs site is
// self-contained (no fs / loader config). Mirrors the repo's docs/ + README.

export interface Doc {
  slug: string;
  title: string;
  description: string;
  body: string;
}

export const docs: Doc[] = [
  {
    slug: "overview",
    title: "Overview",
    description: "What corridor-in-a-box is and the core idea.",
    body: `# Overview

**corridor-in-a-box** is an open, manifest-driven engine for Stellar **SEP-31**
cross-border corridors. A corridor is _configuration, not code_: the engine runs
\`quote → comply → settle → reconcile → recover\` over any standards-compliant
anchor pair, and adding a new corridor is a new \`*.corridor.yaml\` file — not a fork.

> No smart contract required. SEP-31 is off-chain orchestration of a single
> **native** Stellar payment (the settle leg).

## The three boundaries

1. **engine ↔ manifest** — the engine contains no corridor-specific strings.
   Corridor #2 is a YAML file, not a code change.
2. **engine ↔ adapters** — the engine knows only the \`AnchorAdapter\` interface;
   every standards-compliant anchor shares one adapter.
3. **router seam** — the open repo ships a \`RouteResolver\` interface plus a
   trivial default. The health-/rate-weighted resolver is proprietary and
   injected at runtime. That single seam is the entire open-core line.
`,
  },
  {
    slug: "getting-started",
    title: "Getting started",
    description: "Install, typecheck, test, and run a payment end-to-end.",
    body: `# Getting started

\`\`\`bash
corepack enable && pnpm install
pnpm lint        # eslint + prettier
pnpm typecheck   # whole monorepo, one tsc pass
pnpm test        # vitest: engine, manifest, money, sep31, stellar, service
pnpm example     # run a payment end-to-end (mocked anchor + settle)
pnpm cli plan corridors/reference.corridor.yaml   # offline liveness check
\`\`\`

\`pnpm example\` walks a payment through every state and proves idempotency:

\`\`\`
created -> quoted -> compliant -> opened -> settling -> settled -> reconciled -> completed
replay with same key -> idempotent return (state=completed)
\`\`\`

## This web app

\`\`\`bash
cd web
pnpm install
pnpm dev   # http://localhost:3000
\`\`\`

The **Run a payment** page drives a faithful simulation of the engine. Set
\`CORRIDOR_SERVICE_URL\` to point it at a real \`@corridor/service\` instance.
`,
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "The packages and how a payment flows through them.",
    body: `# Architecture

\`\`\`
packages/
  types/         Outcome<T> result type + decimal-safe Money
  manifest/      Zod schema for a corridor + loader
  adapter-kit/   AnchorAdapter port + conformance probes + mock adapter
  sep31/         ONE generic adapter (SEP-10 auth + SEP-12 KYC)
  stellar/       the ONLY chain-touching package: settlement submitter + SEP-10 signer
  router/        RouteResolver seam — open interface + static default
  engine/        orchestration: state machine, crash-resume, recovery, audit, metrics
  service/       thin HTTP API over the engine (auth + rate limiting)
  cli/           validate a manifest; print an offline runnability plan
\`\`\`

## The five verbs

| Step | Verb | Standard |
|---|---|---|
| 1 | quote | SEP-38 \`POST /quote\` |
| 2 | comply | SEP-10 auth + SEP-12 KYC handoff |
| 3 | open | SEP-31 \`POST /transactions\` |
| 4 | settle | native Stellar payment of the bridge asset |
| 5 | reconcile | SEP-31 \`GET /transactions/:id\` |

A persisted state machine drives \`created → quoted → compliant → opened →
settling → settled → reconciled → completed\`, with \`recovering → refunded / held\`
for failures. Every transition is logged, audited, and counted.
`,
  },
  {
    slug: "http-api",
    title: "HTTP API",
    description: "The @corridor/service endpoints.",
    body: `# HTTP API

\`@corridor/service\` turns the engine library into a service (zero runtime deps,
Node \`http\`).

## \`POST /payments\`

Body is a \`PaymentIntent\`:

\`\`\`json
{
  "idempotencyKey": "demo-0001",
  "corridorId": "mx-bitso",
  "sender": { "id": "sender-1" },
  "recipient": { "id": "recipient-1" },
  "sourceAmount": { "asset": "USDC", "amount": "100.00" }
}
\`\`\`

Status mapping: \`200\` completed · \`409\` idempotency conflict / quote issues ·
\`403\` KYC rejected · \`422\` invalid amount · \`502/504\` anchor/settlement ·
\`401\` missing API key · \`429\` rate limited.

## Other endpoints

- \`GET /payments/:key\` — current run state.
- \`GET /healthz\` — liveness (public, unmetered).

Optional bearer **API-key** auth and an in-memory **token-bucket** rate limiter
are configured on the service context.
`,
  },
  {
    slug: "key-management",
    title: "Key management",
    description: "Keeping the signing key out of the application process.",
    body: `# Signing-key management

The distribution account's seed is the most sensitive thing in a deployment.
All key access is isolated behind one port so the seed never has to live in the
application process.

\`\`\`ts
interface ExternalSigner {
  readonly publicKey: string; // G…
  sign(data: Uint8Array): Promise<Uint8Array>; // ed25519 over the tx hash
}
\`\`\`

| Environment | Signer | Where the seed lives |
|---|---|---|
| Local / testnet | \`LocalKeypairSigner\` | In process — throwaway testnet keys only |
| **Production** | A KMS/HSM-backed \`ExternalSigner\` | In the vault; never in the app |

A KMS/HSM that supports ed25519 implements \`ExternalSigner\` by delegating
\`sign\` to the vault, so the application only ever sees the public key and a
finished signature. Rotate keys on a schedule; because callers depend on the
port, rotation is a config change, not a code change.
`,
  },
  {
    slug: "why-not-anchor-platform",
    title: "Why not Anchor Platform?",
    description: "How this relates to the SDF Anchor Platform.",
    body: `# Why not just use the Anchor Platform?

The Anchor Platform is the **server an anchor runs** to _expose_ SEP endpoints.
\`corridor-in-a-box\` is the **orchestrator an operator runs** to _drive a payment
across two anchors_ and move the on-chain bridge asset between them. They are
complementary — in a real lane the receiving anchor runs the Anchor Platform and
this engine talks to it.

| | Anchor Platform | corridor-in-a-box |
|---|---|---|
| Who runs it | An anchor | A remittance operator / PSP |
| Role | Serve SEP endpoints | Orchestrate a payment end-to-end |
| Owns the settle leg | No | Yes (native Stellar payment) |
| Multi-anchor routing | No | Yes (RouteResolver seam) |
| Idempotency / recovery | N/A | Core |
`,
  },
];

export function getDoc(slug: string): Doc | undefined {
  return docs.find((d) => d.slug === slug);
}
