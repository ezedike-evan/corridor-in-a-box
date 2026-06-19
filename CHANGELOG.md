# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches
1.0. While pre-1.0, minor versions may contain breaking changes.

## [Unreleased]

### Added

- GitHub issue and PR templates.
- Separate CI job that typechecks and builds the `web/` showcase app.
- `author`/`maintainers`/`repository` metadata in `package.json` (so the
  `SECURITY.md` reporting pointer resolves).
- `CHANGELOG.md` and `.env.example`.
- Request body-size limit in `@corridor/service` (memory-DoS guard).
- Explicit SEP-31 lifecycle status mapping (`mapSep31Status`) plus contract-shape
  tests for the adapter.
- Env-gated integration test against a real SEP-31 server (`tests/integration/`).
- `docs/operations.md` (runbook) and `docs/sep-coverage.md` (SEP-31 vs SEP-6/24).

## [0.1.0] — 2026-06-18

Initial public release: the walking skeleton.

### Added

- `@corridor/types` — `Outcome<T>` no-throw result type and decimal-safe `Money`.
- `@corridor/manifest` — Zod schema + loader for a `*.corridor.yaml`; the corridor
  abstraction.
- `@corridor/adapter-kit` — `AnchorAdapter` port, conformance probes, mock adapter.
- `@corridor/sep31` — one adapter for any standards-compliant SEP-31 anchor
  (SEP-10 auth + SEP-12 KYC; crypto behind an injected signer).
- `@corridor/stellar` — settlement submitter + SEP-10 signer; `ExternalSigner`
  (KMS/HSM) port.
- `@corridor/router` — `RouteResolver` seam + static default.
- `@corridor/engine` — corridor-agnostic orchestration of quote → comply → settle
  → reconcile → recover, with a persisted state machine, crash-resume, recovery,
  audit trail, metrics hooks, and a durable Postgres idempotency store.
- `@corridor/service` — thin HTTP API over the engine (API-key auth, rate limit).
- `@corridor/cli` — manifest validation and an offline runnability `plan`.
- Reference, MX/Bitso, and NG→CN corridor manifests.
- Docs: key management, "why not Anchor Platform".

[Unreleased]: https://github.com/ezedike-evan/corridor-in-a-box/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ezedike-evan/corridor-in-a-box/releases/tag/v0.1.0
