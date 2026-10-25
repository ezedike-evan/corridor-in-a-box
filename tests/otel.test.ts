import { describe, expect, it } from "vitest";
import { context, createContextKey, type Context } from "@opentelemetry/api";
import {
  SeverityNumber,
  type LogRecord,
  type Logger as OtelLogsLogger,
} from "@opentelemetry/api-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type DataPoint,
  type Histogram,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  execute,
  type EngineDeps,
  type LogFields,
} from "@corridor/engine";
import { otelLogger, otelMetrics } from "@corridor/otel";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "otel-test",
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
  idempotencyKey: "otel-1",
  corridorId: "otel-test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

/** A real OpenTelemetry SDK meter that exports into memory, flushed on demand. */
function sdk() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter("corridor-test"),
    async collect(): Promise<MetricData[]> {
      await provider.forceFlush();
      return exporter
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
    },
    shutdown: () => provider.shutdown(),
  };
}

describe("otelMetrics", () => {
  it("increments a counter per name with tags as attributes", async () => {
    const { meter, collect, shutdown } = sdk();
    const metrics = otelMetrics(meter);
    metrics.increment("corridor.terminal", { state: "completed" });
    metrics.increment("corridor.terminal", { state: "completed" });
    metrics.increment("corridor.terminal", { state: "held" });
    metrics.increment("corridor.other");

    const all = await collect();
    const terminal = all.find((m) => m.descriptor.name === "corridor.terminal")!;
    const points = terminal.dataPoints as DataPoint<number>[];
    expect(Object.fromEntries(points.map((p) => [p.attributes.state, p.value]))).toEqual({
      completed: 2,
      held: 1,
    });
    expect(
      (
        all.find((m) => m.descriptor.name === "corridor.other")!
          .dataPoints[0] as DataPoint<number>
      ).value,
    ).toBe(1);
    await shutdown();
  });

  it("records timings in a millisecond histogram", async () => {
    const { meter, collect, shutdown } = sdk();
    const metrics = otelMetrics(meter);
    metrics.timing("corridor.verb.settle", 120, { corridor: "x" });
    metrics.timing("corridor.verb.settle", 80, { corridor: "x" });

    const m = (await collect()).find((d) => d.descriptor.name === "corridor.verb.settle")!;
    expect(m.descriptor.unit).toBe("ms");
    const point = m.dataPoints[0] as DataPoint<Histogram>;
    expect(point.attributes).toEqual({ corridor: "x" });
    expect(point.value.count).toBe(2);
    expect(point.value.sum).toBe(200);
    await shutdown();
  });

  it("reuses one instrument per name", () => {
    let created = 0;
    const counter = { add() {} };
    const histogram = { record() {} };
    const meter = {
      createCounter: () => (created++, counter),
      createHistogram: () => (created++, histogram),
    } as never;
    const metrics = otelMetrics(meter);
    for (let i = 0; i < 5; i++) {
      metrics.increment("a");
      metrics.timing("b", 1);
    }
    expect(created).toBe(2);
  });

  it("sees the counters and timings an execute() run emits", async () => {
    const { meter, collect, shutdown } = sdk();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
      metrics: otelMetrics(meter),
    };
    const r = await execute(intent, corridor(), deps);
    expect(r.ok && r.value.state).toBe("completed");

    const all = await collect();
    const terminal = all.find((m) => m.descriptor.name === "corridor.terminal")!;
    const completed = (terminal.dataPoints as DataPoint<number>[]).find(
      (p) => p.attributes.state === "completed",
    );
    expect(completed?.value).toBe(1);
    const timings = all.filter((m) => m.descriptor.unit === "ms");
    expect(timings.length).toBeGreaterThan(0);
    for (const t of timings) {
      expect((t.dataPoints[0] as DataPoint<Histogram>).value.count).toBeGreaterThanOrEqual(1);
    }
    await shutdown();
  });
});

describe("otelLogger", () => {
  function recorder() {
    const records: LogRecord[] = [];
    const logger: OtelLogsLogger = { emit: (r) => void records.push(r) };
    return { logger, records };
  }

  it("maps each level to its severity and sends the message as the body", () => {
    const { logger, records } = recorder();
    const log = otelLogger(logger);
    log.log("debug", "d");
    log.log("info", "i");
    log.log("warn", "w");
    log.log("error", "e");
    expect(records.map((r) => [r.severityNumber, r.severityText, r.body])).toEqual([
      [SeverityNumber.DEBUG, "DEBUG", "d"],
      [SeverityNumber.INFO, "INFO", "i"],
      [SeverityNumber.WARN, "WARN", "w"],
      [SeverityNumber.ERROR, "ERROR", "e"],
    ]);
  });

  it("sends fields as attributes: primitives as they are, objects as JSON, undefined dropped", () => {
    const { logger, records } = recorder();
    const fields: LogFields = {
      corridorId: "ng-cowrie",
      version: 7,
      ok: true,
      nothing: undefined,
      gone: null,
      fee: { asset: "USDC", amount: "0.10" },
      requestId: "req-1",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      err: new Error("boom"),
    };
    otelLogger(logger).log("info", "corridor.transition", fields);
    expect(records[0]!.attributes).toEqual({
      corridorId: "ng-cowrie",
      version: 7,
      ok: true,
      fee: '{"asset":"USDC","amount":"0.10"}',
      requestId: "req-1",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      err: "boom",
    });
  });

  it("emits in the active context, so the SDK can stamp the current span", () => {
    const { logger, records } = recorder();
    const marked: Context = context.active().setValue(createContextKey("marker"), 1);
    otelLogger(logger, { activeContext: () => marked }).log("info", "x");
    expect(records[0]!.context).toBe(marked);
    // By default it asks the API for the active context.
    otelLogger(logger).log("info", "y");
    expect(records[1]!.context).toBe(context.active());
  });

  it("scopes fields with child(), the call's own fields winning", () => {
    const { logger, records } = recorder();
    const scoped = otelLogger(logger).child!({ requestId: "r1", shared: "child" });
    scoped.log("info", "a", { shared: "line", extra: 1 });
    scoped.child!({ deeper: true }).log("info", "b");
    expect(records[0]!.attributes).toEqual({ requestId: "r1", shared: "line", extra: 1 });
    expect(records[1]!.attributes).toEqual({ requestId: "r1", shared: "child", deeper: true });
  });
});
