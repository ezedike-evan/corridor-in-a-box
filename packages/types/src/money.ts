// Decimal-safe money arithmetic. Amounts are decimal STRINGS on the wire; all
// math happens on scaled BigInts so we never touch float64. Default scale is 7,
// Stellar's stroop precision — enough for both on-chain assets and ISO-4217
// payout amounts (which we round to their own precision at the edge).

import { fail, ok, type Money, type Outcome } from "./index";

/** Stellar represents amounts to 7 decimal places (stroops). */
export const STROOP_SCALE = 7;

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

/** True if `s` is a well-formed decimal amount string. */
export function isValidAmount(s: string): boolean {
  return AMOUNT_RE.test(s.trim());
}

/** Parse a decimal string into a scaled BigInt (units of 10^-scale). */
export function toScaled(amount: string, scale = STROOP_SCALE): Outcome<bigint> {
  const t = amount.trim();
  if (!AMOUNT_RE.test(t)) {
    return fail("AMOUNT_INVALID", `not a decimal amount: "${amount}"`);
  }
  const neg = t.startsWith("-");
  const [intPart, fracPart = ""] = t.replace("-", "").split(".");
  if (fracPart.length > scale) {
    return fail("AMOUNT_INVALID", `amount "${amount}" exceeds ${scale} decimal places`);
  }
  const mag = BigInt(intPart + fracPart.padEnd(scale, "0"));
  return ok(neg ? -mag : mag);
}

/** Format a scaled BigInt back to a canonical decimal string (no trailing zeros). */
export function fromScaled(v: bigint, scale = STROOP_SCALE): string {
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const cut = digits.length - scale;
  const intPart = digits.slice(0, cut);
  const fracPart = digits.slice(cut).replace(/0+$/, "");
  return (neg ? "-" : "") + (fracPart ? `${intPart}.${fracPart}` : intPart);
}

function combine(
  a: string,
  b: string,
  op: (x: bigint, y: bigint) => bigint,
  scale: number,
): Outcome<string> {
  const x = toScaled(a, scale);
  if (!x.ok) return x;
  const y = toScaled(b, scale);
  if (!y.ok) return y;
  return ok(fromScaled(op(x.value, y.value), scale));
}

export const addAmounts = (a: string, b: string, scale = STROOP_SCALE): Outcome<string> =>
  combine(a, b, (x, y) => x + y, scale);

export const subAmounts = (a: string, b: string, scale = STROOP_SCALE): Outcome<string> =>
  combine(a, b, (x, y) => x - y, scale);

/** -1 if a<b, 0 if equal, 1 if a>b. Returns an error if either is malformed. */
export function compareAmounts(
  a: string,
  b: string,
  scale = STROOP_SCALE,
): Outcome<-1 | 0 | 1> {
  const x = toScaled(a, scale);
  if (!x.ok) return x;
  const y = toScaled(b, scale);
  if (!y.ok) return y;
  return ok(x.value < y.value ? -1 : x.value > y.value ? 1 : 0);
}

/**
 * Multiply an amount by a price ("dest units per 1 source unit"), rounding the
 * result half-up to `scale` decimal places. This is the FX leg done on integers.
 */
export function applyPrice(
  amount: string,
  price: string,
  scale = STROOP_SCALE,
): Outcome<string> {
  const a = toScaled(amount, scale);
  if (!a.ok) return a;
  const p = toScaled(price, scale);
  if (!p.ok) return p;
  const factor = 10n ** BigInt(scale);
  const product = a.value * p.value; // now at 2*scale
  const half = factor / 2n;
  const rounded = (product + (product >= 0n ? half : -half)) / factor;
  return ok(fromScaled(rounded, scale));
}

/** Add two Money values of the same asset. Rejects asset mismatch. */
export function moneyAdd(a: Money, b: Money): Outcome<Money> {
  if (a.asset !== b.asset) {
    return fail("AMOUNT_INVALID", `cannot add ${a.asset} to ${b.asset}`);
  }
  const sum = addAmounts(a.amount, b.amount);
  if (!sum.ok) return sum;
  return ok({ asset: a.asset, amount: sum.value });
}
