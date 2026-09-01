// Opt-in integration test against a REAL SEP-31 receiving anchor (e.g. the
// Anchor Platform reference server on testnet). It is SKIPPED unless the anchor
// env vars are set, so it never runs in the default `pnpm test` or in CI.
//
// Run it (see .env.example for the full list):
//
//   ANCHOR_HOME_DOMAIN=anchor.example \
//   ANCHOR_SEP31_TRANSFER_SERVER=https://anchor.example/sep31 \
//   ANCHOR_SEP31_QUOTE_SERVER=https://anchor.example/sep38 \
//   ANCHOR_SEP31_WEB_AUTH=https://anchor.example/auth \
//   CORRIDOR_SIGNER_SECRET=S...   # testnet only; enables SEP-10 auth \
//   pnpm exec vitest run tests/integration/sep31-live.test.ts
//
// The default cases are READ-ONLY: they exercise SEP-10 auth, the SEP-38 quote,
// and the conformance probes without opening a transaction or moving funds.
//
// One further case DOES move money, and is therefore behind its own explicit
// gate on top of the anchor/signer ones: it runs a full execute() and asserts
// the run reaches the terminal state `completed` — the claim the roadmap will
// not make until something checks it. Enable it with:
//
//   CORRIDOR_LIVE_SETTLEMENT=1 \
//   RECIPIENT_SEP12_ID=… SENDER_SEP12_ID=…   # ids this anchor issued \
//   HORIZON_URL=https://horizon-testnet.stellar.org \
//   pnpm exec vitest run tests/integration/sep31-live.test.ts
//
// The manual end-to-end capture it automates is documented in docs/operations.md.

import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { Sep31Adapter } from "@corridor/sep31";
import { conformanceSuite } from "@corridor/adapter-kit";
import {
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
} from "@corridor/stellar";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  execute,
  type CorridorState,
  type EngineDeps,
} from "@corridor/engine";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentIntent } from "@corridor/types";

const env = process.env;
const transferServer = env.ANCHOR_SEP31_TRANSFER_SERVER;
const homeDomain = env.ANCHOR_HOME_DOMAIN;
const hasAnchor = Boolean(transferServer && homeDomain);
// Separate gate from hasAnchor, deliberately. Every assertion below goes
// through SEP-38 or SEP-12, and a real anchor answers both with 403 unless the
// request carries a SEP-10 JWT — so without a signer these do not test the
// adapter, they test that an anchor rejects anonymous callers. `||` not `??`:
// CI passes an unset secret through as an empty string.
const hasSigner = Boolean(env.CORRIDOR_SIGNER_SECRET || "");

