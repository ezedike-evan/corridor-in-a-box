# corridor-in-a-box

An open, **manifest-driven engine for Stellar SEP-31 cross-border corridors**. A
corridor is _configuration, not code_: the engine runs `quote → comply → settle →
reconcile → recover` over any standards-compliant anchor pair, and adding a new
corridor is a new `*.corridor.yaml` file — not a fork.

This repo is the **open half** of an open-core system. The proprietary half — the
anchor health/conformance dataset and the route intelligence built on it — lives
in a separate private repo and is injected at runtime through one interface
(`RouteResolver`). The open/closed boundary is a **repo boundary, not a folder
boundary**: everything here is publishable as-is.

> No smart contract required. SEP-31 is off-chain orchestration of a single
> **native** Stellar payment (the settle leg). Soroban only ever enters as an
> optional, separate on-chain oracle for publishing corridor data — never as part
> of moving money.

## Quickstart

```bash
corepack enable && pnpm install
pnpm lint               # eslint + prettier
pnpm typecheck          # whole monorepo, one tsc pass
pnpm test               # vitest: engine, manifest, money, sep31, stellar, …
pnpm example            # run a payment end-to-end (mocked anchor + settle)
pnpm cli plan corridors/reference.corridor.yaml   # offline pre-flight / liveness check
```

See [CONTRIBUTING](./CONTRIBUTING.md), [SECURITY](./SECURITY.md), and the
[ROADMAP](./ROADMAP.md) for how to get involved and where this is headed.

`pnpm example` walks a payment through every state and proves idempotency:

```
created -> quoted -> compliant -> opened -> settling -> settled -> reconciled -> completed
replay with same key -> idempotent return (state=completed)
```

## Architecture

```
packages/
  types/         Outcome<T> result type (no-throw) + Money/PaymentIntent
  manifest/      Zod schema for a corridor + loader  ← the abstraction lives here
  adapter-kit/   AnchorAdapter port + conformance probes + a mock adapter
  sep31/         ONE generic adapter for any standards-compliant SEP-31 anchor
                 (SEP-10 auth + SEP-12 KYC; crypto behind an injected signer)
  stellar/       the ONLY chain-touching package: @stellar/stellar-sdk-backed
                 settlement submitter + SEP-10 signer
  router/        RouteResolver seam — open interface + dumb static default
  engine/        corridor-agnostic orchestration of the five verbs, with a
                 persisted state machine, crash-resume, recovery, audit trail,
                 metrics hooks, and a durable Postgres idempotency store
  service/       thin HTTP API over the engine (auth + rate limiting), zero deps
  cli/           validate a manifest; print an offline runnability plan
corridors/       the manifests — ALL corridor-specifics live here, nowhere else
docs/            key management, "why not Anchor Platform", …
examples/        runnable end-to-end demo
```

Three boundaries do the work:

1. **engine ↔ manifest** — `engine/` contains no string `"NGN"` or `"Cowrie"`.
   Corridor-specifics enter only through a validated manifest. Corridor #2 is a
   YAML file, not a code change.
2. **engine ↔ adapters** — the engine knows only the `AnchorAdapter` interface.
   Standards-compliant anchors share one adapter; bespoke exchange/OTC desks
   implement the same interface and live in the private repo.
3. **router seam** — the open repo ships the `RouteResolver` interface plus a
   trivial "use the declared anchor" default. The real health-/rate-weighted
   resolver is proprietary and injected at runtime. **That single seam is the
   entire open-core line.**

## Corridor sequencing

Picking the destination is the binding constraint, not the code. SEP-31 needs a
_live receiving anchor_ on the destination side, so corridors ship in this order:

| Stage  | Corridor                                                       | Why                                                                                                                                                                        |
| ------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#0** | `reference.corridor.yaml` (Anchor Platform reference, testnet) | Run it yourself, no agreements. Proves the engine moves through all five verbs against a conformant SEP-31 server. **Start here.**                                         |
| **#1** | `mx-bitso.corridor.yaml` (Mexico, Bitso-class) / Anclap        | Real money. These anchors run SEP-31 receive-side today, so `corridor plan` reports the lane runnable (fill endpoints from the live stellar.toml).                         |
| later  | `ng-cn.corridor.yaml` (Nigeria → China)                        | The headline case study, **not** corridor #1. Becomes runnable on the same engine the day a compliant RMB SEP-31 off-ramp exists — fill in `dest.endpoints`, nothing else. |

The CLI makes the constraint visible. `ng-cn` validates structurally, but:

```
$ pnpm cli plan corridors/ng-cn.corridor.yaml
liveness warnings:
  ! dest has no SEP-31 transfer server — corridor cannot settle. NOT runnable.
```

That warning _is_ the off-ramp scarcity, surfaced at build time instead of in
production.

## Going live

Swap the mocks for the real implementations (both ship in this repo):

- `createMockAdapter()` → `new Sep31Adapter(corridor, { sep10: new StellarSep10Signer(keypair) })`
  — the SEP-31/38 HTTP shapes plus the SEP-10 challenge/response and SEP-12 KYC
  status check. The challenge-signing crypto is injected, so the adapter itself
  stays SDK-free.
- `createMockSubmitter()` → `new StellarSettlementSubmitter({ signerSecret, horizonUrl })`
  from `@corridor/stellar` — builds/signs/submits the native bridge-asset payment
  to the anchor deposit address and confirms it on Horizon.
- `new InMemoryIdempotencyStore()` → `new PostgresIdempotencyStore(pool)` for a
  durable, crash-resumable run log (run `migrate(pool)` once at startup).
- Pass an `audit` sink (and a `logger`) to `execute()` so every state transition
  is recorded.

Then point a manifest at the testnet reference server and run it for real. The
proprietary `RouteResolver` is the one piece injected from the private repo.

## Verifying against a real anchor

The default `pnpm test` runs entirely against mocks. An **opt-in** integration
test exercises the adapter against a live SEP-31 server (e.g. the Anchor Platform
reference server on testnet). It is read-only — SEP-10 auth, the SEP-38 quote, and
the conformance probes; it does **not** move funds — and is skipped unless the
anchor env vars are set (see [`.env.example`](./.env.example)):

```bash
ANCHOR_HOME_DOMAIN=anchor.example \
ANCHOR_SEP31_TRANSFER_SERVER=https://anchor.example/sep31 \
ANCHOR_SEP31_QUOTE_SERVER=https://anchor.example/sep38 \
ANCHOR_SEP31_WEB_AUTH=https://anchor.example/auth \
CORRIDOR_SIGNER_SECRET=S...   # testnet only; enables SEP-10 auth
pnpm exec vitest run tests/integration/sep31-live.test.ts
```

The full money-moving end-to-end capture (open → settle → reconcile against a
testnet anchor) is a manual step — the procedure is in
[docs/operations.md](./docs/operations.md). This is the one Phase-1 roadmap item
still open: until that trail is captured here, treat every settlement path as
verified against mocks only.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
