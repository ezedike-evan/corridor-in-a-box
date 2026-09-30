#!/usr/bin/env node
// corridor — a tiny CLI to validate manifests and dry-run the plan offline.
//
//   corridor validate <file.corridor.yaml>
//   corridor plan     <file.corridor.yaml>
//
// `plan` is the cheap pre-flight: it tells you whether a corridor is actually
// runnable (does the dest anchor expose SEP-31? a SEP-38 quote server?) before
// you ever touch the network. This is the off-ramp check from the conversation,
// reduced to one command.

import { liveness, loadCorridor, type Corridor } from "@corridor/manifest";
import {
  PostgresIdempotencyStore,
  migrate,
  type ResolutionOutcome,
  type StoredRun,
} from "@corridor/engine";

const RESOLUTION_OUTCOMES = new Set<ResolutionOutcome>([
  "refunded-offchain",
  "paid-out-manually",
  "written-off",
]);

async function main(argv: string[]): Promise<number> {
  const [cmd, file] = argv;
  if (cmd === "runs") return listHeldRuns(argv.slice(1));
  if (cmd === "resolve") return resolveHeldRun(argv.slice(1));
  if (!cmd || (cmd !== "validate" && cmd !== "plan")) {
    console.error("usage: corridor <validate|plan> <file.corridor.yaml> | runs list --state held | resolve <key> --outcome <outcome> --note <text>");
    return 2;
  }
  if (!file) {
    console.error(`usage: corridor ${cmd} <file.corridor.yaml>`);
    return 2;
  }

  const loaded = loadCorridor(file);
  if (!loaded.ok) {
    console.error(`✗ ${loaded.error.code}: ${loaded.error.message}`);
    return 1;
  }
  const c = loaded.value;

  if (cmd === "validate") {
    console.log(`✓ ${file} is a valid corridor manifest (id="${c.id}")`);
    return 0;
  }

  printPlan(c);
  return 0;
}

async function openStore(): Promise<{ store: PostgresIdempotencyStore; close: () => Promise<void> } | undefined> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("✗ DATABASE_URL is required for corridor run operations");
    return undefined;
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  await migrate(pool);
  return { store: new PostgresIdempotencyStore(pool), close: () => pool.end() };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function formatRun(run: StoredRun): string {
  return `${run.idempotencyKey}\t${run.corridorId}\t${run.state}\t${run.version}\t${run.stellarTxHash ?? "-"}\t${run.lastError ?? "-"}`;
}

async function listHeldRuns(args: string[]): Promise<number> {
  if (args[0] !== "list" || option(args, "--state") !== "held") {
    console.error("usage: corridor runs list --state held [--limit N] [--corridor ID]");
    return 2;
  }
  const limitText = option(args, "--limit");
  const limit = limitText === undefined ? 100 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    console.error("✗ --limit must be an integer between 1 and 1000");
    return 2;
  }
  const opened = await openStore();
  if (!opened) return 1;
  try {
    const runs = await opened.store.listByState("held", {
      limit,
      corridorId: option(args, "--corridor"),
    });
    console.log("idempotency_key\tcorridor_id\tstate\tversion\tstellar_tx_hash\tlast_error");
    for (const run of runs) console.log(formatRun(run));
    return 0;
  } finally {
    await opened.close();
  }
}

async function resolveHeldRun(args: string[]): Promise<number> {
  const [key] = args;
  const outcome = option(args, "--outcome") as ResolutionOutcome | undefined;
  const note = option(args, "--note");
  const resolvedBy = process.env.CORRIDOR_OPERATOR_ID?.trim();
  if (!key || !outcome || !RESOLUTION_OUTCOMES.has(outcome) || !note?.trim()) {
    console.error("usage: corridor resolve <key> --outcome <refunded-offchain|paid-out-manually|written-off> --note <text>");
    return 2;
  }
  if (!resolvedBy) {
    console.error("✗ CORRIDOR_OPERATOR_ID is required to record who resolved the run");
    return 1;
  }
  const opened = await openStore();
  if (!opened) return 1;
  try {
    const run = await opened.store.get(key);
    if (!run || run.state !== "held") {
      console.error("✗ only an existing held run can be resolved; the run state was not changed");
      return 1;
    }
    if (await opened.store.getResolution(key)) {
      console.error("✗ this held run already has an out-of-band resolution");
      return 1;
    }
    const inserted = await opened.store.recordResolution({
      idempotencyKey: key,
      outcome,
      note: note.trim(),
      resolvedBy,
      resolvedAt: Date.now(),
    });
    if (!inserted) {
      console.error("✗ run is not held or another operator already resolved it");
      return 1;
    }
    console.log(`✓ recorded ${outcome} for ${key}; held run retained as an audit record`);
    return 0;
  } finally {
    await opened.close();
  }
}

function printPlan(c: Corridor): void {
  const line = (s = "") => console.log(s);
  line(`corridor: ${c.id}`);
  if (c.status_note) line(`note:     ${c.status_note}`);
  line(
    `route:    ${c.fx.path.join(" -> ")}   (risk: ${c.fx.who_holds_risk}, ttl ${c.fx.quote_ttl_seconds}s)`,
  );
  line(`source:   ${c.source.name}  [${c.source.asset}]  ${c.source.endpoints.home_domain}`);
  line(`dest:     ${c.dest.name}  [${c.dest.asset}]  ${c.dest.endpoints.home_domain}`);
  line(`bridge:   ${c.settlement.bridge_asset} on ${c.settlement.network}`);
  line(
    `recovery: retries=${c.recovery.max_retries}, timeout=${c.recovery.timeout_seconds}s, rollback=${c.recovery.rollback}`,
  );
  line();
  line("steps:");
  line("  1. quote      SEP-38  POST /quote");
  line("  2. comply     SEP-10 auth + SEP-12 KYC handoff");
  line("  3. open       SEP-31  POST /transactions");
  line("  4. settle     native Stellar payment of bridge asset");
  line("  5. reconcile  SEP-31  GET /transactions/:id");
  line();

  // Liveness comes from @corridor/manifest so this command and the web dashboard
  // can never describe the same corridor differently. Note the three states: a
  // lane whose endpoints exist but have never been checked reports UNVERIFIED,
  // not runnable — the presence of a URL is not evidence the anchor is real.
  const live = liveness(c);

  if (live.state === "verified") {
    line(`liveness: ✓ VERIFIED — endpoints confirmed ${live.verifiedAt} for all five steps`);
  } else if (live.state === "unverified") {
    line("liveness: ? UNVERIFIED — endpoints present but unconfirmed. NOT runnable.");
  } else {
    line("liveness: ✗ NOT RUNNABLE — a required endpoint is missing.");
  }

  if (live.warnings.length > 0) {
    line();
    line("liveness warnings:");
    for (const w of live.warnings) line(`  ! ${w}`);
  }
}

void main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`✗ corridor command failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
