// Property tests for the money layer.
//
// The example-based tests in money.test.ts check the cases someone thought of.
// These check the invariants that must hold for EVERY input, which is the right
// bar for arithmetic that decides how much value leaves an account. No external
// property-testing dependency: a seeded generator gives reproducible runs, and a
// failure prints the input that caused it.

import { describe, expect, it } from "vitest";
import {
  addAmounts,
  applyPrice,
  compareAmounts,
  fromScaled,
  isSettleableAmount,
  isValidAmount,
  moneyAdd,
  STROOP_SCALE,
  subAmounts,
  toScaled,
} from "@corridor/types";

/**
 * Deterministic PRNG (mulberry32). Seeded so a failing run is reproducible —
 * a property test that cannot be replayed is a flake generator, not a test.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 400;

/** A decimal string with up to `scale` places, occasionally negative/large. */
function amount(r: () => number, opts: { signed?: boolean } = {}): string {
  const magnitude = Math.floor(r() * 12); // 0 → ~1e12, spanning realistic sizes
  const int = Math.floor(r() * 10 ** magnitude).toString();
  const places = Math.floor(r() * (STROOP_SCALE + 1));
  const frac =
    places === 0
      ? ""
      : "." + Array.from({ length: places }, () => Math.floor(r() * 10)).join("");
  const sign = opts.signed && r() < 0.35 ? "-" : "";
  return `${sign}${int}${frac}`;
}

function unwrap<T>(o: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!o.ok) throw new Error(`expected ok, got: ${o.error.message}`);
  return o.value;
}

