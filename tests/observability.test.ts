import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  execute,
  type EngineDeps,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "obs-1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

describe("audit trail", () => {
  it("records one immutable entry per state transition, in order", async () => {
    const audit = new InMemoryAuditLog();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter()),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      now: () => 1700000000000,
    };
    const r = await execute(intent, corridor(), deps);
    expect(r.ok).toBe(true);

    // created -> quoted -> compliant -> opened -> settling -> settled
    //   -> reconciled -> completed = 7 transitions
    expect(audit.entries.map((e) => e.to)).toEqual([
      "quoted",
      "compliant",
      "opened",
      "settling",
      "settled",
      "reconciled",
      "completed",
    ]);
    expect(audit.entries[0]).toMatchObject({
      idempotencyKey: "obs-1",
      corridorId: "test",
      from: "created",
      to: "quoted",
      at: 1700000000000,
    });
    // versions are monotonic
    const versions = audit.entries.map((e) => e.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it("records the error on a failing transition", async () => {
    const audit = new InMemoryAuditLog();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ kyc: "rejected" })),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
    };
    const r = await execute(intent, corridor(), deps);
    expect(r.ok).toBe(false);
    const failed = audit.entries.find((e) => e.to === "failed");
    expect(failed?.error).toContain("KYC_REJECTED");
  });
});
