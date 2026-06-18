// The orchestrator. execute() runs one payment across one corridor:
//   quote → comply → open → settle → reconcile → complete
// driving the state machine, persisting after each step (so it's resumable), and
// routing failures through recover(). It is corridor-AGNOSTIC: every corridor-
// specific fact arrives via the validated manifest, every anchor-specific fact via
// the injected RouteResolver/adapters. Add a corridor = add a manifest.

import type { Corridor } from "@corridor/manifest";
import {
  fail,
  ok,
  type CorridorError,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import type { RouteResolver } from "@corridor/router";
import { canTransition, type CorridorState } from "./state";
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore,
  type StoredRun,
} from "./idempotency";
import type { SettlementSubmitter } from "./ports";
import { comply, open, quote, recover, reconcile, settle } from "./verbs";

export interface EngineDeps {
  resolver: RouteResolver;
  submitter: SettlementSubmitter;
  idempotency?: IdempotencyStore;
  now?: () => number;
}

export interface RunResult {
  readonly idempotencyKey: string;
  readonly state: CorridorState;
  readonly transactionId?: string;
  readonly stellarTxHash?: string;
  /** Ordered list of states the run passed through — useful for the example/CLI. */
  readonly trail: readonly CorridorState[];
}

export async function execute(
  intent: PaymentIntent,
  corridor: Corridor,
  deps: EngineDeps,
): Promise<Outcome<RunResult>> {
  const store = deps.idempotency ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => Date.now());

  // --- idempotency gate -------------------------------------------------
  const existing = await store.get(intent.idempotencyKey);
  if (existing) {
    if (existing.state === "completed") {
      return ok(toResult(existing, [existing.state]));
    }
    return fail(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey ${intent.idempotencyKey} already in-flight (state=${existing.state})`,
    );
  }

  const run: StoredRun = {
    idempotencyKey: intent.idempotencyKey,
    corridorId: corridor.id,
    state: "created",
    version: 0,
  };
  const trail: CorridorState[] = ["created"];

  const advance = async (to: CorridorState): Promise<Outcome<void>> => {
    if (!canTransition(run.state, to)) {
      return fail("SETTLEMENT_FAILED", `illegal transition ${run.state} -> ${to}`);
    }
    run.state = to;
    run.version += 1;
    trail.push(to);
    await store.put(run);
    return ok(undefined);
  };

  const die = async (e: CorridorError): Promise<Err> => {
    run.lastError = `${e.code}: ${e.message}`;
    run.state = "failed";
    run.version += 1;
    trail.push("failed");
    await store.put(run);
    return { ok: false, error: e };
  };

  // --- pick the receiving anchor ---------------------------------------
  const route = await deps.resolver.resolve(intent, corridor);
  const adapter = route.receiving;

  // --- 1. quote ---------------------------------------------------------
  const q = await quote(adapter, intent, corridor, now());
  if (!q.ok) return die(q.error);
  run.quoteId = q.value.id;
  {
    const t = await advance("quoted");
    if (!t.ok) return die(t.error);
  }

  // --- 2. comply --------------------------------------------------------
  const c = await comply(adapter, intent, corridor);
  if (!c.ok) return die(c.error);
  {
    const t = await advance("compliant");
    if (!t.ok) return die(t.error);
  }

  // --- 3a. open ---------------------------------------------------------
  const opened = await open(adapter, intent, q.value, corridor);
  if (!opened.ok) return die(opened.error);
  run.transactionId = opened.value.transactionId;
  {
    const t = await advance("opened");
    if (!t.ok) return die(t.error);
  }

  // --- 3b/4. settle + reconcile, with recover() retry loop --------------
  let attempt = 0;
  for (;;) {
    {
      const t = await advance(run.state === "recovering" ? "settling" : "settling");
      if (!t.ok) return die(t.error);
    }

    const s = await settle(deps.submitter, opened.value, q.value, corridor);
    if (!s.ok) {
      const action = recover(corridor, s.error.retryable, attempt);
      if (action.kind === "retry") {
        attempt = action.attempt;
        const back = await advance("recovering");
        if (!back.ok) return die(back.error);
        continue;
      }
      if (action.kind === "refund") {
        await markRefunded(run, store, trail, s.error);
        return { ok: false, error: s.error };
      }
      return die(s.error);
    }
    run.stellarTxHash = s.value.stellarTxHash;
    {
      const t = await advance("settled");
      if (!t.ok) return die(t.error);
    }

    const r = await reconcile(adapter, opened.value.transactionId);
    if (!r.ok) {
      const action = recover(corridor, r.error.retryable, attempt);
      if (action.kind === "retry") {
        attempt = action.attempt;
        const back = await advance("recovering");
        if (!back.ok) return die(back.error);
        continue;
      }
      return die(r.error);
    }
    {
      const t = await advance("reconciled");
      if (!t.ok) return die(t.error);
    }
    break;
  }

  // --- 5. complete ------------------------------------------------------
  {
    const t = await advance("completed");
    if (!t.ok) return die(t.error);
  }
  return ok(toResult(run, trail));
}

type Err = { ok: false; error: CorridorError };

function toResult(run: StoredRun, trail: readonly CorridorState[]): RunResult {
  return {
    idempotencyKey: run.idempotencyKey,
    state: run.state,
    transactionId: run.transactionId,
    stellarTxHash: run.stellarTxHash,
    trail,
  };
}

async function markRefunded(
  run: StoredRun,
  store: IdempotencyStore,
  trail: CorridorState[],
  e: CorridorError,
): Promise<void> {
  run.lastError = `${e.code}: ${e.message}`;
  if (canTransition(run.state, "recovering")) {
    run.state = "recovering";
    run.version += 1;
    trail.push("recovering");
  }
  run.state = "refunded";
  run.version += 1;
  trail.push("refunded");
  await store.put(run);
}
