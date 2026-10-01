# Claimable-balance settlement spike

## Recommendation

Reject claimable balances for generic SEP-31 adapters; consider them only for bespoke anchors whose observer explicitly indexes `CreateClaimableBalance` and whose settlement contract accepts the claimant predicate. A normal SEP-31 observer expects a payment destination plus memo, while a claimable balance carries no memo field, so substituting it would make correlation and compliance ambiguous.

## Operational trade-offs

- The sender can reclaim only after the timeout predicate becomes true; the timeout must exceed realistic anchor payout and ledger-finality time.
- Each balance reserves ledger rent and adds an additional transaction/state lifecycle.
- Engine support would require `settlement.mode = "claimable_balance"`, a persisted reclaim deadline, and an idempotent `refund` branch that submits the sender-reclaim operation only after the deadline.
- The reference-anchor observer must be tested on testnet before enabling this mode; the default payment path remains unchanged.

## Implementation boundary

This spike intentionally adds no production settlement behavior. The next step is an adapter capability flag, a testnet prototype using `scripts/reference-anchor.sh up`, and contract-specific observer evidence.

## Test plan

Run `pnpm typecheck`, `pnpm test`, and `pnpm lint`; record observer behavior and transaction reserve costs before an adapter opts in.
