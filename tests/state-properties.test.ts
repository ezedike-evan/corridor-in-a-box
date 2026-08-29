// Structural properties of the corridor state machine.
//
// The state table is small enough to check exhaustively rather than by example,
// so these tests explore every state and every path rather than the handful
// someone remembered to write down. The properties are about MONEY SAFETY: a
// payment that can re-enter settlement after settling is a double-spend, and a
// payment that can reach a state with no exit is stuck funds.

import { describe, expect, it } from "vitest";
import { canTransition, isTerminal, TERMINAL, type CorridorState } from "@corridor/engine";

const ALL: CorridorState[] = [
  "created",
  "quoted",
  "compliant",
  "opened",
  "settling",
  "retrying",
  "settled",
  "reconciled",
  "completed",
  "recovering",
  "refund_pending",
  "refunded",
  "held",
  "failed",
];

const successors = (s: CorridorState): CorridorState[] =>
  ALL.filter((to) => canTransition(s, to));

/** Every state reachable from `start`, by breadth-first search. */
function reachableFrom(start: CorridorState): Set<CorridorState> {
  const seen = new Set<CorridorState>();
  const queue: CorridorState[] = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const next of successors(s)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("state machine structure", () => {
  it("covers every declared state", () => {
    // Guards against a state being added to the type but not to this list,
    // which would silently shrink everything below.
    expect(ALL.length).toBe(new Set(ALL).size);
    for (const s of ALL) {
      // A state the table does not know about would throw here.
      expect(() => successors(s)).not.toThrow();
    }
  });

  it("terminal states are absorbing — nothing leaves them", () => {
    for (const s of ALL.filter(isTerminal)) {
      expect(successors(s), `${s} should be terminal`).toEqual([]);
    }
  });

  it("exactly the documented states are terminal", () => {
    expect([...TERMINAL].sort()).toEqual(["completed", "failed", "held", "refunded"]);
  });

  it("no state can transition to itself", () => {
    // A self-loop would let a run spin without advancing `version`, which is
    // what crash-resume and the optimistic-concurrency guard key on.
    for (const s of ALL) {
      expect(canTransition(s, s), `${s} -> ${s}`).toBe(false);
    }
  });

  it("every non-terminal state can still reach a terminal state", () => {
    // A non-terminal state with no route to a terminal is stuck funds: the
    // engine would keep a payment alive forever with no resolution.
    for (const s of ALL.filter((x) => !isTerminal(x))) {
      const reachable = reachableFrom(s);
      const terminals = [...reachable].filter(isTerminal);
      expect(terminals.length, `${s} cannot reach any terminal state`).toBeGreaterThan(0);
    }
  });

  it("every state is reachable from created", () => {
    const reachable = reachableFrom("created");
    for (const s of ALL.filter((x) => x !== "created")) {
      expect(reachable.has(s), `${s} is unreachable from created`).toBe(true);
    }
  });

  it("created is never re-enterable", () => {
    // Nothing may return a run to the start; that would reset the trail and
    // make an in-flight payment look brand new.
    for (const s of ALL) {
      expect(canTransition(s, "created"), `${s} -> created`).toBe(false);
    }
  });

  // --- the double-settlement properties ---------------------------------

  it("settled can never return to settling", () => {
    // The direct form of the double-spend.
    expect(canTransition("settled", "settling")).toBe(false);
  });

  it("no path from settled leads back into settling", () => {
    // The indirect form: settled -> recovering -> settling would re-send a
    // payment that already went out. Recovery from settled must go forward
    // (reconcile) or sideways (held/refunded/failed), never back to the chain.
    const reachable = reachableFrom("settled");
    expect(reachable.has("settling"), "settled can re-enter settling via a longer path").toBe(
      false,
    );
  });

  it("no path from refund_pending leads back into settling", () => {
    // refund_pending is entered after money has left, exactly like
    // recovering. The same rule applies with no exceptions: a path back to
    // settling would re-submit a payment that already went out, so it must
    // be unreachable by construction in the table — checked over ALL paths,
    // not just direct edges, because that is how the settled -> recovering ->
    // settling double-spend slipped past the direct check historically.
    const reachable = reachableFrom("refund_pending");
    expect(
      reachable.has("settling"),
      "refund_pending can re-enter settling via some path",
    ).toBe(false);
  });

  it("no path from reconciled or completed leads back into settling", () => {
    for (const s of ["reconciled", "completed"] as CorridorState[]) {
      expect(reachableFrom(s).has("settling"), `${s} can re-enter settling`).toBe(false);
    }
  });

  it("only settling reaches settled", () => {
    // The single door into "money has left". Any second entrance is a path
    // that skips the submitter.
    const entrances = ALL.filter((s) => canTransition(s, "settled"));
    expect(entrances).toEqual(["settling"]);
  });

  it("only retrying can re-enter settling", () => {
    // Retry exists and is intended, but it must go through `retrying`, which is
    // reachable only from a settle that failed BEFORE money moved. `recovering`
    // — which a post-settlement failure enters — deliberately cannot get back.
    const entrances = ALL.filter((s) => canTransition(s, "settling")).sort();
    expect(entrances).toEqual(["opened", "retrying"]);
  });

  it("completed is only reachable after reconciliation", () => {
    const entrances = ALL.filter((s) => canTransition(s, "completed"));
    expect(entrances).toEqual(["reconciled"]);
  });

  it("refunded and held are only reachable through the recovery family", () => {
    // Both doors into "the payment did not complete normally" open only from
    // recovery states: the synchronous split (`recovering`) or the async
    // anchor-driven refund wait (`refund_pending`). Any other entrance would
    // let a run park without having gone through recovery at all.
    for (const s of ["refunded", "held"] as CorridorState[]) {
      const entrances = ALL.filter((from) => canTransition(from, s)).sort();
      expect(entrances, `${s} bypasses recovery`).toEqual(["recovering", "refund_pending"]);
    }
  });

  it("refund_pending is only reachable through recovering", () => {
    const entrances = ALL.filter((from) => canTransition(from, "refund_pending"));
    expect(entrances).toEqual(["recovering"]);
  });

  it("refund_pending is not terminal — money is still in motion", () => {
    // An async refund with no state of its own is a run that looks finished
    // while funds are moving; the state exists precisely so the run stays
    // visibly unfinished until the anchor answers.
    expect(isTerminal("refund_pending")).toBe(false);
    expect(TERMINAL.has("refund_pending")).toBe(false);
    expect(successors("refund_pending").length).toBeGreaterThan(0);
  });

  it("failed is reachable from every non-terminal state", () => {
    // Any step can fail, and the engine must always have somewhere to put it.
    for (const s of ALL.filter((x) => !isTerminal(x))) {
      expect(canTransition(s, "failed"), `${s} cannot fail`).toBe(true);
    }
  });

  it("the happy path is exactly the documented sequence", () => {
    const happy: CorridorState[] = [
      "created",
      "quoted",
      "compliant",
      "opened",
      "settling",
      "settled",
      "reconciled",
      "completed",
    ];
    for (let i = 0; i < happy.length - 1; i++) {
      expect(canTransition(happy[i], happy[i + 1]), `${happy[i]} -> ${happy[i + 1]}`).toBe(
        true,
      );
    }
    expect(isTerminal(happy[happy.length - 1])).toBe(true);
  });

  it("no walk of the graph can visit settled twice", () => {
    // Exhaustive over simple paths: enumerate every route from created and
    // assert none contains `settled` more than once. This is the property the
    // whole idempotency layer exists to protect, checked structurally.
    const paths: CorridorState[][] = [];
    const walk = (state: CorridorState, path: CorridorState[]) => {
      // Bound the search: revisiting a state on the same path means a cycle,
      // and cycles are enumerated once rather than followed forever.
      if (path.filter((p) => p === state).length > 1) {
        paths.push(path);
        return;
      }
      const next = successors(state);
      if (next.length === 0) {
        paths.push(path);
        return;
      }
      for (const n of next) walk(n, [...path, n]);
    };
    walk("created", ["created"]);

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const settledCount = path.filter((s) => s === "settled").length;
      expect(
        settledCount,
        `path visits settled twice: ${path.join(" -> ")}`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
