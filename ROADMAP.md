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
- ⬜ Metrics / tracing hooks.
- ⬜ Signing-key management guidance and a KMS-backed submitter example.
- ⬜ A thin service/API layer (the engine is a library today).

## Phase 4 — Corridors

- ✅ Corridor #1 manifest for a live SEP-31 receive-side anchor
  (`mx-bitso.corridor.yaml`).
- ⬜ Additional real corridors as off-ramps come online.
- ⬜ `ng-cn` becomes runnable the day a compliant RMB SEP-31 off-ramp exists.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for good first issues.
