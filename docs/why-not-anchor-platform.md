# Why not just use the Anchor Platform?

A fair question: the Stellar Development Foundation publishes the
[Anchor Platform](https://developers.stellar.org/docs/category/anchor-platform),
a reference implementation of the SEP server side. If you are **an anchor**, you
should almost certainly run it. So where does `corridor-in-a-box` fit?

## Different side of the wire

The Anchor Platform is the **server an anchor runs** to _expose_ SEP-31/38/12/10
endpoints. `corridor-in-a-box` is the **orchestrator a remittance operator runs**
to _drive a payment across two anchors_ — quote → comply → settle → reconcile →
recover — and to move the on-chain bridge asset between them.

They are complementary: in a real lane the receiving anchor runs the Anchor
Platform, and this engine talks to it through the same SEP-31 adapter you'd use
for any standards-compliant anchor.

|                                      | Anchor Platform     | corridor-in-a-box                |
| ------------------------------------ | ------------------- | -------------------------------- |
| Who runs it                          | An anchor           | A remittance operator / PSP      |
| Role                                 | Serve SEP endpoints | Orchestrate a payment end-to-end |
| Owns the settle leg                  | No                  | Yes (native Stellar payment)     |
| Multi-anchor routing                 | No                  | Yes (RouteResolver seam)         |
| Idempotency / recovery state machine | N/A                 | Core                             |

## What this engine adds

- **A corridor is configuration, not code.** Adding a lane is a new
  `*.corridor.yaml`, not a fork. The engine contains no corridor-specific
  strings.
- **One adapter for every standards-compliant anchor**, plus a port for bespoke
  OTC/exchange desks that don't speak SEP-31.
- **An explicit, persisted state machine** with idempotency, crash-resume,
  timeout enforcement, retry/backoff, and a real refund/hold recovery path —
  the things you need to not lose an in-flight payment.
- **A route seam.** The open repo ships the `RouteResolver` interface and a
  trivial "use the declared anchor" default; the health-/rate-weighted resolver
  is the proprietary half, injected at runtime.
- **Build-time liveness checks.** `corridor plan` surfaces missing endpoints
  (e.g. a destination with no SEP-31 server) before you touch the network.

## When you do NOT need this

- You are an anchor exposing SEP endpoints → run the Anchor Platform.
- You move money over a single, fixed anchor pair with no recovery requirements
  → a script may be enough.

Use `corridor-in-a-box` when you orchestrate cross-border payments over one or
more standards-compliant anchors and need the payment lifecycle handled
correctly.
