import { describe, expect, it } from "vitest";
import {
  isUsableSep31OffRamp,
  renderSweepJson,
  renderSweepMarkdown,
  sepBit,
  probeBit,
  type ProbeResult,
} from "@corridor/probe";

describe("probe report generation", () => {
  const healthyResult: ProbeResult = {
    domain: "healthy.example.com",
    seps: sepBit(1) | sepBit(10) | sepBit(31),
    probesRun: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
    probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
    tomlHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    outcomes: [
      { probe: "toml_fetch", passed: true, detail: "stellar.toml fetched and parsed" },
      { probe: "sep10_auth", passed: true, detail: "JWT issued for signer" },
      { probe: "sep31_info", passed: true, detail: "SEP-31 info lists 2 asset(s)" },
    ],
  };

  const brokenSep31Result: ProbeResult = {
    domain: "broken-sep31.example.com",
    seps: sepBit(1) | sepBit(10) | sepBit(31),
    probesRun: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
    probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth"),
    tomlHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    outcomes: [
      { probe: "toml_fetch", passed: true, detail: "stellar.toml fetched and parsed" },
      { probe: "sep10_auth", passed: true, detail: "JWT issued for signer" },
      { probe: "sep31_info", passed: false, detail: "500 Internal Server Error" },
    ],
  };

  const tomlFailureResult: ProbeResult = {
    domain: "unreachable.example.com",
    seps: 0,
    probesRun: probeBit("toml_fetch"),
    probesPassed: 0,
    tomlHash: "0000000000000000000000000000000000000000000000000000000000000000",
    outcomes: [
      {
        probe: "toml_fetch",
        passed: false,
        detail: "getaddrinfo ENOTFOUND unreachable.example.com",
      },
    ],
  };

  describe("isUsableSep31OffRamp", () => {
    it("returns true when SEP-31 is advertised and sep31_info passed", () => {
      expect(isUsableSep31OffRamp(healthyResult)).toBe(true);
    });

    it("returns false when sep31_info probe failed", () => {
      expect(isUsableSep31OffRamp(brokenSep31Result)).toBe(false);
    });

    it("returns false when toml fetch failed", () => {
      expect(isUsableSep31OffRamp(tomlFailureResult)).toBe(false);
    });
  });

  describe("renderSweepMarkdown", () => {
    it("renders markdown table containing headers and domain rows", () => {
      const md = renderSweepMarkdown([healthyResult, brokenSep31Result, tomlFailureResult]);

      expect(md).toContain("# Anchor Sweep Report");
      expect(md).toContain(
        "| Domain | Advertised SEPs | Passed Probes | Failed Probes | Usable SEP-31 Off-Ramp |",
      );
      expect(md).toContain(
        "| healthy.example.com | SEP-1, SEP-10, SEP-31 | toml_fetch, sep10_auth, sep31_info | none | Yes |",
      );
      expect(md).toContain(
        "| broken-sep31.example.com | SEP-1, SEP-10, SEP-31 | toml_fetch, sep10_auth | sep31_info (500 Internal Server Error) | No |",
      );
      expect(md).toContain(
        "| unreachable.example.com | none | none | toml_fetch (getaddrinfo ENOTFOUND unreachable.example.com) | No |",
      );
    });
  });

  describe("renderSweepJson", () => {
    it("serializes probe results into formatted JSON string", () => {
      const json = renderSweepJson([healthyResult]);
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].domain).toBe("healthy.example.com");
      expect(parsed[0].tomlHash).toBe(healthyResult.tomlHash);
    });
  });
});
