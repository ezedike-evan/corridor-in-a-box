# Operations runbook

This is the operator-facing companion to the README's "Going live" section. It
covers the manual procedures the engine does **not** automate: capturing a
testnet run, recovering `held`/`refunded` payments, rotating the signing key,
running migrations, and the project's versioning/release policy.

> Pre-1.0 and not yet validated against a live anchor — see the [ROADMAP](../ROADMAP.md).
> Treat this runbook as the plan for a self-run testnet/close-beta pilot, not a
> claim of production-readiness.

## 1. Capturing the testnet end-to-end run

This is the one open Phase-1 item: a real `open → settle → reconcile` against a
live SEP-31 server, captured in the README.

1. **Pick the anchor.** Two zero-agreement options:
   - **SDF test anchor** (`testanchor.stellar.org`) — public, always up, no
     self-hosting. Its endpoints are documented as known-good values in
     [`.env.example`](../.env.example) (read-only suite verified green
     2026-07-12). Check its `/sep31/info` first: an empty `receive` list means
     quotes/auth/KYC work but a money-moving transaction cannot be opened there
     that day.
   - **Self-hosted Anchor Platform reference server** (Docker) — full control
     of the receive side; required if the public anchor exposes no receivable
     asset. Read its `stellar.toml` for the `DIRECT_PAYMENT_SERVER`,
     `WEB_AUTH_ENDPOINT`, `KYC_SERVER`, `QUOTE_SERVER`.
2. **Fund a testnet distribution account** (Friendbot) and trustline the bridge
   asset. Keep the secret in `CORRIDOR_SIGNER_SECRET` (testnet only).
3. **Smoke-test read-only first** with the opt-in integration suite (see
   [`.env.example`](../.env.example)):
   ```bash
   ANCHOR_HOME_DOMAIN=… ANCHOR_SEP31_TRANSFER_SERVER=… ANCHOR_SEP31_QUOTE_SERVER=… \
   ANCHOR_SEP31_WEB_AUTH=… CORRIDOR_SIGNER_SECRET=S… \
   pnpm exec vitest run tests/integration/sep31-live.test.ts
   ```
4. **Pre-flight the manifest** offline: `pnpm cli plan corridors/reference.corridor.yaml`
   must report the lane runnable (no liveness warnings).
5. **Drive one payment** with the real implementations wired per the README's
   "Going live" list (`Sep31Adapter` + `StellarSettlementSubmitter` +
   `PostgresIdempotencyStore`, with an `audit` sink). Capture the resulting
   `trail` (the `created → … → completed` line) and the `stellarTxHash`, and paste
   them into the README.

When that trail is in the README, check off the last Phase-1 box in the ROADMAP.

## 2. Recovering a stuck payment

The engine drives recovery automatically per the manifest's `recovery.rollback`
policy (`refund_sender` / `hold` / `manual`), but two terminal states need a human.

Inspect any run by key: `GET /payments/:idempotencyKey` (or read the
`corridor_runs` row directly). `lastError` tells you why it stopped.

### `held`

The engine reached a non-recoverable failure under a `hold` policy, **or** an
on-chain refund itself failed. Funds may have left the distribution account.

1. Read `stellar_tx_hash` from the run. If set, the bridge payment went out and
   is sitting with the receiving anchor.
