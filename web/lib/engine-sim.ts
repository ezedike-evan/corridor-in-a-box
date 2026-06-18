// A faithful simulation of @corridor/engine's execute() for the demo. It walks
// the same state machine and idempotency rules so the UI shows real behaviour
// without bundling the engine. Point NEXT_PUBLIC at a running @corridor/service
// to drive the real thing instead.

import { getCorridor, liveness } from "./corridors";

export type CorridorState =
  | "created"
  | "quoted"
  | "compliant"
  | "opened"
  | "settling"
  | "settled"
  | "reconciled"
  | "completed"
  | "refunded"
  | "held"
  | "failed";

export interface RunOutcome {
  ok: boolean;
  state: CorridorState;
  trail: CorridorState[];
  stellarTxHash?: string;
  error?: { code: string; message: string };
  idempotentReplay?: boolean;
}

// Server-side in-memory store, mirroring the engine's idempotency gate.
const store = new Map<string, RunOutcome>();

function txHash(seed: number): string {
  return `mocktx${seed.toString().padStart(58, "0")}`;
}

export function runPayment(
  corridorId: string,
  amount: string,
  idempotencyKey: string,
): RunOutcome {
  const existing = store.get(idempotencyKey);
  if (existing && existing.state === "completed") {
    return { ...existing, idempotentReplay: true };
  }

  const corridor = getCorridor(corridorId);
  if (!corridor) {
    return { ok: false, state: "failed", trail: ["created", "failed"], error: { code: "MANIFEST_INVALID", message: `unknown corridor ${corridorId}` } };
  }

  if (!/^-?\d+(\.\d+)?$/.test(amount.trim())) {
    return { ok: false, state: "failed", trail: ["created", "failed"], error: { code: "AMOUNT_INVALID", message: `"${amount}" is not a valid decimal amount` } };
  }

  const live = liveness(corridor);
  const trail: CorridorState[] = ["created"];

  // quote
  trail.push("quoted");
  // comply
  trail.push("compliant");
  // open — fails if the destination has no SEP-31 server (the off-ramp scarcity)
  if (!live.runnable) {
    trail.push("failed");
    const outcome: RunOutcome = {
      ok: false,
      state: "failed",
      trail,
      error: { code: "ANCHOR_UNAVAILABLE", message: `${corridor.dest.name}: no SEP-31 transfer server configured` },
    };
    store.set(idempotencyKey, outcome);
    return outcome;
  }
  trail.push("opened");
  // settle + reconcile
  trail.push("settling");
  trail.push("settled");
  trail.push("reconciled");
  trail.push("completed");

  const outcome: RunOutcome = {
    ok: true,
    state: "completed",
    trail,
    stellarTxHash: txHash(store.size + 1),
  };
  store.set(idempotencyKey, outcome);
  return outcome;
}
