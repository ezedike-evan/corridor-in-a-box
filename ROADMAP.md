# Roadmap

This project is a **walking skeleton**: the orchestration is real and tested
against mocks, but the money-moving paths and durability are being filled in.
The list below is roughly the order in which the skeleton becomes a beta-grade
system. Items marked ✅ are done.

## Phase 1 — Move real money on testnet

- ✅ SEP-10 challenge/response auth in the SEP-31 adapter (`authToken()`).
- ✅ SEP-12 KYC handoff against `kyc_server`.
- ✅ A real `SettlementSubmitter` on `@stellar/stellar-sdk` (build → sign →
  submit a native payment, watch Horizon).
- ✅ The settle leg executed against **live Stellar testnet** — build → sign →
  submit → confirm on Horizon, reproducible via `pnpm verify:settle`. Captured
  tx: [`855933c7…08dfd245`](https://stellar.expert/explorer/testnet/tx/855933c73b85b9071318ff0bfd9213096a1edfaef68417dea1c2e8fb08dfd245)
  (ledger 4024693, 2026-08-07). This is the settle leg **only** — no anchor is
  involved, so it is not yet a corridor run.
- ✅ SEP-10 auth, SEP-12 registration (both parties), SEP-38 firm quote and
  SEP-31 `POST /transactions` all executed against the **Anchor Platform
  reference server** running locally (`scripts/reference-anchor.sh up`), with
  the settle leg landing 10 USDC on its deposit address — tx
  [`4aea2432…`](https://stellar.expert/explorer/testnet/tx/4aea2432696c43104662fea98c86cecdfb12e2e831426e3a90e616eb7f183897),
  ledger 4030910, correctly attributed by hash memo. Captured in the README.
- ⬜ `reconcile → completed` against a real counterparty. The run above reaches
  `settled` and then polls: the reference server's Stellar observer sat on a
  stale cursor, never matched the payment, and left the transaction at
  `pending_sender`. The engine's timeout/recovery path is what ran. **This leg
  remains unproven end to end** and is the last open Phase-1 item.
  _Update (2026-09-01):_ cursor seeding fixed in #65 — `reference-anchor.sh up`
  reseeds the observer cursor from Horizon's tip, #66 added `doctor`'s
  cursor-lag check, and #67/#75 added `pnpm verify:corridor` and the scheduled
  [`reference-corridor`](https://github.com/ezedike-evan/corridor-in-a-box/actions/workflows/reference-corridor.yml)
  workflow. The pending proof is that workflow going green; it currently fails,
  so this item stays ⬜.
  _Update (2026-10-24):_ the failure it had was the signer draining
  (`op_underfunded`): the workflow now tops the signer up first (#297), and a manual
  run settles (tx
  [`757341…`](https://stellar.expert/explorer/testnet/tx/757341861311f52f6feaf8a1f307215c77acfd3238779d184911a0579d448b42)).
  It still ends red: after settling, the reference anchor's status poll returns `error`
  for about 15 minutes, so the run goes `settled → recovering → held`. That is the open
  question, and it stays ⬜.

## Phase 2 — Durability & correctness

- ✅ Decimal-safe `Money` arithmetic (no float, explicit rounding).
- ✅ Durable idempotency store (Postgres) + crash-resume of in-flight runs.
- ✅ `reconcile` polls until settled/timeout; `recovery.timeout_seconds`
  enforced; retry backoff.
- ⬜ Real refund path (reverse settlement). **Not implemented**, and the engine
  never calls `requestRefund`. `StellarSettlementSubmitter.refund()` unconditionally
  returns a non-retryable failure — an already-credited payment cannot be reversed
  unilaterally on chain, which is correct behaviour. A genuine refund means the
  receiving anchor initiating one on its own side — SEP-31 gives the sender no endpoint
  to trigger one, so this is an operational arrangement with the anchor, not an API
  call (the full reasoning lives in [the operations runbook](./docs/operations.md)).
  What ships today is the watch and the escalation, not the reversal: after a
  payment has gone out and the anchor reports a terminal failure, the run enters
  `refund_pending` and the engine polls for the anchor's own refund report (`refunded`
  on a full report; `held` on a partial one or after `recovery.refund_wait_seconds`).

## Phase 3 — Operability (required before close beta)

- ✅ Structured logging + append-only audit trail of every state transition.
- ✅ Metrics / tracing hooks (injectable `Metrics`; per-verb timings + counters).
- ✅ Signing-key management: an `ExternalSigner` port with Vault Transit, AWS KMS and
  Google Cloud KMS implementations, and [docs/key-management.md](./docs/key-management.md).
- ✅ A thin service/API layer (`@corridor/service`: HTTP over the engine, with
  API-key auth and rate limiting).
- ✅ A runnable launcher for `@corridor/service` (`pnpm serve` →
  `examples/run-service.ts`), serving every corridor manifest with the same
  mainnet safety guard as `pnpm testnet`.
- ✅ OpenTelemetry adapters for the `Metrics` and `Logger` ports (`@corridor/otel`),
  and a Redis token bucket for a fleet-wide rate limit (`RedisTokenBucket`).
- ✅ An OpenAPI 3.1 spec for the service, tested against the real `route()`.
- ✅ A container image (`Dockerfile`), smoke-tested in CI and published to GHCR on
  release tags; coverage floors enforced in CI; every library package builds to
  `dist/` with type declarations; and a one-tag release workflow. Cutting the first
  `vX.Y.Z` tag is a maintainer action: it needs a `CHANGELOG.md` section for the version.
- ✅ A scriptable mock anchor (`pnpm mock:anchor`) that stalls, rejects KYC, errors
  after settle or refunds on demand, for running a whole corridor locally.
- ✅ Nightly CI job re-running the live-anchor probe
  (`tests/integration/sep31-live.test.ts`), running against `testanchor.stellar.org`
  by default; only the SEP-10/SEP-12 legs need `CORRIDOR_SIGNER_SECRET`.

## Phase 4 — Corridors

- ✅ Corridor #1 manifest for a live SEP-31 receive-side anchor.
  `ng-cowrie.corridor.yaml` — Cowrie Exchange (Lagos, Nigeria), confirmed
  2026-08-11 by running `@corridor/probe` for real against its production API:
  SEP-10 challenge signed and exchanged for a JWT, SEP-12 answered, SEP-31
  `/info` returned a non-empty receive list (NGNT, USDC). `endpoints_verified_at`
  is set and `corridor plan` reports it `VERIFIED`. `mx-example.corridor.yaml`
  remains a fictional template for a _different_ lane (Mexico) and is
  unaffected. What this does NOT mean: no payment has been attempted, Cowrie
  publishes no SEP-38 quote server (`quote_source: external`), and there is no
  KYC'd business relationship with Cowrie backing this — see the manifest's
  `status_note`.
- ✅ Corridor #2: `zeam.corridor.yaml` — Zeam (South Africa), probed 2026-10-17:
  SEP-10, SEP-12, SEP-31 and SEP-38 all answer, so it is the first lane with a firm-quote
  path. Same caveats as #1: no payment attempted, no business relationship.
- ✅ A SEP-6 lane: `testanchor-sep6.corridor.yaml`, the SDF test anchor on testnet.
  [`corridors/README.md`](./corridors/README.md) catalogues every manifest.
- ⬜ Additional real corridors as off-ramps come online.
- ⬜ `ng-cn` becomes runnable the day a compliant RMB SEP-31 off-ramp exists.

## Phase 5 — Grant-maturity / protocol depth (after wave entry)

- ⬜ Demonstrate all four SEP flows (SEP-10, SEP-12, SEP-31, SEP-38) against a
  live anchor, with tests.
- ⬜ SCF Tier-2 grant proposal — structure and milestones drafted in
  [docs/grant-proposal.md](./docs/grant-proposal.md); budget figures and
  submission still pending maintainer input.
- ⬜ First payment on a VERIFIED corridor (ng-cowrie) — blocked on a KYC'd business
  relationship.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for good first issues.
