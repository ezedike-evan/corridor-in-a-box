import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(horizonUrl);
const reclaimAfterSeconds = Number(process.env.RECLAIM_AFTER_SECONDS ?? "90");
const configuredSecret = process.env.TESTNET_SENDER_SECRET;
const configuredAnchor = process.env.ANCHOR_CLAIMANT;
const sender = configuredSecret ? Keypair.fromSecret(configuredSecret) : Keypair.random();
const anchor = configuredAnchor ? undefined : Keypair.random();
const anchorClaimant = configuredAnchor ?? anchor!.publicKey();

if (!horizonUrl.includes("testnet")) {
  throw new Error(
    "This probe is restricted to Stellar testnet. Set STELLAR_HORIZON_URL to a testnet Horizon URL.",
  );
}
if (
  !Number.isInteger(reclaimAfterSeconds) ||
  reclaimAfterSeconds < 60 ||
  reclaimAfterSeconds > 3600
) {
  throw new Error("RECLAIM_AFTER_SECONDS must be an integer from 60 to 3600.");
}

async function fundFromFriendbot(publicKey: string): Promise<void> {
  const response = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    throw new Error(
      `Friendbot failed with HTTP ${response.status}; fund ${publicKey} or set the corresponding environment variable.`,
    );
  }
}

if (!configuredSecret) await fundFromFriendbot(sender.publicKey());
if (!configuredAnchor) await fundFromFriendbot(anchorClaimant);

const deadline = Math.floor(Date.now() / 1000) + reclaimAfterSeconds;
const deadlineText = String(deadline);
const senderClaimant = new Claimant(
  sender.publicKey(),
  Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(deadlineText)),
);
const anchorTimeLimitedClaimant = new Claimant(
  anchorClaimant,
  Claimant.predicateBeforeAbsoluteTime(deadlineText),
);

const senderAccount = await horizon.loadAccount(sender.publicKey());
const createTx = new TransactionBuilder(senderAccount, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(
    Operation.createClaimableBalance({
      asset: Asset.native(),
      amount: "1",
      claimants: [anchorTimeLimitedClaimant, senderClaimant],
    }),
  )
  .setTimeout(30)
  .build();
createTx.sign(sender);

const created = await horizon.submitTransaction(createTx);
const operationsResponse = await fetch(
  `${horizonUrl}/transactions/${encodeURIComponent(created.hash)}/operations`,
);
if (!operationsResponse.ok) {
  throw new Error(
    `Could not read submitted operations: Horizon returned HTTP ${operationsResponse.status}.`,
  );
}
const operationsBody = (await operationsResponse.json()) as {
  _embedded: { records: Array<{ type: string; paging_token: string }> };
};
const createOperation = operationsBody._embedded.records.find(
  (operation) => operation.type === "create_claimable_balance",
);
if (!createOperation)
  throw new Error("Horizon did not return the CreateClaimableBalance operation.");

const balancesResponse = await fetch(
  `${horizonUrl}/claimable_balances?claimant=${encodeURIComponent(sender.publicKey())}&order=desc&limit=200`,
);
if (!balancesResponse.ok) {
  throw new Error(
    `Could not query the created claimable balance: Horizon returned HTTP ${balancesResponse.status}.`,
  );
}
const balancesBody = (await balancesResponse.json()) as {
  _embedded: {
    records: Array<{
      id: string;
      amount: string;
      asset: string;
      claimants: Array<{
        destination: string;
        predicate: { abs_before_epoch?: string; not?: unknown };
      }>;
    }>;
  };
};
const balance = balancesBody._embedded.records.find(
  (candidate) =>
    candidate.amount === "1.0000000" &&
    candidate.asset === "native" &&
    candidate.claimants.some(
      (claimant) =>
        claimant.destination === anchorClaimant &&
        claimant.predicate.abs_before_epoch === deadlineText,
    ) &&
    candidate.claimants.some(
      (claimant) =>
        claimant.destination === sender.publicKey() && claimant.predicate.not !== undefined,
    ),
);
if (!balance)
  throw new Error("Horizon did not return the new balance with both expected predicates.");

const txResponse = await fetch(
  `${horizonUrl}/transactions/${encodeURIComponent(created.hash)}`,
);
if (!txResponse.ok)
  throw new Error(
    `Could not read transaction fee: Horizon returned HTTP ${txResponse.status}.`,
  );
const txBody = (await txResponse.json()) as {
  fee_charged: string;
  ledger: number;
  created_at: string;
};

console.log(
  JSON.stringify(
    {
      network: "testnet",
      transactionHash: created.hash,
      ledger: txBody.ledger,
      createdAt: txBody.created_at,
      feeChargedStroops: txBody.fee_charged,
      operationType: createOperation.type,
      operationPagingToken: createOperation.paging_token,
      claimableBalanceId: balance.id,
      amount: `${balance.amount} XLM`,
      claimants: balance.claimants,
      reclaimAfter: new Date(deadline * 1000).toISOString(),
    },
    null,
    2,
  ),
);

const remainingMs = deadline * 1000 - Date.now() + 6000;
if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));

const reclaimAccount = await horizon.loadAccount(sender.publicKey());
const reclaimTx = new TransactionBuilder(reclaimAccount, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.claimClaimableBalance({ balanceId: balance.id }))
  .setTimeout(30)
  .build();
reclaimTx.sign(sender);
const reclaimed = await horizon.submitTransaction(reclaimTx);
console.log(
  JSON.stringify(
    { reclaimedBy: sender.publicKey(), reclaimTransactionHash: reclaimed.hash },
    null,
    2,
  ),
);
