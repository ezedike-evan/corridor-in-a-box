import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "@corridor/types";

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
