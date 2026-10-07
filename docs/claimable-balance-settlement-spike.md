# Claimable-balance settlement spike

## Decision

**Use claimable balances only with bespoke adapters whose anchor explicitly accepts this settlement form and can reconcile it. Do not substitute one for the SEP-31 deposit payment.** The existing payment-and-memo path remains the generic SEP-31 behavior.

This is a design decision, not a production implementation. The distinction matters because a successful `CreateClaimableBalance` transaction proves that an entry was created on Stellar; it does not prove that the receiving anchor matched it to a SEP-31 transaction or paid the recipient.

## Compatibility evidence

SEP-31's receiving-anchor flow says to wait for the Stellar payment identified by the `stellar_memo` returned for the transaction. The SEP also says the receiving anchor must use the transaction memo to match an incoming payment with its record. It does not define a claimable-balance settlement or a claimable-balance ID field for SEP-31 transaction matching. [SEP-31, memo matching and receiving-anchor flow](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md#detailed-receiving-anchor-flow).

The SDF Anchor Platform 2.10.1 reference observer streams Horizon's `payments()` endpoint and converts only `PaymentOperationResponse` and `PathPaymentBaseOperationResponse` into observed payments. Other operation response types do not reach its payment listeners. `CreateClaimableBalance` is a separate operation type, so that observer cannot use it as the incoming SEP-31 payment. [Anchor Platform 2.10.1 `StellarPaymentObserver`](https://github.com/stellar/anchor-platform/blob/2.10.1/platform/src/main/java/org/stellar/anchor/platform/observer/stellar/StellarPaymentObserver.java#L138-L151) and [event dispatch](https://github.com/stellar/anchor-platform/blob/2.10.1/platform/src/main/java/org/stellar/anchor/platform/observer/stellar/StellarPaymentObserver.java#L357-L397).

As a real-anchor example, AnchorUSD's published deposit-intent API asks for a Stellar account and exposes `memo` and `memo_type` fields for the associated payment. Its docs do not say that it accepts a claimable balance in place of that payment; this is evidence of the documented memo-based flow, not a claim that AnchorUSD has no private or bespoke support. [AnchorUSD API reference](https://dashboard.anchorusd.com/docs/api#create-deposit-intent).

**Conclusion:** generic SEP-31 support is not established. A bespoke adapter would need written agreement from the anchor, an explicit capability, and an observer/reconciliation path keyed by claimable-balance ID or another agreed reference.

## Reserve, fee, and timeout

Stellar's current base reserve is 0.5 XLM per claimable-balance claimant. The proposed balance has two claimants, so it holds 1 XLM of reserve while the balance exists; claiming it releases that reserve. Transaction fees are separate and depend on the submitted fee bid and network conditions. [Stellar Docs: Lumens and base reserves](https://developers.stellar.org/docs/learn/fundamentals/lumens#base-reserves).

The predicates can be expressed as:

- Anchor: may claim before absolute time `T`.
- Sender: may claim when `not(before_absolute_time(T))`, meaning at or after `T`.

The protocol permits a chosen absolute-time cutoff, but a short cutoff does not cancel an anchor's external payout. A sender reclaim could race an anchor that has already started an irreversible payout. `T` therefore needs to exceed that specific anchor's measured payout and dispute window; there is no safe generic timeout to recommend from this spike. The probe uses a short test-only timeout to exercise the sender predicate, not as a production value. [Stellar Docs: Create Claimable Balance operation](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/operations/object/create-claimable-balance).

## Engine impact if a bespoke anchor opts in

The current engine already dispatches settlement through `SettlementStrategy`, and RFC 0001 names `claimable_balance` as a possible settlement kind. The current `DepositInstructionsKind` union still contains only `stellar_payment`, and `SettlementRef` stores a transaction hash rather than a claimable-balance ID. An opt-in implementation would need a typed deposit-instruction kind, an adapter capability that rejects unsupported anchors, a strategy that creates and persists the claimable-balance ID and deadline, and a reconciliation path that confirms the anchor's payout separately from on-chain entry creation. [RFC 0001](rfcs/0001-protocol-agnostic-corridors.md), [`SettlementStrategy` and instruction kinds](../packages/engine/src/ports.ts), [`SettlementRef`](../packages/engine/src/ports.ts).

The existing `settled` state can continue to mean that the on-chain settlement entry was created, but that state must not be interpreted as the receiving anchor having paid the end recipient. A reclaim path needs an idempotent chain operation after `T` and a durable distinction between “anchor payout pending”, “anchor payout complete”, and “balance reclaimed”. Do not retry settlement after an ambiguous create submission; reconcile by transaction hash before resubmitting. This preserves the no-double-submit invariant in [RFC 0001](rfcs/0001-protocol-agnostic-corridors.md#invariants).

## Testnet probe

`scripts/claimable-balance-probe.ts` creates an ephemeral sender funded by Stellar Friendbot unless `TESTNET_SENDER_SECRET` is supplied. It submits a 1 XLM claimable balance with the two predicates above, queries the transaction's Horizon operation and `/payments?for_transaction=...` result, waits until the test cutoff, and reclaims the balance with the sender key. It prints public keys, transaction hashes, operation types, and the payment-endpoint count; it never prints a secret. The short cutoff is a test fixture only.

Run the local Anchor Platform reference stack first, then run the probe:

```sh
scripts/reference-anchor.sh up
pnpm tsx scripts/claimable-balance-probe.ts
```

Testnet run (7 Oct 2026, Stellar testnet): the reference Anchor Platform 2.10.1 stack started with its observer cursor at ledger `5068172`. The probe created a 1 XLM balance at ledger `5068229`; Horizon reported a `100`-stroop creation fee and operation paging token `21767877803655169`. [Transaction](https://horizon-testnet.stellar.org/transactions/e63ab3ffd3c3e7a84c114fd7fbe0e646decc780e52769888621235b096febd08) · [claimable balance](https://horizon-testnet.stellar.org/claimable_balances/00000000bbde36fd503f5765e601cb9fb2837630cc6d29dde79690490c8621683d070a0c).

The transaction's only operation was `create_claimable_balance`; its two predicates appeared in Horizon as the anchor's `abs_before` and the sender's `not(abs_before)`. The AP observer log did not contain the balance operation's paging token. The first event it logged after that token was `create_account` at `21767877803659265`, followed by other operations; the claimable-balance operation itself was not in the Horizon payments stream consumed by the observer. This matches the source-level operation dispatch above. It confirms that this observer did not surface the test balance as an incoming payment; it does not test an anchor-specific bespoke integration.

After `T`, the sender reclaimed the balance successfully in ledger `5068248` with a separate `100`-stroop fee: [reclaim transaction](https://horizon-testnet.stellar.org/transactions/4fd27f8748a66a011508681df06b57755269c1362ce6c954380c75476459d662). Horizon then returned HTTP 404 for the consumed claimable-balance ID. The 90-second test timeout is deliberately shorter than any credible payout window and must not be reused in production.

## Recommendation

Reject claimable balances as a replacement for the generic SEP-31 deposit payment. Consider them only for bespoke anchor adapters that explicitly accept them, identify them, and provide an agreed payout/reclaim reconciliation contract.
