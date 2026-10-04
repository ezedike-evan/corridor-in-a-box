import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  PrometheusMetrics,
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
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "m1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

function deps(metrics: InMemoryMetrics, adapterOpts = {}): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    metrics,
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
  };
}

describe("metrics", () => {
  it("records per-verb timings, transition counters, and a completed terminal", async () => {
    const m = new InMemoryMetrics();
    const r = await execute(intent, corridor(), deps(m));
    expect(r.ok).toBe(true);

    const timingNames = m.timings.map((t) => t.name);
    for (const verb of ["quote", "comply", "open", "settle", "reconcile"]) {
      expect(timingNames).toContain(`corridor.verb.${verb}`);
    }
    expect(timingNames).toContain("corridor.duration");

    // 8 transitions counted
    expect(m.counters.filter((c) => c.name === "corridor.transition")).toHaveLength(8);
    const terminal = m.counters.find((c) => c.name === "corridor.terminal");
    expect(terminal?.tags?.state).toBe("completed");
  });

  it("records gate timing and check counter metrics when gate is evaluated", async () => {
    const m = new InMemoryMetrics();
    const d = deps(m);
    d.gate = {
      async evaluate() {
        return {
          passed: true,
          results: [
            {
              name: "chain.balance",
              passed: true,
              detail: "sufficient",
              durationMs: 1,
            },
          ],
        };
      },
    };
    const r = await execute(intent, corridor(), d);
    expect(r.ok).toBe(true);

    const timingNames = m.timings.map((t) => t.name);
    expect(timingNames).toContain("corridor.verb.verify");

    const gateChecks = m.counters.filter((c) => c.name === "corridor.gate.check");
    expect(gateChecks).toHaveLength(1);
    expect(gateChecks[0].tags).toEqual({ name: "chain.balance", passed: "true" });
  });

  it("counts a failed terminal when a verb fails", async () => {
    const m = new InMemoryMetrics();
    const r = await execute(intent, corridor(), deps(m, { kyc: "rejected" }));
    expect(r.ok).toBe(false);
    const terminal = m.counters.find((c) => c.name === "corridor.terminal");
    expect(terminal?.tags?.state).toBe("failed");
  });
});

describe("PrometheusMetrics", () => {
  it("renders counters and timings in exposition format, with sanitized names", async () => {
    const m = new PrometheusMetrics();
    const r = await execute(intent, corridor(), deps(m as unknown as InMemoryMetrics));
    expect(r.ok).toBe(true);
    const text = m.render();

    // Dots become underscores; tags become labels.
    expect(text).toContain("# TYPE corridor_transition counter");
    expect(text).toMatch(/corridor_transition\{[^}]*to="completed"[^}]*\} 1/);
    expect(text).toContain('corridor_terminal{corridor="test",state="completed"} 1');
    // Timings render as a summary (_count + _sum).
    expect(text).toContain("# TYPE corridor_verb_quote_ms summary");
    expect(text).toMatch(/corridor_verb_quote_ms_count\{corridor="test"\} 1/);
  });

  it("aggregates repeated samples into one series", () => {
    const m = new PrometheusMetrics();
    m.increment("corridor.transition", { to: "settled" });
    m.increment("corridor.transition", { to: "settled" });
    m.timing("corridor.verb.settle", 10, { corridor: "x" });
    m.timing("corridor.verb.settle", 30, { corridor: "x" });
    const text = m.render();
    expect(text).toContain('corridor_transition{to="settled"} 2');
    expect(text).toContain('corridor_verb_settle_ms_count{corridor="x"} 2');
    expect(text).toContain('corridor_verb_settle_ms_sum{corridor="x"} 40');
  });

  it("escapes label values", () => {
    const m = new PrometheusMetrics();
    m.increment("e", { msg: 'a"b\\c' });
    expect(m.render()).toContain('e{msg="a\\"b\\\\c"} 1');
  });
});
