import { Networks, Operation, TransactionBuilder, Keypair, Asset } from "@stellar/stellar-sdk";

const horizon = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const senderSecret = process.env.TESTNET_SENDER_SECRET;
const destination = process.env.CLAIMABLE_BALANCE_DESTINATION;

if (!senderSecret || !destination) {
  console.error("Set TESTNET_SENDER_SECRET and CLAIMABLE_BALANCE_DESTINATION to run the probe.");
  process.exit(2);
}

const server = new (await import("@stellar/stellar-sdk")).Horizon.Server(horizon);
const sender = Keypair.fromSecret(senderSecret);
const account = await server.loadAccount(sender.publicKey());
const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.createClaimableBalance({ asset: Asset.native(), amount: "1", claimants: [{ destination, predicate: { not: { abs_before: { condition: "abs_before", timestamp: Math.floor(Date.now() / 1000) + 3600 } } } }] }))
  .setTimeout(60).build();
tx.sign(sender);
const result = await server.submitTransaction(tx);
console.log(JSON.stringify({ hash: result.hash, horizon, destination, observer: "run reference-anchor observer and record whether the balance is correlated without a memo" }, null, 2));
