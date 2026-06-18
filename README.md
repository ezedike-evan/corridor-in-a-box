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
pnpm typecheck          # whole monorepo, one tsc pass
pnpm test               # vitest: engine + manifest
pnpm example            # run a payment end-to-end (mocked anchor + settle)
pnpm cli plan corridors/reference.corridor.yaml   # offline pre-flight / liveness check
```

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
  router/        RouteResolver seam — open interface + dumb static default
  engine/        corridor-agnostic orchestration of the five verbs
  cli/           validate a manifest; print an offline runnability plan
corridors/       the manifests — ALL corridor-specifics live here, nowhere else
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

| Stage | Corridor | Why |
|------|----------|-----|
| **#0** | `reference.corridor.yaml` (Anchor Platform reference, testnet) | Run it yourself, no agreements. Proves the engine moves through all five verbs against a conformant SEP-31 server. **Start here.** |
| **#1** | Mexico (Bitso) / Argentina, Peru (Anclap) | Real money. These anchors run SEP-31 receive-side today. |
| later | `ng-cn.corridor.yaml` (Nigeria → China) | The headline case study, **not** corridor #1. Becomes runnable on the same engine the day a compliant RMB SEP-31 off-ramp exists — fill in `dest.endpoints`, nothing else. |

The CLI makes the constraint visible. `ng-cn` validates structurally, but:

```
$ pnpm cli plan corridors/ng-cn.corridor.yaml
liveness warnings:
  ! dest has no SEP-31 transfer server — corridor cannot settle. NOT runnable.
```

That warning _is_ the off-ramp scarcity, surfaced at build time instead of in
production.

## Going live

Swap two mocks for real implementations:

- `createMockAdapter()` → `new Sep31Adapter(corridor)` (already implements the
  SEP-31/38 HTTP shapes; SEP-10 JWT auth is the one stub to fill in).
- `createMockSubmitter()` → a `SettlementSubmitter` backed by
  `@stellar/stellar-sdk` that builds/signs/submits the native payment to the
  anchor's deposit address and watches Horizon. See `engine/src/ports.ts` for the
  exact builder sketch.

Then point a manifest at the testnet reference server and run it for real.

## License

Apache-2.0.
