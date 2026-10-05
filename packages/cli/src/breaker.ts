// `corridor breaker status|reset` — the operator-facing half of the circuit
// breaker.
//
// Everything that does not need a database lives here and is a pure function:
// argument parsing and rendering. That is deliberate. The things worth testing
// about a CLI (does `reset` without `--reason` refuse, does `status` print a
// shape a human can scan) have nothing to do with Postgres, and a test that has
// to stand up a database to check an exit code tests the wrong thing.
//
// The database is reached through the same structural `Queryable` seam the
// engine uses, with `pg` loaded dynamically: the library never forces a driver
// on its consumers, and `validate`/`plan` must keep working on a machine that
// has no `pg` installed at all.

import { userInfo } from "node:os";
import {
  PostgresCorridorHealthStore,
  type BreakerRecord,
  type CorridorHealthStore,
  type Queryable,
} from "@corridor/engine";

export const BREAKER_USAGE = [
  "usage: corridor breaker status [corridorId]",
  '       corridor breaker reset <corridorId> --reason "why you reopened it"',
  "",
  "  status   with no id, list every lane's breaker; with an id, show that lane in full",
  "  reset    reopen a halted lane. --reason is required and is recorded with your",
  "          OS username, so the next person to trip this lane can see who cleared it",
  "           and on what evidence.",
].join("\n");

export type BreakerCommand =
  | { readonly kind: "status"; readonly corridorId?: string }
  | { readonly kind: "reset"; readonly corridorId: string; readonly reason: string };

export type BreakerArgs =
  | { readonly ok: true; readonly command: BreakerCommand }
  | { readonly ok: false; readonly error: string };

/**
 * Parse `corridor breaker <...>`. Returns a message rather than throwing, so
 * the caller prints it to stderr and exits 2 — the same contract the
 * manifest commands already use for a usage error.
 */
export function parseBreakerArgs(argv: readonly string[]): BreakerArgs {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    return { ok: false, error: BREAKER_USAGE };
  }
  if (sub !== "status" && sub !== "reset") {
    return { ok: false, error: `unknown breaker subcommand: ${sub}\n\n${BREAKER_USAGE}` };
  }

  const positionals: string[] = [];
  let reason: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    // `--reason` is the only flag `reset` takes, and it is matched here rather
    // than by a generic flag parser so a typo'd flag is a usage error instead
    // of being silently swallowed as a positional.
    if (arg === "--reason") {
      const value = rest[++i];
      if (value === undefined) return { ok: false, error: "--reason needs a value" };
      reason = value;
      continue;
    }
    if (arg.startsWith("--reason=")) {
      reason = arg.slice("--reason=".length);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      return { ok: false, error: `unknown flag for corridor breaker ${sub}: ${arg}` };
    }
    positionals.push(arg);
  }

  if (sub === "status") {
    if (reason !== undefined) {
      return { ok: false, error: "corridor breaker status takes no flags" };
    }
    if (positionals.length > 1) {
      return { ok: false, error: "corridor breaker status takes at most one corridor id" };
    }
    return { ok: true, command: { kind: "status", corridorId: positionals[0] } };
  }

  // Not optional, and not "optional but nice". A reset with no recorded reason
  // is indistinguishable, six months later, from somebody clearing alerts at
  // 3am without reading the lane.
  if (reason === undefined || reason.trim() === "") {
    return {
      ok: false,
      error: 'corridor breaker reset requires --reason "why you reopened it"',
    };
  }
  if (positionals.length === 0) {
    return { ok: false, error: "corridor breaker reset requires a corridor id" };
  }
  if (positionals.length > 1) {
    return { ok: false, error: "corridor breaker reset takes exactly one corridor id" };
  }
  return { ok: true, command: { kind: "reset", corridorId: positionals[0], reason } };
}

// --- Rendering -----------------------------------------------------------

function iso(ms?: number): string {
  return ms === undefined ? "-" : new Date(ms).toISOString();
}

function marker(state: BreakerRecord["state"]): string {
  // The same vocabulary as `corridor plan`'s liveness line, so an operator
  // reading both does not have to learn two sets of marks.
  return state === "open" ? "✗ OPEN" : "✓ CLOSED";
}

/** One corridor, in full. Used by `status <id>` and to confirm a `reset`. */
export function formatBreakerRecord(
  record: BreakerRecord | undefined,
  corridorId: string,
): string {
  const lines: string[] = [`corridor: ${corridorId}`];
  if (!record) {
    // No row is genuinely different from a row that says zero failures: nothing
    // has ever finished a run on this lane, so there is no evidence either way.
    lines.push("breaker:  ? UNKNOWN — no run has finished on this corridor yet");
    lines.push("          (nothing to reset; a row appears after the first terminal run)");
    return lines.join("\n");
  }
  lines.push(`breaker:  ${marker(record.state)} — ${describe(record)}`);
  lines.push(`failures: ${record.consecutiveFailures} consecutive`);
  lines.push(`tripped:  ${iso(record.trippedAt)}`);
  lines.push(`last:     ${record.lastError ?? "-"}`);
  if (record.resetAt !== undefined) {
    lines.push(
      `reset:    by ${record.resetBy ?? "?"} at ${iso(record.resetAt)} — "${record.resetReason ?? ""}"`,
    );
  }
  return lines.join("\n");
}

