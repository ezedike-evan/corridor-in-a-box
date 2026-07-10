# SCF Tier-2 Grant Proposal — corridor-in-a-box

**Status:** draft. Milestones and scope below are derived directly from
[ROADMAP.md](../ROADMAP.md) and the maintainer's own readiness checklist — they
are not new commitments invented for this document. Dollar figures are marked
`[PLACEHOLDER]` and need maintainer input before submission; everything else is
ready to use as-is or lightly edit.

`[PLACEHOLDER: submission date / target wave]`

## 1. One-line summary

An open, manifest-driven orchestration engine for Stellar SEP-31 cross-border
payment corridors — quote → comply → settle → reconcile → recover over any
standards-compliant anchor pair — seeking Tier-2 funding to close the remaining
gap between "engine proven against mocks" and "engine proven against a live
anchor, on multiple corridors, with an npm-installable release."

## 2. Problem & thesis

Off-ramp scarcity, not code, is the binding constraint on cross-border Stellar
payments. A remittance operator does not lack a place to write orchestration
logic — they lack live, standards-compliant SEP-31 receiving anchors on the
destination side. `corridor-in-a-box`'s thesis is that a corridor should be
**configuration, not code**: the engine contains no corridor-specific strings,
and adding a lane is a new `*.corridor.yaml` file, not a fork (see
[docs/why-not-anchor-platform.md](./why-not-anchor-platform.md) for how this
differs from — and complements — the SDF's own Anchor Platform, which is the
server side of the same protocol).

This matters for grant fit specifically because it's a claim about
**protocol-standard depth on a closed loop**: SEP-10 auth, SEP-12 KYC, SEP-31
transfers, and SEP-38 quotes are all implemented against one generic adapter
that works with any conformant anchor, rather than bespoke integration code
per counterparty.

## 3. What exists today (evidence, not aspiration)

Pulled directly from [ROADMAP.md](../ROADMAP.md), which tracks this with
✅/⬜ per phase:

- **Phase 1 (move real money on testnet):** SEP-10 challenge/response auth,
  SEP-12 KYC handoff, and a real `@stellar/stellar-sdk`-backed settlement
  submitter are all implemented and unit-tested. The one open item — a
  demonstrated end-to-end run against a live anchor, captured in the README —
  is milestone M0 below.
- **Phase 2 (durability):** decimal-safe `Money` arithmetic, a durable
  Postgres-backed idempotency store with crash-resume, atomic double-settlement
  protection, enforced reconcile timeouts with retry/backoff, and a real
  refund/hold recovery path — all shipped and tested, including a live-Postgres
  integration test that runs in CI.
- **Phase 3 (operability):** structured logging, an append-only audit trail,
  Prometheus-format metrics, an `ExternalSigner` port (KMS/HSM-ready — see
  [docs/key-management.md](./key-management.md)), and a thin HTTP service
  layer with API-key auth and rate limiting.
- **Phase 4 (corridors):** a runnable manifest for a live MX/Bitso-class
  receiving anchor; the NG→CN case study is intentionally documented as
  pending until a compliant RMB SEP-31 off-ramp exists — the engine needs no
  code change when one does.
- **CI:** lint + typecheck + full mock-backed test suite on every push/PR,
  SHA-pinned actions, CodeQL static analysis, dependency review on PRs, and a
  scheduled probe against a live anchor once one is configured.

See also [CHANGELOG.md](../CHANGELOG.md) for the full, dated history.

## 4. Milestones & itemized budget

| Milestone | Deliverable                                                                                                                                                      | Maps to                                                                               | Est. cost       | Timeline        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------- | --------------- |
| M0        | Captured end-to-end run against the Anchor Platform SEP-31 reference server on testnet, trail + tx hash in the README                                            | ROADMAP Phase 1 (last open item)                                                      | `[PLACEHOLDER]` | `[PLACEHOLDER]` |
| M1        | Demonstrate all four SEP flows (SEP-10, SEP-12, SEP-31, SEP-38) against a live anchor, with tests, plus the nightly CI probe running green against a real target | MAINTAINER §3                                                                         | `[PLACEHOLDER]` | `[PLACEHOLDER]` |
| M2        | Corridor #1 live: `mx-bitso.corridor.yaml` filled from a real, verified anchor `stellar.toml`; `corridor plan` reports the lane runnable                         | MAINTAINER §3 / ROADMAP Phase 4 — blocked on a verified anchor relationship, not code | `[PLACEHOLDER]` | `[PLACEHOLDER]` |
| M3        | Additional real corridors as off-ramps come online                                                                                                               | ROADMAP Phase 4 / MAINTAINER §4                                                       | `[PLACEHOLDER]` | `[PLACEHOLDER]` |
| M4        | `@corridor/*` published to npm (or at minimum the CLI) with a runnable example; `web/` wired to a live `@corridor/service` instance via `CORRIDOR_SERVICE_URL`   | MAINTAINER §1 ("strongest entry story")                                               | `[PLACEHOLDER]` | `[PLACEHOLDER]` |
| **Total** |                                                                                                                                                                  |                                                                                       | `[PLACEHOLDER]` |                 |

## 5. Team

`[PLACEHOLDER: maintainer background, prior relevant work, any collaborators]`

## 6. Why this fits SCF / grant-maturity criteria

- **Open-core boundary, not a walled garden.** Everything needed to run the
  engine end-to-end is in this repo under Apache-2.0; only the proprietary
  route-health intelligence behind the `RouteResolver` seam is closed, and
  that seam is a single injected interface, not a scattered set of gates.
- **Protocol-standard depth.** The engine speaks SEP-10/12/31/38 generically,
  not per-anchor bespoke code — the conformance suite in `@corridor/adapter-kit`
  is what any new anchor adapter is checked against.
- **Evidence over aspiration.** Every ✅ in ROADMAP.md corresponds to shipped,
  tested code in this repo today, not a future promise.

## 7. Success metrics

`[PLACEHOLDER: e.g. number of live corridors, volume settled on testnet/mainnet,
external contributors, npm downloads, uptime of the nightly live-anchor probe
once configured]`

## 8. Risks

- **Live-anchor dependency.** M0 and M1 both require a live, reachable SEP-31
  receiving anchor (either self-hosted via the Anchor Platform reference
  server, or a real counterparty's). This is an external dependency the
  engine's own code cannot shortcut.
- **M2/M3 depend on real business relationships**, not engineering — filling
  in an anchor's endpoints from a live `stellar.toml` requires that
  relationship to exist and be verified first.
- **Soroban corridor-data oracle is explicitly out of this budget's scope.**
  It's an optional, separate on-chain publishing mechanism for corridor data —
  not on the money-moving path — and would mean standing up an entirely
  separate Rust/Soroban toolchain. Scoped as its own follow-up if ever pursued,
  not bundled into the milestones above.

## 9. Appendix

- [ROADMAP.md](../ROADMAP.md) — phase-by-phase status
- [CHANGELOG.md](../CHANGELOG.md) — full dated history
- [docs/why-not-anchor-platform.md](./why-not-anchor-platform.md) — positioning vs. the SDF's own reference server
- [docs/sep-coverage.md](./sep-coverage.md) — why SEP-31 specifically, vs. SEP-6/24
- [docs/operations.md](./operations.md) — operator runbook, including the M0 capture procedure
