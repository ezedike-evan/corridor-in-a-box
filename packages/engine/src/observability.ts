// Observability — structured logs + an append-only audit trail. A payments
// engine must be able to answer "what happened to this payment, and when" after
// the fact, so every state transition is both logged and recorded as an immutable
// audit entry. Both sinks are injected; the engine never reaches for a global.

import type { Money } from "@corridor/types";
import type { CorridorState } from "./state";
import type { LivenessState } from "@corridor/manifest";
import type { CheckResult } from "./gate";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  /**
   * Optional scoping convention: return a logger that stamps `fields` on every
   * line it emits, so a caller can attach per-request context (a request id, a
   * trace id) once instead of threading it through every call site. Sinks that
   * already keep a structured context (pino, winston) should implement this and
   * return their own child; everyone else gets the merging wrapper from
   * `childLogger`.
   */
  child?(fields: LogFields): Logger;
}

/** A logger that folds `fields` under each line's own, delegating to `base`. */
function mergingLogger(base: Logger, fields: LogFields): Logger {
  return {
    log(level: LogLevel, msg: string, line?: LogFields): void {
      base.log(level, msg, { ...fields, ...line });
    },
  };
}

/**
 * Scope `logger` to `fields`. Uses the sink's own `child()` when it has one
 * (cheaper, and it keeps the sink's real context), otherwise wraps it in a
 * merging logger, so this works with any injected `Logger`.
 */
export function childLogger(logger: Logger, fields: LogFields): Logger {
  return logger.child ? logger.child(fields) : mergingLogger(logger, fields);
}

/** Emits one JSON object per line — friendly to log shippers and grep alike. */
export const consoleLogger: Logger = {
  log(level, msg, fields) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else if (level === "debug") (console.debug ?? console.log)(line);
    else console.log(line);
  },
  child(fields) {
    // A fresh sink per scope rather than a recursion back into `childLogger`.
    return mergingLogger(consoleLogger, fields);
  },
};

/** Drops everything. The default, so tests and libraries stay quiet. */
export const silentLogger: Logger = {
  log() {},
  child() {
    return silentLogger;
  },
};

/**
 * Per-request context the engine stamps on everything a run produces. Kept as a
 * type (not an interface) so it spreads cleanly into `LogFields`.
 */
export type RequestScope = {
  readonly requestId?: string;
  readonly traceparent?: string;
};

/** One immutable record of a single state transition. */
export interface AuditEntry extends LogFields {
  readonly idempotencyKey: string;
  readonly corridorId: string;
  readonly from: CorridorState;
  readonly to: CorridorState;
  readonly version: number;
  readonly at: number;
  readonly error?: string;
  /** Request id the run was started under, when the caller supplied one. */
  readonly requestId?: string;
  /** W3C `traceparent` of the request that started the run, when it had one. */
  readonly traceparent?: string;
  readonly routeTrust?: "attested" | "manifest";
  /** The anchor's SEP-38 fee, in the sell asset. Present on the `settled` entry when the quote carried one. */
  readonly quoteFee?: Money;
  /** Stellar network fee charged for the settlement, in stroops (Horizon `fee_charged`). */
  readonly networkFee?: string;
  readonly amountRefunded?: string;
  readonly amountFee?: string;
  /** Pre-settle gate results, recorded on the `verifying` transition. */
  readonly checks?: readonly CheckResult[];
}

/** Verification decision recorded before the engine claims an idempotency key. */
export interface AuditDetail {
  readonly event: "verifying";
  readonly idempotencyKey: string;
  readonly corridorId: string;
  readonly at: number;
  /** Request id the run was started under, when the caller supplied one. */
  readonly requestId?: string;
  /** W3C `traceparent` of the request that started the run, when it had one. */
  readonly traceparent?: string;
  readonly detail: {
    readonly liveness: LivenessState;
    readonly effectiveCap?: string;
  };
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void> | void;
  recordDetail?(detail: AuditDetail): Promise<void> | void;
}

/**
 * An audit sink that stamps `scope` onto every entry and detail it records, so a
 * whole run's trail can be tied back to the request that started it without
 * every emit site repeating the field.
 */
export function scopedAuditSink(sink: AuditSink, scope: RequestScope): AuditSink {
  return {
    record: (entry) => sink.record({ ...scope, ...entry }),
    ...(sink.recordDetail && {
      recordDetail: (detail) => sink.recordDetail!({ ...scope, ...detail }),
    }),
  };
}

export type AlertKind = "held" | "refund_pending" | "breaker_tripped";

export interface Alert {
  readonly kind: AlertKind;
  readonly corridorId: string;
  readonly idempotencyKey?: string;
  readonly stellarTxHash?: string;
  readonly lastError?: string;
  readonly at: number;
}

