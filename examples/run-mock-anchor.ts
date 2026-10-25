// Starts the mock anchor (examples/mock-anchor/server.ts) and prints how to point
// the engine at it.
//
//   pnpm mock:anchor [--port 8089] [--scenario happy] [--receive-after-polls 2]
//
// Scenarios: happy, stall, kyc_reject, quote_expired, error_after_settle,
// refund_full, refund_partial, slow_pending_external. Change it while running with
//   curl -X POST localhost:8089/__control/scenario -d '{"scenario":"stall"}'
// or mark a transaction paid with POST /__control/received[/<id>].

import { isScenario, SCENARIOS, startMockAnchor } from "./mock-anchor/server";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const scenario = arg("scenario") ?? "happy";
if (!isScenario(scenario)) {
  console.error(`✗ unknown scenario "${scenario}". One of: ${SCENARIOS.join(", ")}`);
  process.exit(2);
}
const receive = arg("receive-after-polls");

const anchor = await startMockAnchor({
  port: Number(arg("port") ?? 8089),
  scenario,
  ...(receive !== undefined && { receiveAfterPolls: Number(receive) }),
});

console.log(`mock anchor listening on ${anchor.url} (scenario: ${scenario})`);
console.log("  corridor:  corridors/mock.corridor.yaml (expects port 8089)");
console.log(`  try:       pnpm cli plan corridors/mock.corridor.yaml`);
console.log("  not a security boundary: never expose it.");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void anchor.close().then(() => process.exit(0)));
}
