// Fund a testnet sending account with the bridge asset, so `pnpm testnet` has
// something to settle with.
//
//   CORRIDOR_SIGNER_SECRET=S... pnpm fund:testnet
//
// A friendbot-funded account holds XLM and nothing else, so the settle leg fails
// with `op_src_no_trust` the moment a corridor's bridge asset is a credit asset.
// This adds the trustline and pulls a small amount from the Anchor Platform
// reference server's own test distribution account.
//
// ABOUT THAT SECRET: it is not a leak. `SAJW2O2N…` is published in the public
// `stellar/anchor-platform` Docker image at `/config/reference-config.yaml` as
// test material for exactly this purpose, and the account exists only on
// testnet. It is hardcoded here rather than read from the image so the script
// works without the container running. Never reuse this pattern for a real key:
// production signing goes through an ExternalSigner (docs/key-management.md).

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const AMOUNT = process.env.FUND_AMOUNT ?? "100";

/** The reference server's test distribution account (testnet, public config). */
const DISTRIBUTION_SECRET =
  process.env.DISTRIBUTION_SECRET ??
  "SAJW2O2NH5QMMVWYAN352OEXS2RUY675A2HPK5HEG2FRR2NXPYA4OLYN";
/** Circle's testnet USDC issuer, as configured in the reference server's assets.yaml. */
const ASSET_CODE = process.env.BRIDGE_ASSET ?? "USDC";
const ASSET_ISSUER =
  process.env.BRIDGE_ASSET_ISSUER ??
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

async function main(): Promise<void> {
  if (!HORIZON.includes("testnet")) {
    console.error(`✗ refusing to run against ${HORIZON} — testnet only.`);
    process.exit(3);
  }
  const secret = process.env.CORRIDOR_SIGNER_SECRET;
  if (!secret) {
    console.error("✗ set CORRIDOR_SIGNER_SECRET to the account you want funded");
    process.exit(2);
  }

  const server = new Horizon.Server(HORIZON);
  const receiver = Keypair.fromSecret(secret);
  const distributor = Keypair.fromSecret(DISTRIBUTION_SECRET);
  const asset = new Asset(ASSET_CODE, ASSET_ISSUER);

  console.log(`receiver:    ${receiver.publicKey()}`);
  console.log(`asset:       ${ASSET_CODE}:${ASSET_ISSUER.slice(0, 8)}…`);

  // 1. Trustline. Without it the account cannot hold the asset at all, which is
  //    what `op_src_no_trust` on the settle leg actually means.
  const receiverAccount = await server.loadAccount(receiver.publicKey());
  const hasTrustline = receiverAccount.balances.some(
    (b) => "asset_code" in b && b.asset_code === ASSET_CODE && b.asset_issuer === ASSET_ISSUER,
  );
  if (hasTrustline) {
    console.log("trustline:   already present");
  } else {
    const tx = new TransactionBuilder(receiverAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(60)
      .build();
    tx.sign(receiver);
    await server.submitTransaction(tx);
    console.log("trustline:   created");
  }

  // 2. Move the asset across.
  const distributorAccount = await server.loadAccount(distributor.publicKey());
  const payment = new TransactionBuilder(distributorAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: receiver.publicKey(), asset, amount: AMOUNT }),
    )
    .setTimeout(60)
    .build();
  payment.sign(distributor);
  const sent = await server.submitTransaction(payment);

  console.log(`funded:      ${AMOUNT} ${ASSET_CODE}`);
  console.log(`tx:          ${sent.hash}`);
  console.log(`\nNext: pnpm testnet`);
}

main().catch((e) => {
  const extras = e?.response?.data?.extras?.result_codes;
  console.error(extras ? `✗ ${JSON.stringify(extras)}` : e);
  process.exit(1);
});
