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
  idempotencyKey: "m1",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

function deps(metrics: InMemoryMetrics, adapterOpts = {}): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts)),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    metrics,
    sleep: async () => {},
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

    // 7 transitions counted
    expect(m.counters.filter((c) => c.name === "corridor.transition")).toHaveLength(7);
    const terminal = m.counters.find((c) => c.name === "corridor.terminal");
    expect(terminal?.tags?.state).toBe("completed");
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
