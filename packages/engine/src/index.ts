// @corridor/engine — corridor-agnostic orchestration of the five verbs.

export { execute, type EngineDeps, type RunResult } from "./run";
export { canTransition, isTerminal, TERMINAL, type CorridorState } from "./state";
export {
  InMemoryIdempotencyStore,
  type IdempotencyStore,
  type StoredRun,
} from "./idempotency";
export {
  UnimplementedSubmitter,
  createMockSubmitter,
  type SettlementSubmitter,
  type SettlementRef,
  type SettlementRequest,
} from "./ports";
export { quote, comply, open, settle, reconcile, recover, type RecoveryAction } from "./verbs";
