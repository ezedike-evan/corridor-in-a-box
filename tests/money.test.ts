import { describe, expect, it } from "vitest";
import {
  addAmounts,
  applyPrice,
  compareAmounts,
  fromScaled,
  isValidAmount,
  moneyAdd,
  subAmounts,
  toScaled,
} from "@corridor/types";

describe("money: validation", () => {
  it("accepts well-formed decimals and rejects junk", () => {
    expect(isValidAmount("100")).toBe(true);
    expect(isValidAmount("100.0000001")).toBe(true);
    expect(isValidAmount("-5.5")).toBe(true);
    expect(isValidAmount("1,000")).toBe(false);
    expect(isValidAmount("abc")).toBe(false);
    expect(isValidAmount("")).toBe(false);
  });

  it("rejects more decimal places than the scale allows", () => {
    const r = toScaled("1.123456789"); // 9 dp > 7
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AMOUNT_INVALID");
  });
});

describe("money: round-trip and arithmetic", () => {
  it("round-trips through scaled BigInt without losing precision", () => {
    const r = toScaled("123.4567891".slice(0, 11)); // 7 dp
    expect(r.ok).toBe(true);
    if (r.ok) expect(fromScaled(r.value)).toBe("123.4567891".slice(0, 11));
  });

  it("adds and subtracts exactly (no float drift)", () => {
    const sum = addAmounts("0.1", "0.2");
    expect(sum.ok && sum.value).toBe("0.3"); // the classic 0.30000000000000004 trap
    const diff = subAmounts("100.00", "0.01");
    expect(diff.ok && diff.value).toBe("99.99");
  });

  it("compares amounts", () => {
    expect(compareAmounts("1.0", "1.00")).toEqual({ ok: true, value: 0 });
    expect(compareAmounts("2", "10")).toEqual({ ok: true, value: -1 });
    expect(compareAmounts("10", "2")).toEqual({ ok: true, value: 1 });
  });
});

describe("money: applyPrice (the FX leg)", () => {
  it("multiplies by a price and rounds half-up", () => {
    const whole = applyPrice("100", "1.5");
    expect(whole.ok && whole.value).toBe("150");
    // 100 * 0.3333334 = 33.33334
    const r = applyPrice("100", "0.3333334");
    expect(r.ok && r.value).toBe("33.33334");
  });

  it("propagates validation errors", () => {
    const r = applyPrice("100", "not-a-price");
    expect(r.ok).toBe(false);
  });
});

describe("money: moneyAdd guards asset mismatch", () => {
  it("rejects adding different assets", () => {
    const r = moneyAdd({ asset: "USDC", amount: "1" }, { asset: "iso4217:ARS", amount: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AMOUNT_INVALID");
  });

  it("adds same-asset money", () => {
    const r = moneyAdd({ asset: "USDC", amount: "1.25" }, { asset: "USDC", amount: "2.75" });
    expect(r.ok && r.value).toEqual({ asset: "USDC", amount: "4" });
  });
});