describe("money properties", () => {
  it("toScaled/fromScaled round-trips every well-formed amount", () => {
    const r = rng(0xc0ffee);
    for (let i = 0; i < RUNS; i++) {
      const a = amount(r, { signed: true });
      const scaled = toScaled(a);
      expect(scaled.ok, `toScaled rejected ${a}`).toBe(true);
      const back = fromScaled(unwrap(scaled));
      // Canonical form: re-scaling the round-tripped value must be identical,
      // which is the property that matters (trailing zeros are not preserved).
      expect(unwrap(toScaled(back)), `round-trip drifted for ${a}`).toBe(unwrap(scaled));
    }
  });

  it("addition is commutative", () => {
    const r = rng(1);
    for (let i = 0; i < RUNS; i++) {
      const [a, b] = [amount(r, { signed: true }), amount(r, { signed: true })];
      expect(unwrap(addAmounts(a, b)), `${a} + ${b}`).toBe(unwrap(addAmounts(b, a)));
    }
  });

  it("addition is associative", () => {
    const r = rng(2);
    for (let i = 0; i < RUNS; i++) {
      const [a, b, c] = [
        amount(r, { signed: true }),
        amount(r, { signed: true }),
        amount(r, { signed: true }),
      ];
      const left = unwrap(addAmounts(unwrap(addAmounts(a, b)), c));
      const right = unwrap(addAmounts(a, unwrap(addAmounts(b, c))));
      expect(left, `(${a}+${b})+${c} vs ${a}+(${b}+${c})`).toBe(right);
    }
  });

  it("subtracting then adding restores the original", () => {
    const r = rng(3);
    for (let i = 0; i < RUNS; i++) {
      const [a, b] = [amount(r, { signed: true }), amount(r, { signed: true })];
      const restored = unwrap(addAmounts(unwrap(subAmounts(a, b)), b));
      expect(unwrap(toScaled(restored)), `${a} - ${b} + ${b}`).toBe(unwrap(toScaled(a)));
    }
  });

  it("a - a is exactly zero for every amount", () => {
    const r = rng(4);
    for (let i = 0; i < RUNS; i++) {
      const a = amount(r, { signed: true });
      expect(unwrap(subAmounts(a, a)), `${a} - ${a}`).toBe("0");
    }
  });

  it("compareAmounts is a total order consistent with subtraction", () => {
    const r = rng(5);
    for (let i = 0; i < RUNS; i++) {
      const [a, b] = [amount(r, { signed: true }), amount(r, { signed: true })];
      const cmp = unwrap(compareAmounts(a, b));
      const diff = unwrap(toScaled(unwrap(subAmounts(a, b))));
      if (cmp === 0) expect(diff, `${a} vs ${b}`).toBe(0n);
      if (cmp === 1) expect(diff > 0n, `${a} > ${b}`).toBe(true);
      if (cmp === -1) expect(diff < 0n, `${a} < ${b}`).toBe(true);
      // Antisymmetry.
      expect(unwrap(compareAmounts(b, a))).toBe(-cmp as -1 | 0 | 1);
    }
  });

  it("multiplying by 1 is the identity", () => {
    const r = rng(6);
    for (let i = 0; i < RUNS; i++) {
      const a = amount(r, { signed: true });
      const out = unwrap(applyPrice(a, "1"));
      expect(unwrap(toScaled(out)), `${a} × 1`).toBe(unwrap(toScaled(a)));
    }
  });

  it("multiplying by 0 is 0", () => {
    const r = rng(7);
    for (let i = 0; i < RUNS; i++) {
      const a = amount(r, { signed: true });
      expect(unwrap(applyPrice(a, "0")), `${a} × 0`).toBe("0");
    }
  });

  it("applyPrice rounds to at most the configured scale", () => {
    const r = rng(8);
    for (let i = 0; i < RUNS; i++) {
      const [a, p] = [amount(r), amount(r)];
      const out = unwrap(applyPrice(a, p));
      const places = out.includes(".") ? out.split(".")[1].length : 0;
      expect(places, `${a} × ${p} = ${out}`).toBeLessThanOrEqual(STROOP_SCALE);
    }
  });

  it("applyPrice never drifts more than half a unit of the last place", () => {
    const r = rng(9);
    const factor = 10n ** BigInt(STROOP_SCALE);
    for (let i = 0; i < RUNS; i++) {
      const [a, p] = [amount(r), amount(r)];
      const exact = unwrap(toScaled(a)) * unwrap(toScaled(p)); // at 2× scale
      const got = unwrap(toScaled(unwrap(applyPrice(a, p)))) * factor; // lift to 2× scale
      const drift = exact > got ? exact - got : got - exact;
      // Half-up rounding: the error can never reach a full unit of the last place.
      expect(drift <= factor / 2n, `${a} × ${p}: drift ${drift}`).toBe(true);
    }
  });

  it("rejects amounts with more decimal places than the scale allows", () => {
    const tooPrecise = "1." + "1".repeat(STROOP_SCALE + 1);
    expect(toScaled(tooPrecise).ok).toBe(false);
  });

  it("isSettleableAmount accepts exactly the positive well-formed amounts", () => {
    const r = rng(10);
    for (let i = 0; i < RUNS; i++) {
      const a = amount(r, { signed: true });
      const scaled = toScaled(a);
      const expected = scaled.ok && unwrap(scaled) > 0n;
      expect(isSettleableAmount(a), `isSettleableAmount(${a})`).toBe(expected);
      // Everything settleable is also syntactically valid, but not the reverse.
      if (isSettleableAmount(a)) expect(isValidAmount(a)).toBe(true);
    }
  });

  it("moneyAdd refuses to mix assets no matter the amounts", () => {
    const r = rng(11);
    for (let i = 0; i < 50; i++) {
      const out = moneyAdd(
        { asset: "USDC", amount: amount(r) },
        { asset: "EURC", amount: amount(r) },
      );
      expect(out.ok).toBe(false);
    }
  });

  it("never produces a float artefact like 0.30000000000000004", () => {
    // The reason this layer exists at all: 0.1 + 0.2 in float64 is not 0.3.
    expect(unwrap(addAmounts("0.1", "0.2"))).toBe("0.3");
    const r = rng(12);
    for (let i = 0; i < RUNS; i++) {
      const out = unwrap(addAmounts(amount(r, { signed: true }), amount(r, { signed: true })));
      expect(out, `produced ${out}`).not.toMatch(/e|E|Infinity|NaN/);
    }
  });
});
