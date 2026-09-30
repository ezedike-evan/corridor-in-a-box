import { describe, expect, it } from "vitest";
import { constantTimeEqual, isPreSettleCode, type CorridorErrorCode } from "@corridor/types";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("secret-key-123", "secret-key-123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("secret-key-123", "secret-key-124")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(constantTimeEqual("short", "a-much-longer-string")).toBe(false);
  });

  it("returns false against an empty string", () => {
    expect(constantTimeEqual("nonempty", "")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("isPreSettleCode", () => {
  const preSettleCodes: CorridorErrorCode[] = [
    "PRESETTLE_ANCHOR_DRIFT",
    "PRESETTLE_TX_MISMATCH",
    "PRESETTLE_DESTINATION_UNSAFE",
    "PRESETTLE_INSUFFICIENT_FUNDS",
    "PRESETTLE_QUOTE_WINDOW",
    "PRESETTLE_AMOUNT_OUT_OF_RANGE",
    "PRESETTLE_RECEIVER_NOT_ACCEPTED",
  ];

  it("returns true for every PRESETTLE_* error code", () => {
    for (const code of preSettleCodes) {
      expect(isPreSettleCode(code)).toBe(true);
    }
  });

  it("returns false for SETTLEMENT_FAILED", () => {
    expect(isPreSettleCode("SETTLEMENT_FAILED")).toBe(false);
  });

  it("returns false for other non-presettle error codes", () => {
    const nonPreSettleCodes: CorridorErrorCode[] = [
      "MANIFEST_INVALID",
      "AMOUNT_INVALID",
      "QUOTE_UNAVAILABLE",
      "SETTLEMENT_FAILED",
      "QUOTE_EXPIRED",
      "KYC_REQUIRED",
      "KYC_REJECTED",
      "ANCHOR_UNAVAILABLE",
      "SETTLEMENT_TIMEOUT",
      "REFUND_UNSUPPORTED",
      "RECONCILE_MISMATCH",
      "RECONCILE_STALLED",
      "IDEMPOTENCY_CONFLICT",
      "CORRIDOR_UNPROVEN",
      "CORRIDOR_HALTED",
    ];

    for (const code of nonPreSettleCodes) {
      expect(isPreSettleCode(code)).toBe(false);
    }
  });
});
