// The corridor state machine — the spine. Every payment walks these states in
// order; recover() is the only thing that moves backwards. Persist the state +
// a monotonic version after each transition so a crashed run can be resumed and
// reconciled rather than lost.

export type CorridorState =
  | "created"
  | "quoted"
  | "compliant"
  | "opened"
  | "settling"
  | "settled"
  | "reconciled"
  | "completed"
  | "recovering"
  | "refunded"
  | "held"
  | "failed";

const NEXT: Record<CorridorState, readonly CorridorState[]> = {
  created: ["quoted", "failed"],
  quoted: ["compliant", "recovering", "failed"],
  compliant: ["opened", "recovering", "failed"],
  opened: ["settling", "recovering", "failed"],
  settling: ["settled", "recovering", "failed"],
  settled: ["reconciled", "recovering", "failed"],
  reconciled: ["completed", "failed"],
  completed: [],
  // recover() routes here; from recovering we either retry, refund, hold for
  // manual intervention, or give up.
  recovering: ["settling", "refunded", "held", "failed"],
  refunded: [],
  held: [],
  failed: [],
};

export function canTransition(from: CorridorState, to: CorridorState): boolean {
  return NEXT[from].includes(to);
}

export const TERMINAL: ReadonlySet<CorridorState> = new Set([
  "completed",
  "refunded",
  "held",
  "failed",
]);

export function isTerminal(s: CorridorState): boolean {
  return TERMINAL.has(s);
}
