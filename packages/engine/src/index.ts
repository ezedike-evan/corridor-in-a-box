// @corridor/engine — corridor-agnostic orchestration of the five verbs.

export { execute, type EngineDeps, type RunResult } from "./run";
export { canTransition, isTerminal, TERMINAL, type CorridorState } from "./state";
export {
  InMemoryIdempotencyStore,
  type IdempotencyStore,
  type StoredRun,
} from "./idempotency";
export {
  PostgresIdempotencyStore,
  migrate,
  CREATE_TABLE_SQL,
  type Queryable,
  type QueryResult,
} from "./idempotency-pg";
export {
  UnimplementedSubmitter,
  createMockSubmitter,
  type SettlementSubmitter,
  type SettlementRef,
  type SettlementRequest,
  type RefundRequest,
} from "./ports";
export {
  quote,
  comply,
  open,
  settle,
  reconcile,
  reconcileUntil,
  backoffMs,
  recover,
  type RecoveryAction,
  type PollOptions,
} from "./verbs";
export {
  consoleLogger,
  silentLogger,
  InMemoryAuditLog,
  noopMetrics,
  InMemoryMetrics,
  type Logger,
  type LogLevel,
  type LogFields,
  type AuditSink,
  type AuditEntry,
  type Metrics,
  type MetricTags,
} from "./observability";
