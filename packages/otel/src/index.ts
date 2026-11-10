// OpenTelemetry adapters for the engine's `Metrics` and `Logger` ports.
//
// The engine imports nothing from OpenTelemetry: these are the only place the two
// meet, and `@opentelemetry/api` / `@opentelemetry/api-logs` are peer dependencies
// so the application owns which version (and which SDK and exporters) it runs.
//
//   import { metrics } from "@opentelemetry/api";
//   import { logs } from "@opentelemetry/api-logs";
//   import { otelLogger, otelMetrics } from "@corridor/otel";
//
//   const deps = {
//     ...engineDeps,
//     metrics: otelMetrics(metrics.getMeter("corridor")),
//     logger: otelLogger(logs.getLogger("corridor")),
//   };
//
// Traces are correlated, not produced: a log record carries the active span's trace
// and span ids, and the engine's `requestId` / `traceparent` fields travel as
// attributes. A span per verb is a follow-up.

import {
  context as otelContext,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
} from "@opentelemetry/api";
import { SeverityNumber, type Logger as OtelLogsLogger } from "@opentelemetry/api-logs";
import type { LogFields, Logger, LogLevel, MetricTags, Metrics } from "@corridor/engine";

/**
 * `Metrics` on an OpenTelemetry `Meter`. `increment` is a counter and `timing` a
 * histogram in milliseconds, one instrument per metric name, created on first use and
 * reused. Tags become attributes.
 */
export function otelMetrics(meter: Meter): Metrics {
  const counters = new Map<string, Counter>();
  const histograms = new Map<string, Histogram>();
  const attributes = (tags?: MetricTags): Attributes => ({ ...tags });
  return {
    increment(name, tags) {
      let counter = counters.get(name);
      if (!counter) {
        counter = meter.createCounter(name);
        counters.set(name, counter);
      }
      counter.add(1, attributes(tags));
    },
    timing(name, ms, tags) {
      let histogram = histograms.get(name);
      if (!histogram) {
        histogram = meter.createHistogram(name, { unit: "ms" });
        histograms.set(name, histogram);
      }
      histogram.record(ms, attributes(tags));
    },
  };
}

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

type AttributeValue = string | number | boolean;

/** An attribute value OpenTelemetry accepts, or undefined to drop the field. */
function attributeValue(v: unknown): AttributeValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function toAttributes(fields: LogFields): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(fields)) {
    const value = attributeValue(v);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

export interface OtelLoggerOptions {
  /**
   * The context a record is emitted in, which is where the active span comes from.
   * Defaults to `context.active()`; injectable so a test can supply one.
   */
  activeContext?: () => Context;
}

/**
 * `Logger` on an OpenTelemetry Logs API `Logger`. `LogLevel` maps to the matching
 * severity, the message is the body, the fields are attributes, and each record is
 * emitted in the active context so the SDK stamps it with the current trace and span
 * ids. `child()` stamps fields on every line, as the port describes.
 */
export function otelLogger(logger: OtelLogsLogger, options: OtelLoggerOptions = {}): Logger {
  const activeContext = options.activeContext ?? (() => otelContext.active());
  const build = (base: LogFields): Logger => ({
    log(level, msg, fields) {
      logger.emit({
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        body: msg,
        attributes: toAttributes({ ...base, ...fields }),
        context: activeContext(),
      });
    },
    child(fields) {
      return build({ ...base, ...fields });
    },
  });
  return build({});
}
