#!/usr/bin/env node
// corridor — a tiny CLI to validate manifests, dry-run the plan offline,
// and drive live gated canary payments through the real stack.
//
//   corridor validate <file.corridor.yaml>
//   corridor plan     <file.corridor.yaml>
//   corridor canary   <file.corridor.yaml> --amount <amount> [--network <public|testnet>]
//
// `plan` is the cheap pre-flight: it tells you whether a corridor is actually
// runnable (does the dest anchor expose SEP-31? a SEP-38 quote server?) before
// you ever touch the network.
//
// `canary` drives one tiny real payment through the full, gated stack:
// Sep31Adapter + StellarSettlementSubmitter + the default gate + RegistryRouteResolver.

import { liveness, loadCorridor, type Corridor } from "@corridor/manifest";
import { isSettleableAmount } from "@corridor/types";
import { executeCanary } from "./wire.js";

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  if (!cmd || (cmd !== "validate" && cmd !== "plan" && cmd !== "canary")) {
    console.error("usage: corridor <validate|plan|canary> <file.corridor.yaml> [options]");
    return 2;
  }

  if (cmd === "canary") {
    let file: string | undefined;
    let amount: string | undefined;
    let network: string | undefined;
    let skipDoctor = false;

    const rest = argv.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--amount") {
        if (i + 1 >= rest.length || rest[i + 1].startsWith("--")) {
          console.error("error: --amount requires a value");
          return 2;
        }
        amount = rest[++i];
      } else if (arg.startsWith("--amount=")) {
        amount = arg.slice("--amount=".length);
      } else if (arg === "--network") {
        if (i + 1 >= rest.length || rest[i + 1].startsWith("--")) {
          console.error("error: --network requires a value");
          return 2;
        }
        network = rest[++i];
      } else if (arg.startsWith("--network=")) {
        network = arg.slice("--network=".length);
      } else if (arg === "--skip-doctor") {
        skipDoctor = true;
      } else if (arg.startsWith("--")) {
        console.error(`error: unknown option "${arg}"`);
        return 2;
      } else {
        if (!file) {
          file = arg;
        } else {
          console.error(`error: unexpected argument "${arg}"`);
          return 2;
        }
      }
    }

    if (!file) {
      console.error(
        "usage: corridor canary <file.corridor.yaml> --amount <amount> [--network <public|testnet>]",
      );
      return 2;
    }

    if (amount === undefined || amount === "") {
      console.error("error: --amount <amount> is required for canary");
      return 2;
    }

    if (!isSettleableAmount(amount)) {
      console.error(`error: --amount must be a positive decimal amount (got "${amount}")`);
      return 2;
    }

    if (network !== undefined && network !== "public" && network !== "testnet") {
      console.error(`error: --network must be "public" or "testnet" (got "${network}")`);
      return 2;
    }

    const loaded = loadCorridor(file);
    if (!loaded.ok) {
      console.error(`✗ ${loaded.error.code}: ${loaded.error.message}`);
      return 1;
    }

    const runResult = await executeCanary(loaded.value, {
      amount,
      network,
      skipDoctor,
    });
    return runResult.exitCode;
  }

  const file = argv[1];
  if (!file) {
    console.error(`usage: corridor ${cmd} <file.corridor.yaml>`);
    return 2;
  }

  const loaded = loadCorridor(file);
  if (!loaded.ok) {
    console.error(`✗ ${loaded.error.code}: ${loaded.error.message}`);
    return 1;
  }
  const c = loaded.value;

  if (cmd === "validate") {
    console.log(`✓ ${file} is a valid corridor manifest (id="${c.id}")`);
    return 0;
  }

  printPlan(c);
  return 0;
}

function printPlan(c: Corridor): void {
  const line = (s = "") => console.log(s);
  line(`corridor: ${c.id}`);
  if (c.status_note) line(`note:     ${c.status_note}`);
  line(
    `route:    ${c.fx.path.join(" -> ")}   (risk: ${c.fx.who_holds_risk}, ttl ${c.fx.quote_ttl_seconds}s)`,
  );
  line(
    `source:   ${c.source.name}  [${c.source.asset}]  ${c.source.protocol}${c.source.endpoints?.home_domain ? `  ${c.source.endpoints.home_domain}` : ""}`,
  );
  line(`dest:     ${c.dest.name}  [${c.dest.asset}]  ${c.dest.endpoints.home_domain}`);
  line(`bridge:   ${c.settlement.bridge_asset} on ${c.settlement.network}`);
  line(
    `recovery: retries=${c.recovery.max_retries}, timeout=${c.recovery.timeout_seconds}s, rollback=${c.recovery.rollback}`,
  );
  line();
  line("steps:");
  line("  1. quote      SEP-38  POST /quote");
  line("  2. comply     SEP-10 auth + SEP-12 KYC handoff");
  line("  3. open       SEP-31  POST /transactions");
  line("  4. settle     native Stellar payment of bridge asset");
  line("  5. reconcile  SEP-31  GET /transactions/:id");
  line();

  // Liveness comes from @corridor/manifest so this command and the web dashboard
  // can never describe the same corridor differently.
  const live = liveness(c);

  if (live.state === "proven" && live.proof) {
    const hashPrefix = live.proof.stellar_tx_hash.slice(0, 8);
    const date = live.proof.canary_completed_at.slice(0, 10);
    const now = new Date();
    const completedAt = new Date(live.proof.canary_completed_at).getTime();
    const ageMs = now.getTime() - completedAt;
    const daysAgo = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
    const maxAge = live.proof.max_age_days ?? 30;
    const expiresIn = Math.max(0, maxAge - daysAgo);
    line(
      `liveness: ✓✓ PROVEN — canary ${hashPrefix} completed ${date} (${daysAgo} days ago, expires in ${expiresIn}d)`,
    );
  } else if (live.state === "verified") {
    line(`liveness: ✓ VERIFIED — endpoints confirmed ${live.verifiedAt} for all five steps`);
    const cap = c.proof?.canary_max_amount ?? c.limits?.max_amount ?? "default";
    if (c.proof) {
      // A proof is on file but liveness() did not honour it (stale, future-dated):
      // saying "none" would be wrong, and the reason is in the warnings below.
      const hashPrefix = c.proof.stellar_tx_hash.slice(0, 8);
      const date = c.proof.canary_completed_at.slice(0, 10);
      line(
        `proof:    not current — canary ${hashPrefix} completed ${date}; amounts capped at ${cap}`,
      );
    } else {
      line(`proof:    none — amounts capped at ${cap}`);
    }
  } else if (live.state === "unverified") {
    line("liveness: ? UNVERIFIED — endpoints present but unconfirmed. NOT runnable.");
  } else {
    line("liveness: ✗ NOT RUNNABLE — a required endpoint is missing.");
  }

  if (live.warnings.length > 0) {
    line();
    line("liveness warnings:");
    for (const w of live.warnings) line(`  ! ${w}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