function describe(record: BreakerRecord): string {
  if (record.state === "open")
    return `halted since ${iso(record.trippedAt)}, refusing new runs`;
  if (record.consecutiveFailures > 0) {
    // Deliberately does NOT say how close the lane is to tripping: the threshold
    // lives in the corridor manifest, not in this row, so "1 failure short of
    // tripping" would be a guess that is wrong whenever the manifest says
    // anything but 2. The count is on the next line for the operator to compare.
    return `${record.consecutiveFailures} consecutive failure(s) recorded, still accepting new runs`;
  }
  return "accepting new runs";
}

/** Every lane with a row, one line each. Used by `status` with no id. */
export function formatBreakerTable(records: readonly BreakerRecord[]): string {
  if (records.length === 0) {
    return "no breaker state recorded — no corridor has finished a run yet.";
  }
  const rows = records.map((r) => [
    r.corridorId,
    r.state,
    String(r.consecutiveFailures),
    iso(r.trippedAt),
    r.lastError ?? "-",
  ]);
  const header = ["CORRIDOR", "STATE", "FAILURES", "TRIPPED", "LAST ERROR"];
  // Halted lanes first: that is the row the operator is looking for, and a
  // sorted-by-id table buries it under healthy lanes.
  const order = [...rows].sort((a, b) => {
    if ((a[1] === "open") !== (b[1] === "open")) return a[1] === "open" ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });
  const widths = header.map((h, i) => Math.max(h.length, ...order.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...order.map(line)].join("\n");
}

/**
 * Confirmation for a `reset`, including whether the lane was actually halted.
 * `by` is the name the store recorded (`record.resetBy`), not the caller's own
 * claim: the confirmation shows exactly what was written to the audit trail.
 */
export function formatBreakerReset(record: BreakerRecord, wasOpen: boolean): string {
  const lines = [
    `corridor: ${record.corridorId}`,
    `breaker:  ${marker(record.state)} — reset at ${iso(record.updatedAt)}`,
  ];
  if (!wasOpen) {
    // Say so rather than printing a triumphant "reopened". A reset of a lane
    // that was not halted is usually someone re-running a command they thought
    // had failed, and it should be visible that nothing was actually released.
    lines.push("note:     this corridor was not halted — the reset was recorded anyway.");
  }
  lines.push(`by:       ${record.resetBy ?? "unknown"}`);
  lines.push(`reason:   "${record.resetReason ?? ""}"`);
  return lines.join("\n");
}

/** The OS account that ran the command, recorded with every reset. */
export function currentUser(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const u = userInfo();
    if (u.username) return u.username;
  } catch {
    // No passwd entry for this uid (common in distroless/CI containers) — fall
    // through to the environment rather than losing the audit field entirely.
  }
  return env.USER || env.USERNAME || env.LOGNAME || "unknown";
}

// --- Database ------------------------------------------------------------

/** A `Queryable` that also knows how to shut itself down. `pg.Pool` satisfies it. */
export interface ClosableQueryable extends Queryable {
  end(): Promise<void>;
}

export interface BreakerSession {
  readonly store: CorridorHealthStore;
  close(): Promise<void>;
}

export type OpenResult =
  | { readonly ok: true; readonly session: BreakerSession }
  | { readonly ok: false; readonly error: string };

/**
 * Open a breaker store on `DATABASE_URL`.
 *
 * `pg` is imported dynamically and reported as a missing optional dependency
 * rather than a crash, so an operator who mistyped the URL gets told what the
 * URL was for instead of a module-resolution stack trace.
 */
export async function openBreakerSession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenResult> {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    return {
      ok: false,
      error:
        "DATABASE_URL is not set. The breaker commands read the same Postgres the engine uses; set it to a connection string, e.g.\n" +
        "  DATABASE_URL=postgres://corridor:corridor@localhost:5432/corridor pnpm cli breaker status",
    };
  }
  let Pool: new (config: { connectionString: string }) => ClosableQueryable;
  try {
    ({ Pool } = (await import("pg")) as unknown as {
      Pool: new (config: { connectionString: string }) => ClosableQueryable;
    });
  } catch {
    return {
      ok: false,
      error:
        "the `pg` package is required for `corridor breaker …` and is not installed. Add it next to the CLI: pnpm add pg",
    };
  }
  const pool = new Pool({ connectionString: url });
  return {
    ok: true,
    session: {
      store: new PostgresCorridorHealthStore(pool),
      close: () => pool.end(),
    },
  };
}