/** Notifications are best-effort: an alert sink must never control payment state. */
export interface Alerting {
  raise(alert: Alert): Promise<void> | void;
}

export const noopAlerting: Alerting = { raise() {} };

/** Small test sink; production deployments should inject an alert transport. */
export class InMemoryAlerting implements Alerting {
  readonly alerts: Alert[] = [];
  raise(alert: Alert): void {
    this.alerts.push({ ...alert });
  }
}

/** Webhook transport sends only operational identifiers and never payment PII. */
export class WebhookAlerting implements Alerting {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      throw new Error("WebhookAlerting requires HTTPS (localhost is allowed for development)");
    }
  }

  async raise(alert: Alert): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
    });
    if (!response.ok) throw new Error(`alert webhook returned HTTP ${response.status}`);
  }
}

/** In-memory audit log for tests/examples. Back this with an append-only table
 *  (or event stream) in production — never update or delete entries. */
export class InMemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];
  readonly details: AuditDetail[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  recordDetail(detail: AuditDetail): void {
    this.details.push(detail);
  }
}

// --- Metrics -------------------------------------------------------------
// A minimal counter/timing sink. Maps cleanly onto StatsD/Prometheus/OTel:
// `increment` → a counter, `timing` → a histogram. Tags become labels.

export interface MetricTags {
  readonly [key: string]: string;
}

export interface Metrics {
  increment(name: string, tags?: MetricTags): void;
  timing(name: string, ms: number, tags?: MetricTags): void;
}

/** Discards everything. The default. */
export const noopMetrics: Metrics = { increment() {}, timing() {} };

export class InMemoryMetrics implements Metrics {
  readonly counters: { name: string; tags?: MetricTags }[] = [];
  readonly timings: { name: string; ms: number; tags?: MetricTags }[] = [];
  increment(name: string, tags?: MetricTags): void {
    this.counters.push({ name, tags });
  }
  timing(name: string, ms: number, tags?: MetricTags): void {
    this.timings.push({ name, ms, tags });
  }
}

// --- Prometheus exposition ----------------------------------------------
// A zero-dependency Metrics sink that aggregates in process and renders the
// Prometheus text exposition format. Counters sum; timings become a summary-
// style `<name>_count` + `<name>_sum_ms`. Serve render() from a /metrics
// endpoint (see @corridor/service) and point a scraper at it — no client lib.
//
// The engine already emits `corridor.terminal{state=…}` on every terminal
// transition, so alerting on stuck money is a query away, e.g.:
//   increase(corridor_terminal{state="held"}[15m]) > 0
//   increase(corridor_terminal{state="failed"}[15m]) > 0

/** Prometheus metric/label names allow [a-zA-Z0-9_]; map anything else to "_". */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Escape a label value per the exposition format (backslash, quote, newline). */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(tags?: MetricTags): string {
  const keys = tags ? Object.keys(tags).sort() : [];
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${sanitize(k)}="${escapeLabel(tags![k])}"`).join(",")}}`;
}

/** Stable key for a (name, tags) series so samples aggregate correctly. */
function seriesKey(name: string, tags?: MetricTags): string {
  return name + renderLabels(tags);
}

export class PrometheusMetrics implements Metrics {
  private readonly counters = new Map<
    string,
    { name: string; labels: string; value: number }
  >();
  private readonly timings = new Map<
    string,
    { name: string; labels: string; count: number; sumMs: number }
  >();

  increment(name: string, tags?: MetricTags): void {
    const key = seriesKey(name, tags);
    const existing = this.counters.get(key);
    if (existing) existing.value += 1;
    else
      this.counters.set(key, { name: sanitize(name), labels: renderLabels(tags), value: 1 });
  }

  timing(name: string, ms: number, tags?: MetricTags): void {
    const key = seriesKey(name, tags);
    const existing = this.timings.get(key);
    if (existing) {
      existing.count += 1;
      existing.sumMs += ms;
    } else {
      this.timings.set(key, {
        name: sanitize(name),
        labels: renderLabels(tags),
        count: 1,
        sumMs: ms,
      });
    }
  }

  /** Render all series in Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    const counterNames = new Set([...this.counters.values()].map((c) => c.name));
    for (const name of [...counterNames].sort()) {
      lines.push(`# TYPE ${name} counter`);
      for (const c of this.counters.values()) {
        if (c.name === name) lines.push(`${c.name}${c.labels} ${c.value}`);
      }
    }
    const timingNames = new Set([...this.timings.values()].map((t) => t.name));
    for (const name of [...timingNames].sort()) {
      lines.push(`# TYPE ${name}_ms summary`);
      for (const t of this.timings.values()) {
        if (t.name !== name) continue;
        lines.push(`${t.name}_ms_count${t.labels} ${t.count}`);
        lines.push(`${t.name}_ms_sum${t.labels} ${t.sumMs}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}
