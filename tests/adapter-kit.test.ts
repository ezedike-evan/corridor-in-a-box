import { describe, expect, it } from "vitest";
import { conformanceSuite, createMockAdapter } from "@corridor/adapter-kit";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: { name: "D", asset: "iso4217:ARS", endpoints: { home_domain: "d.example" } },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "k",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100" },
};

describe("conformanceSuite", () => {
  it("returns exactly the two documented probes, by name", () => {
    const probes = conformanceSuite(createMockAdapter(), intent, corridor());
    expect(probes.map((p) => p.name)).toEqual([
      "quote returns a future expiry",
      "compliance resolves to a known status",
    ]);
  });

  it("both probes pass against a healthy mock adapter", async () => {
    const probes = conformanceSuite(createMockAdapter(), intent, corridor());
    for (const p of probes) expect(await p.run()).toBe(true);
  });

  it("the quote probe fails when the quote is already expired", async () => {
    const probes = conformanceSuite(
      createMockAdapter({ expireQuoteImmediately: true }),
      intent,
      corridor(),
    );
    const quoteProbe = probes.find((p) => p.name === "quote returns a future expiry")!;
    expect(await quoteProbe.run()).toBe(false);
  });

  it("the compliance probe passes even when KYC is rejected — it only checks shape, not success", async () => {
    const probes = conformanceSuite(
      createMockAdapter({ kyc: "rejected" }),
      intent,
      corridor(),
    );
    const complianceProbe = probes.find(
      (p) => p.name === "compliance resolves to a known status",
    )!;
    expect(await complianceProbe.run()).toBe(true);
  });
});

describe("createMockAdapter", () => {
  it("defaults name to mock-anchor", () => {
    expect(createMockAdapter().name).toBe("mock-anchor");
  });

  it("honors an overridden name", () => {
    expect(createMockAdapter({ name: "acme" }).name).toBe("acme");
  });

  it("requestQuote and openTransaction share a single incrementing counter", async () => {
    const adapter = createMockAdapter();
    const q = await adapter.requestQuote(intent, corridor());
    if (!q.ok) throw new Error("expected quote to succeed");
    expect(q.value.id).toBe("q_1");
    const tx = await adapter.openTransaction(intent, q.value, corridor());
    expect(tx.ok && tx.value.transactionId).toBe("tx_2");
  });

  it("ensureCompliance always returns customerId cust_mock, regardless of KYC status", async () => {
    for (const status of ["accepted", "pending", "rejected"] as const) {
      const r = await createMockAdapter({ kyc: status }).ensureCompliance(intent, corridor());
      expect(r.ok && r.value.customerId).toBe("cust_mock");
      expect(r.ok && r.value.status).toBe(status);
    }
  });

  it("getTransaction: terminalFailure takes priority over settled", async () => {
    const r = await createMockAdapter({ terminalFailure: true, settled: true }).getTransaction(
      "tx_1",
    );
    expect(r.ok && r.value).toEqual({
      status: "error",
      settled: false,
      terminalFailure: true,
    });
  });

  it("getTransaction: defaults to completed/settled", async () => {
    const r = await createMockAdapter().getTransaction("tx_1");
    expect(r.ok && r.value).toEqual({ status: "completed", settled: true });
  });

  it("getTransaction: settled:false reports pending_receiver", async () => {
    const r = await createMockAdapter({ settled: false }).getTransaction("tx_1");
    expect(r.ok && r.value).toEqual({ status: "pending_receiver", settled: false });
  });
});
