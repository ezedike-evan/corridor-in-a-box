// Observability — structured logs + an append-only audit trail. A payments
// engine must be able to answer "what happened to this payment, and when" after
// the fact, so every state transition is both logged and recorded as an immutable
// audit entry. Both sinks are injected; the engine never reaches for a global.

import type { CorridorState } from "./state";

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
}

/** Emits one JSON object per line — friendly to log shippers and grep alike. */
export const consoleLogger: Logger = {
  log(level, msg, fields) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  },
};

/** Drops everything. The default, so tests and libraries stay quiet. */
export const silentLogger: Logger = { log() {} };

/** One immutable record of a single state transition. */
export interface AuditEntry {
  readonly idempotencyKey: string;
  readonly corridorId: string;
  readonly from: CorridorState;
  readonly to: CorridorState;
  readonly version: number;
  readonly at: number;
  readonly error?: string;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void> | void;
}

/** In-memory audit log for tests/examples. Back this with an append-only table
 *  (or event stream) in production — never update or delete entries. */
export class InMemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}
