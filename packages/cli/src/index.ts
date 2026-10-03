#!/usr/bin/env node
// corridor — a tiny CLI to validate manifests, dry-run the plan offline, and
// look after the circuit breakers.
//
//   corridor validate <file.corridor.yaml>
//   corridor plan     <file.corridor.yaml>
//   corridor breaker  status [corridorId]
//   corridor breaker  reset <corridorId> --reason "…"
//
// `plan` is the cheap pre-flight: it tells you whether a corridor is actually
// runnable (does the dest anchor expose SEP-31? a SEP-38 quote server?) before
// you ever touch the network. This is the off-ramp check from the conversation,
// reduced to one command.
//
// `breaker` is the other end: when a lane has halted itself, someone has to look
// at why and then say so in writing before it will take money again. See
// docs/operations.md.

import { liveness, loadCorridor, type Corridor } from "@corridor/manifest";
import type { CorridorHealthStore } from "@corridor/engine";
import {
  BREAKER_USAGE,
  currentUser,
  formatBreakerRecord,
  formatBreakerReset,
  formatBreakerTable,
  openBreakerSession,
  parseBreakerArgs,
  type BreakerCommand,
} from "./breaker";

/** Two lines, the first unchanged from the manifest-only CLI, so the existing
 *  usage assertion and muscle memory both keep working. */
const USAGE = [
  "usage: corridor <validate|plan> <file.corridor.yaml>",
  '       corridor breaker <status [corridorId] | reset <corridorId> --reason "…">',
  "",
  "corridor breaker — inspect and reopen halted lanes (reads DATABASE_URL):",
  BREAKER_USAGE,
].join("\n");

// 0 = fine, 1 = it ran and failed, 2 = you asked for something impossible.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

async function main(argv: string[]): Promise<number> {
  const [cmd, file] = argv;
  if (!cmd) {
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (cmd === "breaker") {
    return breakerCommand(argv.slice(1));
  }
  if (cmd !== "validate" && cmd !== "plan") {
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (!file) {
    console.error(`usage: corridor ${cmd} <file.corridor.yaml>`);
    return EXIT_USAGE;
  }

  const loaded = loadCorridor(file);
  if (!loaded.ok) {
    console.error(`✗ ${loaded.error.code}: ${loaded.error.message}`);
    return EXIT_FAILED;
  }
  const c = loaded.value;

  if (cmd === "validate") {
    console.log(`✓ ${file} is a valid corridor manifest (id="${c.id}")`);
    return EXIT_OK;
  }

  printPlan(c);
  return EXIT_OK;
}

async function breakerCommand(argv: string[]): Promise<number> {
  const parsed = parseBreakerArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return EXIT_USAGE;
  }
  // Opened only after the arguments are known good, so a typo never reaches
  // for a database connection.
  const opened = await openBreakerSession();
  if (!opened.ok) {
    console.error(`✗ ${opened.error}`);
    return EXIT_FAILED;
  }
  const { store, close } = opened.session;
  try {
    const command = parsed.command;
    if (command.kind === "status") {
      return await breakerStatus(store, command);
    }
    return await breakerReset(store, command);
  } finally {
    // The pool keeps the process alive, so this is not optional tidiness: an
    // unfinished pool would hang the command after it had printed its answer.
    await close();
  }
}

async function breakerStatus(
  store: CorridorHealthStore,
  command: { corridorId?: string },
): Promise<number> {
  if (command.corridorId === undefined) {
    console.log(formatBreakerTable(await store.list()));
    return EXIT_OK;
  }
  // A lane with no row is a legitimate answer ("nothing has failed here"), not
  // an error, so `status` exits 0 for it and says why it is empty.
  console.log(formatBreakerRecord(await store.get(command.corridorId), command.corridorId));
  return EXIT_OK;
}

async function breakerReset(
  store: CorridorHealthStore,
  command: Extract<BreakerCommand, { kind: "reset" }>,
): Promise<number> {
  const before = await store.get(command.corridorId);
  const by = currentUser();
  const record = await store.reset(command.corridorId, by, command.reason);
  console.log(formatBreakerReset(record, by, before?.state === "open"));
  return EXIT_OK;
}

function printPlan(c: Corridor): void {
  const line = (s = "") => console.log(s);
  line(`corridor: ${c.id}`);
  if (c.status_note) line(`note:     ${c.status_note}`);
  line(
    `route:    ${c.fx.path.join(" -> ")}   (risk: ${c.fx.who_holds_risk}, ttl ${c.fx.quote_ttl_seconds}s)`,
  );
  line(
    `source:   ${c.source.name}  [${c.source.asset}]  ${c.source.protocol}${c.source.endpoints?.home_domain ? `  ${c.source.endpoints.home_domain}` : ""}`,
  );
  line(`dest:     ${c.dest.name}  [${c.dest.asset}]  ${c.dest.endpoints.home_domain}`);
  line(`bridge:   ${c.settlement.bridge_asset} on ${c.settlement.network}`);
  line(
    `recovery: retries=${c.recovery.max_retries}, timeout=${c.recovery.timeout_seconds}s, rollback=${c.recovery.rollback}, breaker=${c.recovery.breaker.consecutive_failures}`,
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

// Top-level await: the breaker commands talk to Postgres, so `main` is async.
// Exit codes stay exactly as before — 0 fine, 1 ran-and-failed, 2 usage — and an
// unexpected throw is reported as a failure rather than a stack trace on stdout
// plus a 1 that looks like a broken manifest.
try {
  process.exit(await main(process.argv.slice(2)));
} catch (cause) {
  console.error(`✗ ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(EXIT_FAILED);
}
