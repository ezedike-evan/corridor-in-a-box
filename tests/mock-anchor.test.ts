// Drives the engine end to end against the scriptable mock anchor
// (examples/mock-anchor): no network, no Stellar payment, no containers.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { Sep10Client } from "@corridor/adapter-kit";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { Sep31Adapter } from "@corridor/sep31";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  execute,
  type EngineDeps,
  type SettlementSubmitter,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";
import {
  SCENARIOS,
  startMockAnchor,
  type MockAnchor,
  type Scenario,
} from "../examples/mock-anchor/server";

const MANIFEST = new URL("../corridors/mock.corridor.yaml", import.meta.url).pathname;

let anchor: MockAnchor;

beforeEach(async () => {
  anchor = await startMockAnchor();
});

afterEach(async () => {
  await anchor.close();
});

/** The shipped manifest, repointed from its fixed port to this test's server. */
function corridor(): Corridor {
  const loaded = loadCorridor(MANIFEST);
  if (!loaded.ok) throw new Error(`mock manifest failed to load: ${loaded.error.message}`);
  const e = loaded.value.dest.endpoints;
  if (!("transfer_server_sep31" in e)) throw new Error("mock manifest is not SEP-31");
  return {
    ...loaded.value,
    // Shorter windows than the shipped ones, so the polling that waits out a stall or an
    // unreported refund (one real HTTP call per fake 2s) stays a handful of calls.
    recovery: { ...loaded.value.recovery, timeout_seconds: 60, refund_wait_seconds: 20 },
    dest: {
      ...loaded.value.dest,
      endpoints: {
        ...e,
        home_domain: new URL(anchor.url).host,
        transfer_server_sep31: `${anchor.url}/sep31`,
        web_auth: `${anchor.url}/auth`,
        kyc_server: `${anchor.url}/sep12`,
        quote_server: `${anchor.url}/sep38`,
      },
    },
  } as Corridor;
}

const intent = (key: string): PaymentIntent => ({
  idempotencyKey: key,
  corridorId: "mock",
  sender: { id: "sender", anchorCustomerId: "cust-sender" },
  recipient: { id: "recipient", anchorCustomerId: "cust-recipient" },
  sourceAmount: { asset: "USDC", amount: "10.00" },
});

interface Harness {
  run: () => ReturnType<typeof execute>;
  settled: () => number;
}

/**
 * An engine wired to the mock anchor. The mock submitter stands in for the chain,
 * and then tells the anchor the payment arrived, which is what a real anchor
 * learns from Horizon. The clock is fake, so a stalled run times out instantly.
 */
function harness(key: string, scenario: Scenario): Harness {
  anchor.setScenario(scenario);
  const c = corridor();
  const adapter = new Sep31Adapter(c);
  const inner = createMockSubmitter();
  let settled = 0;
  const submitter: SettlementSubmitter = {
    ...inner,
    submit: async (req) => {
      const r = await inner.submit(req);
      if (r.ok) {
        settled += 1;
        anchor.markReceived();
      }
      return r;
    },
  };
  let t = Date.now();
  const deps: EngineDeps = {
    resolver: new StaticRouteResolver(() => adapter, {
      trustManifestWithoutAttestation: true,
    }),
    submitter,
    gate: { evaluate: async () => ({ passed: true, results: [] }) },
    idempotency: new InMemoryIdempotencyStore(),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { run: () => execute(intent(key), c, deps), settled: () => settled };
}

describe("mock anchor: the protocol surface", () => {
  it("publishes a stellar.toml naming its own endpoints", async () => {
    const res = await fetch(`${anchor.url}/.well-known/stellar.toml`);
    const toml = await res.text();
    expect(res.status).toBe(200);
    expect(toml).toContain(`WEB_AUTH_ENDPOINT="${anchor.url}/auth"`);
    expect(toml).toContain(`DIRECT_PAYMENT_SERVER="${anchor.url}/sep31"`);
  });

  it("completes a SEP-10 handshake for a signer and hands back a JWT with an expiry", async () => {
    const key = Keypair.random();
    const client = new Sep10Client(`${anchor.url}/auth`, new URL(anchor.url).host, {
      account: key.publicKey(),
      signChallenge: async (xdr, passphrase) => {
        const tx = TransactionBuilder.fromXDR(xdr, passphrase);
        tx.sign(key);
        return tx.toXDR();
      },
    });
    const token = await client.token();
    expect(token.ok).toBe(true);
    if (token.ok) expect(token.value?.split(".")).toHaveLength(3);
  });

  it("refuses a challenge that was never signed by the client", async () => {
    const key = Keypair.random();
    const challenge = (await (
      await fetch(`${anchor.url}/auth?account=${key.publicKey()}`)
    ).json()) as { transaction: string };
    const res = await fetch(`${anchor.url}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: challenge.transaction }),
    });
    expect(res.status).toBe(400);
  });

  it("switches scenario over the control endpoint and rejects unknown ones", async () => {
    const post = (scenario: string) =>
      fetch(`${anchor.url}/__control/scenario`, {
        method: "POST",
        body: JSON.stringify({ scenario }),
      });
    expect((await post("stall")).status).toBe(200);
    expect((await post("explode")).status).toBe(400);
  });

  it("lists every scenario the issue names", () => {
    expect([...SCENARIOS].sort()).toEqual(
      [
        "error_after_settle",
        "happy",
        "kyc_reject",
        "quote_expired",
        "refund_full",
        "refund_partial",
        "slow_pending_external",
        "stall",
      ].sort(),
    );
  });
});

describe("mock anchor: execute() through the scenarios", () => {
  it("happy: runs to completed and settles exactly once", async () => {
    const h = harness("mock-happy", "happy");
    const r = await h.run();
    expect(r.ok && r.value.state).toBe("completed");
    expect(h.settled()).toBe(1);
  });

  it("slow_pending_external: waits out pending_external, then completes", async () => {
    const h = harness("mock-slow", "slow_pending_external");
    const r = await h.run();
    expect(r.ok && r.value.state).toBe("completed");
  });

  it("kyc_reject: refuses before opening a transaction, so no money moves", async () => {
    const h = harness("mock-kyc", "kyc_reject");
    const r = await h.run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("KYC_REJECTED");
    expect(h.settled()).toBe(0);
    expect(anchor.transactionIds()).toHaveLength(0);
  });

  it("quote_expired: does not settle on a quote that has already expired", async () => {
    const h = harness("mock-quote", "quote_expired");
    const r = await h.run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUOTE_EXPIRED");
    expect(h.settled()).toBe(0);
  });

  it("stall: never completes, and the run is stopped rather than polled forever", async () => {
    const h = harness("mock-stall", "stall");
    const r = await h.run();
    expect(h.settled()).toBe(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_STALLED");
  });

  it("error_after_settle: money moved, the anchor errored, and the run is flagged, not completed", async () => {
    const h = harness("mock-error", "error_after_settle");
    const r = await h.run();
    expect(h.settled()).toBe(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_MISMATCH");
  });

  it.each(["refund_full", "refund_partial"] as const)(
    "%s: the anchor refunds, and the run is flagged, not completed",
    async (scenario) => {
      const h = harness(`mock-${scenario}`, scenario);
      const r = await h.run();
      expect(h.settled()).toBe(1);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("RECONCILE_MISMATCH");
    },
  );
});
