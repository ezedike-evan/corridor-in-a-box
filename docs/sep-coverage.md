# SEP coverage: why SEP-31, and where SEP-6/24 fit

`corridor-in-a-box` orchestrates **SEP-31** cross-border payments. That is a
deliberate scope choice, not an assumption that SEP-31 is the only flow that
matters. This note explains the choice and how the engine would extend to the
other transfer SEPs.

## The transfer SEPs, briefly

| SEP        | Shape                              | Who the "customer" is        | Human in the loop?           |
| ---------- | ---------------------------------- | ---------------------------- | ---------------------------- |
| **SEP-6**  | Programmatic deposit/withdraw      | An end user of one anchor    | No (API-driven)              |
| **SEP-24** | Interactive deposit/withdraw       | An end user of one anchor    | Yes (anchor-hosted webview)  |
| **SEP-31** | Cross-border **anchor-to-anchor**  | A _sending business_ (PSP)   | No — fully programmatic      |

SEP-6 and SEP-24 are **user ↔ anchor**: a person on- or off-ramps with a single
anchor. SEP-31 is **anchor ↔ anchor**: a sending business hands a payment (and the
customer's KYC, via SEP-12) to a receiving anchor that pays out the recipient.
SEP-38 (quotes) and SEP-10 (auth) are shared plumbing under all three.

## Why this engine targets SEP-31

The product is an **orchestrator a remittance operator / PSP runs to drive a
payment across two anchors** — exactly the SEP-31 topology:

- It is **server-to-server and non-interactive**: no anchor-hosted webview to
  babysit, which is what makes a corridor automatable as a state machine.
- The recipient is reached through the **receiving anchor's** payout rails, so the
  engine only owns the on-chain bridge leg plus quote/comply/reconcile/recover —
  the five verbs.
- KYC moves operator→anchor via **SEP-12**, so PII never flows through the engine
  (see [SECURITY.md](../SECURITY.md)).

SEP-6/24 solve a different problem (one user, one anchor) and carry interactive
state (SEP-24's webview) that doesn't belong in an unattended corridor runner.

## How the architecture would extend

The boundary that makes this tractable is already in place: the engine knows only
the **`AnchorAdapter`** port (`packages/adapter-kit`), never a specific SEP. Adding
another transfer SEP is a new adapter, not an engine change:

- **SEP-6** maps cleanly onto the same five verbs — `openTransaction` becomes a
  SEP-6 `POST /transactions/withdraw` (or `/deposit`), `getTransaction` polls the
  SEP-6 status. A `Sep6Adapter` alongside `Sep31Adapter` would be the bulk of it.
- **SEP-24** is the awkward one: its interactive webview needs a human, so it
  fits a *user-facing* product, not an unattended corridor. If it were ever
  needed, the `open` step would return an `interactive_url` the caller must drive,
  and the engine would park in a `pending_user` state — a genuine engine change,
  which is why it is out of scope today.

The manifest already abstracts the corridor; the adapter port already abstracts
the protocol. SEP-31 is the first and primary target because it is the flow whose
shape actually matches an automated cross-border orchestrator.

See also [why-not-anchor-platform.md](./why-not-anchor-platform.md) for how this
relates to the SDF Anchor Platform (the server side an anchor runs).
