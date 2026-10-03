// Held-run operator commands. Kept free of process/argv side effects so tests
// can drive them against an in-memory IdempotencyStore.

import type { IdempotencyStore, ResolutionOutcome, StoredRun } from "@corridor/engine";

export const RESOLUTION_OUTCOMES = new Set<ResolutionOutcome>([
  "refunded-offchain",
  "paid-out-manually",
  "written-off",
]);

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

export function formatRun(run: StoredRun): string {
  const cols = [
    run.idempotencyKey,
    run.corridorId,
    run.state,
    run.version,
    run.stellarTxHash ?? "-",
    run.lastError ?? "-",
  ];
  return cols.join("\t");
}

export interface ListArgs {
  limit: number;
  corridorId?: string;
}

// Prints the error and returns undefined on bad input (caller exits 2).
export function parseListArgs(args: string[]): ListArgs | undefined {
  if (args[0] !== "list" || option(args, "--state") !== "held") {
    console.error("usage: corridor runs list --state held [--limit N] [--corridor ID]");
    return undefined;
  }
  const limitText = option(args, "--limit");
  const limit = limitText === undefined ? 100 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    console.error("✗ --limit must be an integer between 1 and 1000");
    return undefined;
  }
  return { limit, corridorId: option(args, "--corridor") };
}

export async function listHeldRuns(store: IdempotencyStore, opts: ListArgs): Promise<number> {
  const runs = await store.listByState("held", opts);
  console.log("idempotency_key\tcorridor_id\tstate\tversion\tstellar_tx_hash\tlast_error");
  for (const run of runs) console.log(formatRun(run));
  return 0;
}

export const RESOLVE_USAGE =
  "usage: corridor resolve <key> --outcome <refunded-offchain|paid-out-manually|written-off> --note <text>";

export interface ResolveArgs {
  key: string;
  outcome: ResolutionOutcome;
  note: string;
}

export function parseResolveArgs(args: string[]): ResolveArgs | undefined {
  const [key] = args;
  const outcome = option(args, "--outcome") as ResolutionOutcome | undefined;
  const note = option(args, "--note");
  if (!key || !outcome || !RESOLUTION_OUTCOMES.has(outcome) || !note?.trim()) return undefined;
  return { key, outcome, note: note.trim() };
}

export async function resolveHeldRun(
  store: IdempotencyStore,
  parsed: ResolveArgs,
  resolvedBy: string,
): Promise<number> {
  const { key, outcome, note } = parsed;
  const run = await store.get(key);
  if (!run || run.state !== "held") {
    console.error(
      "✗ only an existing held run can be resolved; the run state was not changed",
    );
    return 1;
  }
  if (await store.getResolution(key)) {
    console.error("✗ this held run already has an out-of-band resolution");
    return 1;
  }
  const inserted = await store.recordResolution({
    idempotencyKey: key,
    outcome,
    note,
    resolvedBy,
    resolvedAt: Date.now(),
  });
  if (!inserted) {
    console.error("✗ run is not held or another operator already resolved it");
    return 1;
  }
  console.log(`✓ recorded ${outcome} for ${key}; held run retained as an audit record`);
  return 0;
}
