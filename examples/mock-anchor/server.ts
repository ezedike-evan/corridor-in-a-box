// A small, scriptable mock anchor for local development and tests.
//
//   pnpm mock:anchor [--port 8089] [--scenario happy] [--receive-after-polls 2]
//
// It speaks just enough SEP-1 (stellar.toml), SEP-10, SEP-12, SEP-31 and SEP-38
// for the engine to run a whole corridor against it (`corridors/mock.corridor.yaml`),
// and it misbehaves on request, which is the point: a stalled `pending_sender`, a
// KYC rejection, a post-settle `error`, or a partial refund can be reproduced on
// demand instead of waited for. No real Stellar payment is needed: the server
// marks a transaction as received when told (`markReceived`, or the control
// endpoint), or by itself after `receiveAfterPolls` status polls.
//
// The statuses it emits are the ones `mapSep31Status` (packages/sep31) classifies.
//
// Scenario is the server-wide default, set at start or with
// `POST /__control/scenario {"scenario": "..."}`, and can be overridden for one
// transaction with an `x-mock-scenario` header on `POST /sep31/transactions`.
//
// NOT A SECURITY BOUNDARY. It signs nothing real, accepts any client, and listens
// on loopback by default. Never expose it.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";

export const SCENARIOS = [
  "happy",
  "stall",
  "kyc_reject",
  "quote_expired",
  "error_after_settle",
  "refund_full",
  "refund_partial",
  "slow_pending_external",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const isScenario = (s: unknown): s is Scenario =>
  typeof s === "string" && (SCENARIOS as readonly string[]).includes(s);

/** The Anchor Platform docs' testnet USDC issuer, as in corridors/reference.corridor.yaml. */
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export interface MockAnchorOptions {
  /** 0 picks a free port. Default 0. */
  port?: number;
  /** Bind address. Default loopback. */
  host?: string;
  /** Default scenario. Default `happy`. */
  scenario?: Scenario;
  /**
   * Treat a transaction as received after this many status polls, so the whole
   * flow runs with no one calling `markReceived`. Unset: wait to be told.
   */
  receiveAfterPolls?: number;
  /** Polls spent in `pending_external` by `slow_pending_external`. Default 5. */
  slowPolls?: number;
}

interface Tx {
  id: string;
  scenario: Scenario;
  amount: string;
  memo: string;
  /** Status polls seen; drives `receiveAfterPolls`. */
  polls: number;
  /** Polls seen since the payment was marked received; drives the post-receipt statuses. */
  sinceReceived: number | undefined;
}

export interface MockAnchor {
  /** Base URL, e.g. `http://127.0.0.1:8089`. */
  readonly url: string;
  readonly port: number;
  /** Ids of every transaction opened so far, oldest first. */
  transactionIds(): string[];
  setScenario(scenario: Scenario): void;
  /** Mark one transaction (or, with no id, every open one) as paid. */
  markReceived(id?: string): void;
  close(): Promise<void>;
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export async function startMockAnchor(opts: MockAnchorOptions = {}): Promise<MockAnchor> {
  const serverKey = Keypair.random();
  const depositKey = Keypair.random();
  const txs = new Map<string, Tx>();
  const customers = new Map<string, "ACCEPTED" | "REJECTED">();
  let scenario: Scenario = opts.scenario ?? "happy";
  const slowPolls = opts.slowPolls ?? 5;
  let baseUrl = "";

  const record = (tx: Tx) => {
    tx.polls += 1;
    if (tx.sinceReceived === undefined && opts.receiveAfterPolls !== undefined) {
      if (tx.polls > opts.receiveAfterPolls) tx.sinceReceived = 0;
    }
    const afterReceipt = tx.sinceReceived;
    if (afterReceipt !== undefined) tx.sinceReceived = afterReceipt + 1;
    const n = afterReceipt === undefined ? undefined : afterReceipt + 1;

    let status = "pending_sender";
    let refunds: unknown;
    if (n !== undefined) {
      switch (tx.scenario) {
        case "stall":
          status = "pending_sender";
          break;
        case "slow_pending_external":
          status = n <= slowPolls ? "pending_external" : "completed";
          break;
        case "error_after_settle":
          status = n < 2 ? "pending_receiver" : "error";
          break;
        case "refund_full":
        case "refund_partial":
          if (n < 2) {
            status = "pending_receiver";
          } else {
            status = "refunded";
            const refunded =
              tx.scenario === "refund_full" ? tx.amount : (Number(tx.amount) / 2).toFixed(2);
            refunds = {
              amount_refunded: refunded,
              amount_fee: "0",
              payments: [
                { id: `refund-${tx.id}`, id_type: "external", amount: refunded, fee: "0" },
              ],
            };
          }
          break;
        default:
          status = n < 2 ? "pending_receiver" : "completed";
      }
    }
    return {
      transaction: {
        id: tx.id,
        status,
        amount_in: tx.amount,
        stellar_account_id: depositKey.publicKey(),
        stellar_memo: tx.memo,
        stellar_memo_type: "text",
        ...(refunds ? { refunds } : {}),
      },
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", baseUrl || "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const homeDomain = new URL(baseUrl).host;

    // --- SEP-1 ---
    if (method === "GET" && path === "/.well-known/stellar.toml") {
      return send(
        res,
        200,
        [
          `NETWORK_PASSPHRASE="${Networks.TESTNET}"`,
          `SIGNING_KEY="${serverKey.publicKey()}"`,
          `WEB_AUTH_ENDPOINT="${baseUrl}/auth"`,
          `KYC_SERVER="${baseUrl}/sep12"`,
          `DIRECT_PAYMENT_SERVER="${baseUrl}/sep31"`,
          `ANCHOR_QUOTE_SERVER="${baseUrl}/sep38"`,
          "",
          "[[CURRENCIES]]",
          'code="USDC"',
          `issuer="${USDC_ISSUER}"`,
          "",
        ].join("\n"),
        "text/plain",
      );
    }

    // --- SEP-10 ---
    if (path === "/auth" && method === "GET") {
      const account = url.searchParams.get("account");
      if (!account) return send(res, 400, { error: "account is required" });
      try {
        const transaction = WebAuth.buildChallengeTx(
          serverKey,
          account,
          url.searchParams.get("home_domain") ?? homeDomain,
          300,
          Networks.TESTNET,
          homeDomain,
        );
        return send(res, 200, { transaction, network_passphrase: Networks.TESTNET });
      } catch (e) {
        return send(res, 400, { error: e instanceof Error ? e.message : "bad account" });
      }
    }
    if (path === "/auth" && method === "POST") {
      const body = await readJson(req);
      try {
        const challenge = String(body.transaction ?? "");
        const { clientAccountID } = WebAuth.readChallengeTx(
          challenge,
          serverKey.publicKey(),
          Networks.TESTNET,
          homeDomain,
          homeDomain,
        );
        WebAuth.verifyChallengeTxSigners(
          challenge,
          serverKey.publicKey(),
          Networks.TESTNET,
          [clientAccountID],
          homeDomain,
          homeDomain,
        );
        const now = Math.floor(Date.now() / 1000);
        const token = [
          b64url({ alg: "none", typ: "JWT" }),
          b64url({ iss: baseUrl, sub: clientAccountID, iat: now, exp: now + 900 }),
          "mock",
        ].join(".");
        return send(res, 200, { token });
      } catch (e) {
        return send(res, 400, { error: e instanceof Error ? e.message : "bad challenge" });
      }
    }

    // --- SEP-12 ---
    if (path === "/sep12/customer") {
      if (method === "PUT") {
        await readJson(req);
        const id = `cust-${randomUUID()}`;
        customers.set(id, scenario === "kyc_reject" ? "REJECTED" : "ACCEPTED");
        return send(res, 202, { id });
      }
      if (method === "GET") {
        const id = url.searchParams.get("id");
        const status = id ? customers.get(id) : undefined;
        // An id this server never issued (the usual case in a test) takes the
        // scenario's default rather than a 404, so no PUT is needed first.
        return send(res, 200, {
          id: id ?? "unknown",
          status: status ?? (scenario === "kyc_reject" ? "REJECTED" : "ACCEPTED"),
        });
      }
    }

    // --- SEP-38 ---
    if (path === "/sep38/quote" && method === "POST") {
      const body = await readJson(req);
      const sell = String(body.sell_amount ?? "");
      if (!/^\d+(\.\d+)?$/.test(sell)) return send(res, 400, { error: "bad sell_amount" });
      const expires = Date.now() + (scenario === "quote_expired" ? -1_000 : 60_000);
      return send(res, 201, {
        id: `quote-${randomUUID()}`,
        price: "1.00",
        total_price: "1.00",
        expires_at: new Date(expires).toISOString(),
        sell_asset: body.sell_asset,
        buy_asset: body.buy_asset,
        sell_amount: sell,
        buy_amount: sell,
        fee: { total: "0.00", asset: String(body.sell_asset ?? "") },
      });
    }

    // --- SEP-31 ---
    if (path === "/sep31/info" && method === "GET") {
      return send(res, 200, {
        receive: {
          USDC: {
            enabled: true,
            min_amount: "1",
            max_amount: "100000",
            fee_fixed: "0",
            fee_percent: "0",
            sender_sep12_type: "sep31-sender",
            receiver_sep12_type: "sep31-receiver",
            fields: { transaction: {} },
          },
        },
      });
    }
    if (path === "/sep31/transactions" && method === "POST") {
      const body = await readJson(req);
      const amount = String(body.amount ?? "");
      if (!/^\d+(\.\d+)?$/.test(amount) || !body.receiver_id) {
        return send(res, 400, { error: "amount and receiver_id are required" });
      }
      const header = req.headers["x-mock-scenario"];
      const tx: Tx = {
        id: `tx-${randomUUID()}`,
        scenario: isScenario(header) ? header : scenario,
        amount,
        memo: randomUUID().replace(/-/g, "").slice(0, 20),
        polls: 0,
        sinceReceived: undefined,
      };
      txs.set(tx.id, tx);
      return send(res, 201, {
        id: tx.id,
        stellar_account_id: depositKey.publicKey(),
        stellar_memo_type: "text",
        stellar_memo: tx.memo,
      });
    }
    const m = path.match(/^\/sep31\/transactions\/([^/]+)$/);
    if (m && method === "GET") {
      const tx = txs.get(m[1]!);
      return tx ? send(res, 200, record(tx)) : send(res, 404, { error: "not found" });
    }

    // --- control ---
    if (path === "/__control/scenario" && method === "POST") {
      const body = await readJson(req);
      if (!isScenario(body.scenario)) {
        return send(res, 400, { error: `scenario must be one of ${SCENARIOS.join(", ")}` });
      }
      scenario = body.scenario;
      return send(res, 200, { scenario });
    }
    const rec = path.match(/^\/__control\/received(?:\/([^/]+))?$/);
    if (rec && method === "POST") {
      markReceived(rec[1]);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not found" });
  };

  const markReceived = (id?: string) => {
    for (const tx of id ? [txs.get(id)] : txs.values()) {
      if (tx && tx.sinceReceived === undefined) tx.sinceReceived = 0;
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent)
        send(res, 500, { error: e instanceof Error ? e.message : "error" });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  baseUrl = `http://${opts.host ?? "127.0.0.1"}:${port}`;

  return {
    url: baseUrl,
    port,
    transactionIds: () => [...txs.keys()],
    setScenario: (s) => {
      scenario = s;
    },
    markReceived,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