function liveCorridor(): Corridor {
  const endpoints: Record<string, string> = {
    home_domain: homeDomain as string,
    transfer_server_sep31: transferServer as string,
  };
  if (env.ANCHOR_SEP31_QUOTE_SERVER) endpoints.quote_server = env.ANCHOR_SEP31_QUOTE_SERVER;
  if (env.ANCHOR_SEP31_WEB_AUTH) endpoints.web_auth = env.ANCHOR_SEP31_WEB_AUTH;
  if (env.ANCHOR_SEP31_KYC_SERVER) endpoints.kyc_server = env.ANCHOR_SEP31_KYC_SERVER;

  const r = parseCorridor({
    id: "integration-live",
    source: { name: "Source", asset: "USDC", endpoints: { home_domain: "source.local" } },
    // `||` not `??`: CI passes unset secrets through as empty strings.
    dest: { name: homeDomain, asset: env.ANCHOR_DEST_ASSET || "iso4217:USD", endpoints },
    fx: { path: ["USDC", "USDC"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "US" },
    settlement: { network: "testnet", asset_issuer: env.ANCHOR_ASSET_ISSUER || "GTEST" },
    recovery: {},
  });
  if (!r.ok) throw new Error(`invalid live corridor fixture: ${r.error.message}`);
  return r.value;
}

function adapterFor(c: Corridor): Sep31Adapter {
  const secret = env.CORRIDOR_SIGNER_SECRET;
  const sep10 = secret ? new StellarSep10Signer(Keypair.fromSecret(secret)) : undefined;
  return new Sep31Adapter(c, { sep10 });
}

// A SEP-12 customer id issued by THIS anchor for the receiver. There is no way
// to obtain one read-only — it comes back from `PUT /customer`, a write, and
// this suite deliberately performs none. So it has to be supplied, and when it
// is absent the compliance probe is not run rather than counted as a failure:
// `ensureCompliance` correctly refuses to settle on a recipient it cannot
// identify, and asserting that a fail-closed control fails closed proves
// nothing about the anchor's conformance.
const recipientSep12Id = env.ANCHOR_RECIPIENT_SEP12_ID || undefined;

const intent: PaymentIntent = {
  idempotencyKey: `integration-${Date.now()}`,
  corridorId: "integration-live",
  sender: { id: "integration-sender" },
  recipient: {
    id: env.ANCHOR_RECIPIENT_ID || "integration-recipient",
    ...(recipientSep12Id ? { sep12Id: recipientSep12Id } : {}),
  },
  sourceAmount: { asset: "USDC", amount: env.ANCHOR_AMOUNT || "10" },
};

describe.skipIf(!hasAnchor)("SEP-31 live anchor (read-only)", () => {
  it.skipIf(!hasSigner)("returns a firm quote with a future expiry", async () => {
    const c = liveCorridor();
    if (!c.dest.endpoints.quote_server) {
      // No SEP-38 server configured for this anchor — nothing to assert here.
      return;
    }
    const q = await adapterFor(c).requestQuote(intent, c);
    expect(q.ok, q.ok ? "" : `${q.error.code}: ${q.error.message}`).toBe(true);
    if (q.ok) expect(q.value.expiresAt).toBeGreaterThan(Date.now());
  });

  it.skipIf(!hasSigner)("passes the adapter conformance probes", async () => {
    const c = liveCorridor();
    // Matched on the probe's own name because conformanceSuite() returns a
    // fixed list and exposes no other handle on it. If that list grows, this
    // filter is the thing to revisit.
    const suite = conformanceSuite(adapterFor(c), intent, c).filter(
      (p) => recipientSep12Id || p.name !== "compliance resolves to a known status",
    );
    const results = await Promise.all(
      suite.map(async (p) => ({ name: p.name, pass: await p.run() })),
    );
    for (const r of results) {
      expect(r.pass, `probe failed: ${r.name}`).toBe(true);
    }
  });
});

// --- terminal-state capture (MOVES MONEY) ---------------------------------
//
// Everything above is read-only. This is not: it settles one payment on the
// configured network, so it needs its own opt-in rather than riding on the
// anchor vars. `||` not `??`, for the same empty-string reason as above.
const wantsSettlement = (env.CORRIDOR_LIVE_SETTLEMENT || "") === "1";
// execute() runs `comply` before it opens anything, and a SEP-31 anchor needs
// both parties identified by ids IT issued. Registering them is a write this
// suite does not perform (same reasoning as recipientSep12Id above), so they
// are supplied — and without them the case is skipped rather than counted as a
// failure of a fail-closed control.
const senderSep12Id = env.SENDER_SEP12_ID || undefined;
const canSettle = Boolean(wantsSettlement && hasSigner && recipientSep12Id && senderSep12Id);

/** The states a payment must pass through, in order, after the money has moved. */
const TERMINAL_TRAIL: readonly CorridorState[] = ["settled", "reconciled", "completed"];

/** True when `trail` contains every state in `expected`, in that order. */
function containsInOrder(
  trail: readonly CorridorState[],
  expected: readonly CorridorState[],
): boolean {
  let i = 0;
  for (const state of trail) {
    if (state === expected[i]) i++;
    if (i === expected.length) return true;
  }
  return false;
}

describe.skipIf(!hasAnchor)("SEP-31 live anchor (settlement)", () => {
  it.skipIf(!canSettle)(
    "reaches completed, through settled -> reconciled -> completed",
    async () => {
      const c = liveCorridor();
      const secret = env.CORRIDOR_SIGNER_SECRET as string;
      const signer = LocalKeypairSigner.fromSecret(secret);
      const store = new InMemoryIdempotencyStore();

      const deps: EngineDeps = {
        resolver: new StaticRouteResolver(() => adapterFor(c)),
        submitter: new StellarSettlementSubmitter({
          signer,
          horizonUrl: env.HORIZON_URL || "https://horizon-testnet.stellar.org",
        }),
        idempotency: store,
      };

      const settlementIntent: PaymentIntent = {
        ...intent,
        idempotencyKey: `integration-settle-${Date.now()}`,
        sender: { ...intent.sender, sep12Id: senderSep12Id },
        recipient: { ...intent.recipient, sep12Id: recipientSep12Id },
        destinationFields: {
          receiver_routing_number: env.RECEIVER_ROUTING_NUMBER || "021000021",
          receiver_account_number: env.RECEIVER_ACCOUNT_NUMBER || "12345678901234",
          type: env.RECEIVER_DEPOSIT_TYPE || "SWIFT",
        },
      };

      const result = await execute(settlementIntent, c, deps);

      // An anchor-side stall shows up here as a bare `false !== true` unless the
      // run's own record is printed with it: which states it did reach, and the
      // error that stopped it. That is the whole debugging surface for a failure
      // that cannot be reproduced locally.
      const run = await store.get(settlementIntent.idempotencyKey);
      const diagnostics = [
        `state:     ${run?.state ?? "(no stored run)"}`,
        `trail:     ${result.ok ? result.value.trail.join(" -> ") : "(execute returned an error)"}`,
        `lastError: ${run?.lastError ?? "(none recorded)"}`,
        `tx:        ${run?.transactionId ?? "(none)"} / stellar ${run?.stellarTxHash ?? "(none)"}`,
        result.ok ? "" : `error:     ${result.error.code}: ${result.error.message}`,
      ]
        .filter(Boolean)
        .join("\n");

      expect(result.ok, diagnostics).toBe(true);
      if (!result.ok) return;

      expect(result.value.state, diagnostics).toBe("completed");
      expect(
        containsInOrder(result.value.trail, TERMINAL_TRAIL),
        `trail did not contain ${TERMINAL_TRAIL.join(" -> ")} in order\n${diagnostics}`,
      ).toBe(true);
    },
    // A live corridor waits on an anchor's own reconcile cadence, which is far
    // longer than vitest's default 5s.
    Number(env.CORRIDOR_LIVE_SETTLEMENT_TIMEOUT_MS || 300_000),
  );
});

// A tiny always-present assertion so the file is never an empty suite when the
// anchor vars are unset (keeps the default test run green and explicit).
//
// Skipping is only honest because something says so out loud: the two gates
// below are each mirrored by a step in nightly-live-anchor.yml that annotates
// the run when the corresponding value is missing. A silent skip would be the
// "check that cannot fail" this repo keeps arguing against — it was one, for
// months, and the fix is the warning, not the removal of the gate.
describe("SEP-31 live anchor (gating)", () => {
  it("is skipped unless ANCHOR_SEP31_TRANSFER_SERVER + ANCHOR_HOME_DOMAIN are set", () => {
    expect(typeof hasAnchor).toBe("boolean");
  });

  it("skips the auth-dependent cases unless CORRIDOR_SIGNER_SECRET is set", () => {
    expect(typeof hasSigner).toBe("boolean");
  });

  // The settlement case moves money, so it stays off until asked for
  // explicitly — an anchor being configured is not consent to settle on it.
  it("skips the settlement case unless CORRIDOR_LIVE_SETTLEMENT=1 and both SEP-12 ids are set", () => {
    expect(typeof canSettle).toBe("boolean");
    if (!wantsSettlement) expect(canSettle).toBe(false);
    if (!senderSep12Id || !recipientSep12Id) expect(canSettle).toBe(false);
  });

  it("requires the whole terminal trail, not just settlement", () => {
    // The claim under test is `completed`, and the ordered trail behind it.
    // Guarding the helper here means the assertion above cannot quietly pass on
    // a trail that merely ends in the right place.
    expect(containsInOrder(["settled", "reconciled", "completed"], TERMINAL_TRAIL)).toBe(true);
    expect(
      containsInOrder(
        ["created", "settled", "recovering", "reconciled", "completed"],
        TERMINAL_TRAIL,
      ),
    ).toBe(true);
    expect(containsInOrder(["settled", "completed"], TERMINAL_TRAIL)).toBe(false);
    expect(containsInOrder(["reconciled", "settled", "completed"], TERMINAL_TRAIL)).toBe(
      false,
    );
    expect(containsInOrder(["settled", "reconciled"], TERMINAL_TRAIL)).toBe(false);
  });
});