2. Resolve out-of-band: trigger the **anchor's SEP-31 refund flow**, or complete
   the payout manually with the anchor. On-chain unilateral reversal is not
   possible (see [`@corridor/stellar`'s `refund()`](../packages/stellar/src/index.ts)).
3. Once settled out-of-band, the run stays `held` as an audit record. Do not
   re-submit the same `idempotencyKey` — the idempotency gate will reject it.

### `refunded`

The engine reversed (or had nothing to reverse) and returned the sender's funds.
No action needed beyond confirming the sender was made whole.

### `failed` before `settled`

No payment went out (failure was at quote/comply/open). Safe to retry with a
**new** `idempotencyKey`.

### Crash mid-flight

On restart, calling `execute()` again with the same intent auto-resumes from
`settled`/`reconciled` (re-polls, never re-settles). A run stuck in `settling`
returns `IDEMPOTENCY_CONFLICT` — investigate whether the payment went out (check
Horizon for the distribution account) before forcing any action.

## 3. Signing-key rotation

The distribution account's seed is the highest-value secret; see
[key-management.md](./key-management.md) for the `ExternalSigner` (KMS/HSM) port.

1. Stand up the new signer (new KMS key or new account) and fund/trustline it.
2. Drain in-flight work: stop accepting new payments, let outstanding runs reach
   a terminal state (watch `corridor_runs` for non-terminal rows).
3. Swap the `ExternalSigner` / `signerSecret` the `StellarSettlementSubmitter` is
   constructed with, and the SEP-10 `StellarSep10Signer` account.
4. Re-run the read-only integration suite against the anchor to confirm SEP-10
   auth still succeeds with the new account.
5. Revoke the old key once no run references it.

## 4. Database migrations

The durable store needs one table. Run the bundled DDL once at startup or via
your migration tool:

```ts
import { migrate } from "@corridor/engine";
await migrate(pool); // idempotent: CREATE TABLE IF NOT EXISTS corridor_runs (…)
```

The schema is intentionally tiny (`packages/engine/src/idempotency-pg.ts`). The
`version` column carries optimistic concurrency — never edit it by hand. Any
future schema change ships as an additive migration with a CHANGELOG entry.

## 5. Scaling notes (before multi-replica)

- The service's **rate limiter and in-memory idempotency store are per-process**.
  Before running more than one replica:
  - Back idempotency with `PostgresIdempotencyStore` (shared). Its atomic
    `create()` claim + version-guarded `put()` make the double-settlement gate
    correct across replicas — the `IdempotencyStore` interface is the seam.
  - Inject a shared rate limiter via `ServiceOptions.rateLimiter` (the
    `RateLimiter` interface; `take()` may be async). The default `TokenBucket`
    is per-process; a Redis token bucket (a small `EVAL` Lua script doing
    refill-then-decrement against a per-client key) enforces the limit fleet-wide.
    Without it, each replica grants the full bucket independently.
- Set `maxBodyBytes` on the service for your payload size (default 64 KiB).
- Enable `trustProxy` **only** behind an ingress that sets `X-Forwarded-For` and
  strips any client-supplied value; otherwise leave it off so the socket peer
  address (which a client cannot forge) keys the limiter.
- Wire `gracefulShutdown(server)` to `SIGTERM`/`SIGINT` so a rollout drains
  in-flight payments instead of severing one mid-settle.
- Terminate TLS at your ingress; the built-in `node:http` server speaks plain HTTP.

## 6. Versioning & releases

- The project follows [Semantic Versioning](https://semver.org). **While pre-1.0,
  minor versions may contain breaking changes**; pin exact versions.
- All notable changes are recorded in [CHANGELOG.md](../CHANGELOG.md)
  (Keep a Changelog format). Every behaviour change updates the `Unreleased`
  section in the same PR.
- A release: move `Unreleased` to a dated, numbered section; tag `vX.Y.Z`; the
  tag is the source of truth for the changelog compare links.
- Only the latest `main` is supported; fixes are not backported (see
  [SECURITY.md](../SECURITY.md)).

## 7. Metrics & alerting

The engine emits counters/timings to an injected `Metrics` sink and one
`corridor.terminal{state=…}` counter on every terminal transition. To scrape
them with no client library, pass a `PrometheusMetrics` to BOTH the engine and
the service:

```ts
import { PrometheusMetrics } from "@corridor/engine";
const metrics = new PrometheusMetrics();
const service = createService({
  corridors,
  deps: { ...deps, metrics },
  metricsText: () => metrics.render(), // GET /metrics (public, unmetered)
});
```

Point Prometheus at `/metrics`. The two alerts that matter both key off the
terminal counter — they catch money that stopped needing a human (see §2):

```yaml
# Funds may be parked with the anchor; on-chain reversal isn't possible.
- alert: CorridorPaymentsHeld
  expr: increase(corridor_terminal{state="held"}[15m]) > 0
# A payment failed terminally (before or after settle).
- alert: CorridorPaymentsFailed
  expr: increase(corridor_terminal{state="failed"}[15m]) > 0
```

Useful companion series: `corridor_transition{to=…}` (throughput per state),
`corridor_verb_<verb>_ms_*` (per-verb latency summary), and `corridor_duration_ms_*`
(end-to-end). Treat a rising `held`/`failed` rate as the page-worthy signal.
