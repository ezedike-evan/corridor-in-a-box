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
- ⬜ A demonstrated end-to-end run against the Anchor Platform SEP-31 reference
  server (corridor #0), captured in the README.

## Phase 2 — Durability & correctness

- ✅ Decimal-safe `Money` arithmetic (no float, explicit rounding).
- ✅ Durable idempotency store (Postgres) + crash-resume of in-flight runs.
- ✅ `reconcile` polls until settled/timeout; `recovery.timeout_seconds`
  enforced; retry backoff.
- ✅ Real refund path (reverse settlement), not just a state write.

## Phase 3 — Operability (required before close beta)

- ✅ Structured logging + append-only audit trail of every state transition.
- ✅ Metrics / tracing hooks (injectable `Metrics`; per-verb timings + counters).
- ✅ Signing-key management: an `ExternalSigner` port (KMS/HSM-ready) and
  [docs/key-management.md](./docs/key-management.md).
- ✅ A thin service/API layer (`@corridor/service`: HTTP over the engine, with
  API-key auth and rate limiting).
- ✅ A runnable launcher for `@corridor/service` (`pnpm serve` →
  `examples/run-service.ts`), serving every corridor manifest with the same
  mainnet safety guard as `pnpm testnet`.
- ✅ Nightly CI job re-running the live-anchor probe
  (`tests/integration/sep31-live.test.ts`), inert until anchor secrets are
  configured.

## Phase 4 — Corridors

- ✅ Corridor #1 manifest for a live SEP-31 receive-side anchor
  (`mx-bitso.corridor.yaml`).
- ⬜ Additional real corridors as off-ramps come online.
- ⬜ `ng-cn` becomes runnable the day a compliant RMB SEP-31 off-ramp exists.

## Phase 5 — Grant-maturity / protocol depth (after wave entry)

- ⬜ Demonstrate all four SEP flows (SEP-10, SEP-12, SEP-31, SEP-38) against a
  live anchor, with tests.
- ⬜ SCF Tier-2 grant proposal — structure and milestones drafted in
  [docs/grant-proposal.md](./docs/grant-proposal.md); budget figures and
  submission still pending maintainer input.
- ⬜ Corridor #1 live: fill `mx-bitso.corridor.yaml` endpoints from the real
  `stellar.toml` (blocked — needs a verified live anchor domain, not a code
  change).

See [CONTRIBUTING.md](./CONTRIBUTING.md) for good first issues.
