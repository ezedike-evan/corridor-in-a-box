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
policy (`refund_sender` / `hold` / `manual`). `held` always needs a human;
`refunded` needs a one-line verification.

Inspect any run by key: `GET /payments/:idempotencyKey` (or read the
`corridor_runs` row directly). `lastError` tells you why it stopped.

### Why there is no automated refund

Two independent constraints, same conclusion:

1. **On-chain reversal is impossible.** A credited Stellar payment is final;
   nobody can pull it back unilaterally.
   [`@corridor/stellar`'s `refund()`](../packages/stellar/src/index.ts) exists
   to say exactly that — it always fails, non-retryably, instead of pretending.
2. **SEP-31 gives the sender no refund endpoint.** In the protocol, a refund is
   something the _receiving_ anchor initiates on its own side and merely reports
   back on the transaction record. There is nothing for the engine to call.

So when recovery wants to return money that has already left the distribution
account, the engine cannot do it. It parks the run in `held` and a human
resolves it with the anchor, out of band. The only "automated refund" in this
system is the no-op case: nothing had gone out yet, so there was nothing to
reverse (that is what `refunded` means — see below).

### `held`

The engine reached a non-recoverable failure under a `hold` policy, **or** a
refund was needed and could not be performed (see
[why there is no automated refund](#why-there-is-no-automated-refund)). Funds
may have left the distribution account.

1. Read `stellar_tx_hash` from the run. If set, the bridge payment went out and
   is sitting with the receiving anchor. `lastError` tells you which door the
   run came through: under a `hold` policy it carries the **original failure**
   (`SETTLEMENT_TIMEOUT`, `RECONCILE_MISMATCH`, …) — the refund port was never
   consulted; under `refund_sender` it carries the **refund port's refusal**,
   which with the real `StellarSettlementSubmitter` today reads
   `SETTLEMENT_FAILED: payment … cannot be reversed on-chain` (`@corridor/stellar`
   is slated to adopt a dedicated `REFUND_UNSUPPORTED` code for this; the
   "cannot be reversed" message is the stable part).
2. **Contact the receiving anchor** — exactly that; there is no API for this
   step. Ask it to refund on its side or to complete the payout manually.
3. Once settled out-of-band, the run stays `held` as an audit record. Do not
   re-submit the same `idempotencyKey` — the idempotency gate will reject it.

### `refunded`

**The engine believes no on-chain payment went out.** Despite the name, nothing
was reversed — nothing can be (see
[why there is no automated refund](#why-there-is-no-automated-refund)). In
today's engine this state is reachable only when settlement never succeeded
under a `refund_sender` policy: the engine found no `stellar_tx_hash` on the
run, so there was nothing to undo, and it recorded `refunded` without touching
the chain. Verify the belief before closing the run:

- `stellar_tx_hash` must be **unset**. If it IS set (with the real
  `StellarSettlementSubmitter` that combination should be impossible; the
  mock's `refund()` does succeed, so test data can produce it), money left the
  account and the state is lying — treat the run as `held`, follow the steps
  above, and file a bug.
- An unset hash is the engine's belief, not proof: an **ambiguous submission**
  can land on-chain without the engine ever learning the hash (the submit
  succeeded but confirmation timed out on Horizon read lag, or the send itself
  ended ambiguously). Read `lastError` — on `SETTLEMENT_TIMEOUT` or an
  ambiguous-submit message, check Horizon for the distribution account's recent
  payments (the same check "Crash mid-flight" below prescribes for `settling`)
  before declaring the sender whole.

If an anchor-driven refund path ever lands (a refund-wait state between
`recovering` and `refunded`), a second, legitimate way into this state appears —
one where a payment **did** go out and the anchor returned it, hash set. The
run's trail tells the two apart — and `refund_id`, described below, records
which refund it was.

### `refund_id` on the run

The run carries `refund_id` alongside `stellar_tx_hash`: the reference of a
refund that has already been requested, empty until one is.

It exists so a resumed run can tell "a refund was requested" from "a refund was
never requested". Without it a process that crashed after requesting a refund
comes back with no record of having done so and asks for a second one — not
settling twice, but money moving twice all the same. The refund request path
reads it and refuses to issue another.

Consequently it is **write-once**: `migrate()` adds the column additively, and
`put()` coalesces rather than overwrites, so a writer holding a stale copy of
the run cannot erase the evidence. If you see a run whose `refund_id` is set,
a refund reference exists at the submitter — check there before initiating
anything by hand.

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
