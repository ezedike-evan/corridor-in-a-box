# SCF Tier-2 Grant Proposal — corridor-in-a-box

**Status:** draft. Milestones and scope below are derived directly from
[ROADMAP.md](../ROADMAP.md) and the maintainer's own readiness checklist — they
are not new commitments invented for this document. Dollar figures and
timelines below are drafted estimates grounded in each milestone's actual
scope — **the maintainer should adjust them before submission**, not treat
them as final.

**Target wave: the next SCF Tier-2 submission window after M1 closes.**
M0 is now done (see §3) — submitting today is possible, but M1's live
third-party anchor relationship (see below) strengthens the application
considerably and is worth waiting for if the window allows. Exact calendar
date is the maintainer's call once that relationship is in hand — not
guessed here.

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

- **Phase 1 (move real money on testnet): DONE.** SEP-10 challenge/response
  auth, SEP-12 KYC handoff, and a real `@stellar/stellar-sdk`-backed
  settlement submitter are implemented and unit-tested, and the end-to-end
  run against a live anchor (M0, below) has been captured: a real testnet
  settlement transaction, and a full quote → comply → settle corridor run
  against the Anchor Platform reference server, both with transaction
  hashes committed in ROADMAP.md. The one remaining gap is narrower than
  "no live run happened" — reconcile never reached `completed` against that
  run's own observer, which stayed on a stale cursor; that gap is folded
  into M1 below alongside extending the live run to a real third-party
  anchor (the reference server is self-hosted, not an outside counterparty).
- **Phase 2 (durability):** decimal-safe `Money` arithmetic, a durable
  Postgres-backed idempotency store with crash-resume, atomic double-settlement
  protection, and enforced reconcile timeouts with retry/backoff — all shipped
  and tested, including a live-Postgres integration test that runs in CI.
  The recovery path escalates a failed settlement to a manual `held` state;
  **automated refund is not implemented** (an already-credited payment cannot be
  reversed unilaterally on chain, and SEP-31 gives the sender no refund
  endpoint — a real refund means the receiving anchor initiating one on its
  own side, an operational arrangement rather than an API call; see the
  [operations runbook](./operations.md) — which is milestone M5).
- **Phase 3 (operability):** structured logging, an append-only audit trail,
  Prometheus-format metrics, an `ExternalSigner` port (KMS/HSM-ready — see
  [docs/key-management.md](./key-management.md)), and a thin HTTP service
  layer with API-key auth and rate limiting.
- **Phase 4 (corridors):** a manifest **template** for a Mexico lane
  (`mx-example.corridor.yaml`) whose endpoints are fictional placeholders — it
  demonstrates the manifest shape; **no anchor relationship stands behind it**,
  and tooling reports it `UNVERIFIED`. The NG→CN case study is likewise
  documented as pending until a compliant RMB SEP-31 off-ramp exists. The engine
  needs no code change when either becomes real; what is missing is an anchor
  relationship, not software.
- **CI:** lint + typecheck + full mock-backed test suite on every push/PR,
  SHA-pinned actions, CodeQL static analysis, dependency review on PRs, and a
  scheduled probe against a live anchor once one is configured.
- **New since the phases above were drafted — an on-chain anchor
  conformance registry.** `contracts/{registry,attester}` are deployed
  Soroban contracts (testnet, contract IDs in `contracts/deployments.json`)
  that let an enrolled attester write real, probed SEP conformance data
  per anchor domain on-chain — distinct from what a `stellar.toml` merely
  _advertises_. `@corridor/probe` runs the actual protocol checks (SEP-10
  handshake, firm-quote expiry, non-empty SEP-31 receive list) and
  `@corridor/attester` submits the result; `@corridor/router` gained an
  opt-in `RegistryRouteResolver` that fails closed on stale or unattested
  domains. This is the closest thing in the codebase to a novel primitive
  for the ecosystem — a reputation/attestation oracle for anchor conformance
  — and the web dashboard's "Attested anchors" panel reads it live.

See [CHANGELOG.md](../CHANGELOG.md) for the dated commit-level history behind
every claim above, including exact transaction hashes and contract IDs.

## 4. Milestones & itemized budget

| Milestone | Deliverable                                                                                                                                                                                                                                                                              | Maps to                                                                               | Est. cost          | Timeline                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| M0        | **DONE (2026-08-08).** Captured end-to-end run: a real testnet settlement tx, plus a full quote→comply→settle corridor run against the Anchor Platform reference server, tx hashes committed in ROADMAP.md                                                                               | ROADMAP Phase 1 (last open item)                                                      | $0 — delivered     | Complete                                                               |
| M1        | Extend the live run to a real THIRD-PARTY SEP-31 anchor (the reference server above is self-hosted, not an outside counterparty), all four SEP flows with tests, close the reconcile-never-reached-`completed` gap, nightly CI probe green against the real target                       | MAINTAINER §3                                                                         | `[DRAFT: ~$1,500]` | `[DRAFT: ~3 weeks — mostly relationship/access time, not engineering]` |
| M2        | Corridor #1 live: `mx-example.corridor.yaml` filled from a real anchor's published `stellar.toml` with `endpoints_verified_at` set, so `corridor plan` reports it `VERIFIED`                                                                                                             | MAINTAINER §3 / ROADMAP Phase 4 — blocked on a verified anchor relationship, not code | `[DRAFT: ~$1,000]` | `[DRAFT: ~2 weeks after M1's anchor relationship]`                     |
| M3        | Additional real corridors as off-ramps come online                                                                                                                                                                                                                                       | ROADMAP Phase 4 / MAINTAINER §4                                                       | `[DRAFT: ~$2,000]` | `[DRAFT: ongoing, per off-ramp as available]`                          |
| M4        | Publish `@corridor/cli` to npm (pipeline is built and tested, blocked only on an `NPM_TOKEN` secret) and `@corridor/*` more broadly; `web/` wired to a live `@corridor/service` instance                                                                                                 | MAINTAINER §1 ("strongest entry story")                                               | `[DRAFT: ~$500]`   | `[DRAFT: ~1 week — mostly an access/process step, not engineering]`    |
| M5        | Real refund path: an anchor-side refund arrangement (SEP-31 offers the sender no refund endpoint — this is integration/ops work with the receiving anchor, plus observing the outcome on the transaction record) instead of escalating every unrecoverable settlement to a manual `held` | ROADMAP Phase 2 (reopened — not implemented today)                                    | `[DRAFT: ~$4,000]` | `[DRAFT: ~4-6 weeks]`                                                  |
| **Total** |                                                                                                                                                                                                                                                                                          |                                                                                       | `[DRAFT: ~$9,000]` |                                                                        |

All `[DRAFT: ...]` figures are placeholder-replacing estimates, not final —
the maintainer should adjust every one before submission. M0's $0/Complete
is the one row that isn't a draft: it reflects work already shipped, not a
funding ask.

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

`[DRAFT — maintainer to adjust before submission]`

- 3+ real, `VERIFIED` SEP-31 corridors live by M3, each backed by a genuine
  anchor relationship (not a template manifest).
- `@corridor/cli` published to npm (M4) with a runnable example a stranger
  can use without cloning the repo.
- `nightly-live-anchor` CI probe green for 30 consecutive days once
  `ANCHOR_*` secrets are configured against a real third-party anchor.
- The on-chain anchor conformance registry (`contracts/registry`) holding
  attestations for 5+ real anchor domains, kept fresh by the scheduled
  `attest-anchors.yml` job.
- 5+ external contributors with merged PRs, tracked via the existing
  Trivial/Medium/High issue-point ladder in CONTRIBUTING.md.

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
