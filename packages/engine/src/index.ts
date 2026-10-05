// @corridor/engine — corridor-agnostic orchestration of the five verbs.

export { execute, type EngineDeps, type RunResult } from "./run";
export { canTransition, isTerminal, TERMINAL, type CorridorState } from "./state";
export {
  InMemoryIdempotencyStore,
  hasRequestedRefund,
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
  PostgresCorridorHealthStore,
  type CorridorHealthStore,
  type HealthState,
} from "./health-pg";
export {
  UnimplementedSubmitter,
  createMockSubmitter,
  StellarPaymentStrategy,
  defaultStrategies,
  type SettlementSubmitter,
  type ChainVerifier,
  type SettlementRef,
  type SettlementRequest,
  type RefundRequest,
  type SettlementStrategy,
  type SettlementStrategyContext,
  type DepositInstructionsKind,
} from "./ports";
export {
  quote,
  comply,
  open,
  settle,
  buildSettlementRequest,
  settleQuoteProblem,
  reconcile,
  reconcileUntil,
  watchRefund,
  anchorTerminalStatus,
  backoffMs,
  recover,
  type RecoveryAction,
  type PollOptions,
  type RefundPollOptions,
} from "./verbs";
export {
  CompositeGate,
  defaultSep31Gate,
  type DefaultSep31GateOptions,
  type GateContext,
  type CheckResult,
  type GateCheck,
  type PreSettleGate,
} from "./gate";
export {
  consoleLogger,
  silentLogger,
  InMemoryAuditLog,
  noopMetrics,
  InMemoryMetrics,
  PrometheusMetrics,
  type Logger,
  type LogLevel,
  type LogFields,
  type AuditSink,
  type AuditEntry,
  type AuditDetail,
  type Metrics,
  type MetricTags,
} from "./observability";
export { quoteWindowCheck } from "./quoteWindow";
