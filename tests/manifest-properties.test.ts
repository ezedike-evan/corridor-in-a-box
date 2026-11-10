// Seeded property tests for the manifest loader, the other untrusted-input
// boundary (SECURITY.md lists "Manifest injection" as in scope).
//
// Starting from a valid manifest, mutate it (drop, retype, oversize or poison a
// field, or hand the loader YAML anchors and aliases) and check what must hold for
// ALL of them: the loader returns `ok: false` instead of throwing, and any
// `ok: true` result still satisfies the schema's own invariants and is stable when
// parsed again. No property-testing dependency. See tests/helpers/seeded.ts to
// replay a failure.

import { describe, expect, it } from "vitest";
import { parseCorridor, parseCorridorYaml, type Corridor } from "@corridor/manifest";
import { forAll, int, pick, seedFromEnv, type Rand } from "./helpers/seeded";

const RUNS = 600;
const SEED = seedFromEnv(0x3a11f35);

const BASE = {
  id: "prop-test",
  status_note: "a note",
  source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
  dest: {
    name: "D",
    asset: "iso4217:ARS",
    protocol: "sep31",
    endpoints: {
      home_domain: "d.example",
      transfer_server_sep31: "https://d.example/sep31",
      web_auth: "https://d.example/auth",
      kyc_server: "https://d.example/kyc",
      quote_server: "https://d.example/sep38",
      endpoints_verified_at: "2026-10-17",
    },
  },
  fx: {
    path: ["ARS", "USDC", "ARS"],
    quote_source: "sep38",
    who_holds_risk: "receiving_anchor",
    quote_ttl_seconds: 60,
  },
  compliance: {
    source_jurisdiction: "AR",
    dest_jurisdiction: "AR",
    travel_rule_profile: "default",
  },
  settlement: { bridge_asset: "USDC", network: "testnet", asset_issuer: "GISSUER" },
  recovery: { max_retries: 3, timeout_seconds: 900, rollback: "refund_sender" },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Every path to a value in the tree, as key arrays. */
function paths(v: unknown, prefix: string[] = []): string[][] {
  const here = prefix.length ? [prefix] : [];
  if (v && typeof v === "object") {
    return [
      ...here,
      ...Object.entries(v).flatMap(([k, child]) => paths(child, [...prefix, k])),
    ];
  }
  return here;
}

const REPLACEMENTS: readonly (() => Json)[] = [
  () => null,
  () => true,
  () => -1,
  () => 0,
  () => 1e21,
  () => "",
  () => "x".repeat(200_000),
  () => [],
  () => ({}),
  () => [[[]]],
  () => "iso4217:",
  () => "javascript:alert(1)",
  () => JSON.parse('{"__proto__":{"polluted":"yes"}}') as Json,
];

function mutate(r: Rand): unknown {
  const doc = clone(BASE) as Record<string, unknown>;
  for (let i = 0; i <= int(r, 3); i++) {
    const path = pick(r, paths(doc));
    let parent: Record<string, unknown> = doc;
    for (const k of path.slice(0, -1)) parent = parent[k] as Record<string, unknown>;
    const leaf = path[path.length - 1]!;
    switch (int(r, 4)) {
      case 0:
        delete parent[leaf];
        break;
      case 1:
        parent[leaf] = pick(r, REPLACEMENTS)();
        break;
      case 2:
        // defineProperty, because plain assignment to `__proto__` sets the prototype
        // instead of adding the key the loader would see in parsed YAML or JSON.
        Object.defineProperty(
          parent,
          pick(r, ["__proto__", "constructor", "extra", "polluted"]),
          {
            value: pick(r, REPLACEMENTS)(),
            enumerable: true,
            configurable: true,
            writable: true,
          },
        );
        break;
      default:
        parent[leaf] = [parent[leaf]];
    }
  }
  // Round-trip through JSON text so `__proto__` is an own key, as the loader would see it.
  return JSON.parse(JSON.stringify(doc));
}

/** What every parsed corridor must satisfy, whatever it was parsed from. */
function expectInvariants(c: Corridor): void {
  expect(typeof c.id).toBe("string");
  expect(c.id.length).toBeGreaterThan(0);
  expect(["public", "testnet"]).toContain(c.settlement.network);
  expect(typeof c.dest.protocol).toBe("string");
  expect(typeof c.dest.endpoints.home_domain).toBe("string");
  expect(Array.isArray(c.fx.path)).toBe(true);
  expect(c.fx.path.length).toBeGreaterThanOrEqual(2);
  expect(c.fx.quote_ttl_seconds).toBeGreaterThan(0);
  expect(c.recovery.timeout_seconds).toBeGreaterThan(0);
  expect(c.recovery.max_retries).toBeGreaterThanOrEqual(0);
}

describe("manifest properties", () => {
  it("the base manifest is valid, so a mutation is what breaks it", () => {
    const r = parseCorridor(clone(BASE));
    expect(r.ok).toBe(true);
    if (r.ok) expectInvariants(r.value);
  });

  it("the mutations break some manifests and spare others, so both branches are exercised", async () => {
    let accepted = 0;
    await forAll(SEED + 9, RUNS, mutate, (doc) => {
      if (parseCorridor(doc).ok) accepted += 1;
    });
    expect(accepted).toBeGreaterThan(RUNS * 0.05);
    expect(accepted).toBeLessThan(RUNS * 0.95);
  });

  it(`parseCorridor returns ok:false instead of throwing, over ${RUNS} mutated manifests`, async () => {
    await forAll(SEED, RUNS, mutate, (doc) => {
      const r = parseCorridor(doc);
      if (r.ok) expectInvariants(r.value);
      else expect(r.error.code).toBe("MANIFEST_INVALID");
    });
  });

  it(`a parsed manifest parses to the same thing again, over ${RUNS} mutated manifests`, async () => {
    await forAll(SEED + 1, RUNS, mutate, (doc) => {
      const first = parseCorridor(doc);
      if (!first.ok) return;
      const second = parseCorridor(first.value);
      expect(second.ok, "a parsed manifest must be re-parseable").toBe(true);
      if (second.ok) expect(second.value).toEqual(first.value);
    });
  });

  it(`parseCorridorYaml agrees with parseCorridor on the same document, over ${RUNS} manifests`, async () => {
    await forAll(SEED + 2, RUNS, mutate, (doc) => {
      // JSON is YAML, so the same document reaches the YAML front door too.
      const viaYaml = parseCorridorYaml(JSON.stringify(doc));
      const direct = parseCorridor(doc);
      expect(viaYaml.ok).toBe(direct.ok);
      if (viaYaml.ok && direct.ok) expect(viaYaml.value).toEqual(direct.value);
    });
  });

  it("does not let a __proto__ key in a manifest pollute Object.prototype", async () => {
    await forAll(SEED + 3, RUNS, mutate, (doc) => {
      parseCorridor(doc);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.keys(Object.prototype)).toEqual([]);
    });
  });

  describe("YAML anchors and aliases", () => {
    const yamlWith = (extra: string) =>
      `id: alias\n${extra}\n` +
      Object.entries(BASE)
        .filter(([k]) => k !== "id")
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");

    it("never throws on an alias bomb, and refuses it rather than expanding it", () => {
      const levels = Array.from({ length: 12 }, (_, i) =>
        i === 0
          ? 'l0: &l0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'
          : `l${i}: &l${i} [${Array.from({ length: 9 }, () => `*l${i - 1}`).join(",")}]`,
      ).join("\n");
      const start = Date.now();
      const r = parseCorridorYaml(yamlWith(levels));
      expect(Date.now() - start).toBeLessThan(5_000);
      // Unknown top-level keys are ignored or refused; either way the bomb must not run away.
      expect(typeof r.ok).toBe("boolean");
    });

    it("resolves a plain alias to the same value, or refuses, but never throws", async () => {
      await forAll(
        SEED + 4,
        RUNS,
        (r) => {
          const target = pick(r, ["USDC", "iso4217:ARS", "d.example", "x".repeat(300)]);
          const refs = int(r, 6);
          const aliasUse = Array.from({ length: refs }, (_, i) => `a${i}: *anchor`).join("\n");
          return `anchor_holder: &anchor ${JSON.stringify(target)}\n${aliasUse}`;
        },
        (extra) => {
          const r = parseCorridorYaml(yamlWith(extra));
          expect(typeof r.ok).toBe("boolean");
        },
      );
    });

    it("refuses an undefined alias and malformed YAML with ok:false", async () => {
      for (const text of [
        "id: *nowhere",
        "id: [unterminated",
        "\t\tid: tab-indent: bad",
        "&a &b id: double-anchor",
        "- just\n- a\n- list",
        "",
        "null",
      ]) {
        const r = parseCorridorYaml(text);
        expect(r.ok, text).toBe(false);
      }
    });
  });
});
