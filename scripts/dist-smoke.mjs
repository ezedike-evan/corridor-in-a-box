// Smoke test for the BUILT packages: run `pnpm -r build` first, then
//
//   node scripts/dist-smoke.mjs
//
// A plain Node ESM script, no tsx and no tsconfig paths, so it resolves @corridor/* the way
// a consumer's node would: through each package's `exports`, to dist/. It exercises the
// seam the open-core design is about: a resolver and an adapter built on router,
// adapter-kit, manifest and types, with no source in sight.

import assert from "node:assert/strict";
import { stdout } from "node:process";
import { createMockAdapter } from "@corridor/adapter-kit";
import { InMemoryIdempotencyStore, ALL_STATES } from "@corridor/engine";
import { parseCorridor } from "@corridor/manifest";
import { StaticRouteResolver } from "@corridor/router";
import { ok } from "@corridor/types";

const parsed = parseCorridor({
  id: "dist-smoke",
  source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
  dest: {
    name: "D",
    asset: "iso4217:ARS",
    endpoints: { home_domain: "d.example", transfer_server_sep31: "https://d.example/sep31" },
  },
  fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
  compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
  settlement: { network: "testnet", asset_issuer: "GISSUER" },
  recovery: {},
});
assert.equal(parsed.ok, true, "the manifest parses from the built @corridor/manifest");

const resolver = new StaticRouteResolver(() => createMockAdapter(), {
  trustManifestWithoutAttestation: true,
});
const decision = await resolver.resolve(
  {
    idempotencyKey: "dist-smoke-1",
    corridorId: "dist-smoke",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "1.00" },
  },
  parsed.value,
);
assert.equal(decision.trust, "manifest");
assert.equal(decision.receiving.name, "mock-anchor");

assert.equal(ok(1).ok, true, "@corridor/types");
assert.ok(ALL_STATES.includes("completed"), "@corridor/engine");
assert.ok(new InMemoryIdempotencyStore(), "@corridor/engine store");

stdout.write(
  "dist smoke: ok (router, adapter-kit, manifest, engine, types resolved from dist/)\n",
);
