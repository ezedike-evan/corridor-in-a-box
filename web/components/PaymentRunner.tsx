"use client";

import { useState } from "react";
import { Play, RotateCcw, CircleCheck, CircleX, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { corridors, getCorridor, VERBS } from "@/lib/corridors";
import type { CorridorState, RunOutcome } from "@/lib/engine-sim";

const ALL_STATES: CorridorState[] = [
  "created",
  "quoted",
  "compliant",
  "opened",
  "settling",
  "settled",
  "reconciled",
  "completed",
];

export function PaymentRunner({ initialCorridor }: { initialCorridor?: string }) {
  const [corridorId, setCorridorId] = useState(
    initialCorridor && getCorridor(initialCorridor) ? initialCorridor : corridors[0].id,
  );
  const [amount, setAmount] = useState("100.00");
  const [idemKey, setIdemKey] = useState("demo-0001");
  const [running, setRunning] = useState(false);
  const [reached, setReached] = useState<CorridorState[]>([]);
  const [result, setResult] = useState<RunOutcome | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    setReached([]);

    const res = await fetch("/api/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        corridorId,
        idempotencyKey: idemKey,
        sender: { id: "sender-1" },
        recipient: { id: "recipient-1" },
        sourceAmount: { asset: "USDC", amount },
      }),
    });
    const outcome = (await res.json()) as RunOutcome;

    // Animate the trail one state at a time.
    for (const state of outcome.trail) {
      setReached((prev) => [...prev, state]);
      await new Promise((r) => setTimeout(r, outcome.idempotentReplay ? 60 : 260));
    }
    setResult(outcome);
    setRunning(false);
  }

  function reset() {
    setResult(null);
    setReached([]);
  }

  const corridor = getCorridor(corridorId)!;

  return (
    <div className="grid gap-6 md:grid-cols-[340px_1fr]">
      {/* Controls */}
      <Card className="flex flex-col gap-4 self-start">
        <div>
          <label className="mb-1 block text-sm font-medium">Corridor</label>
          <select
            value={corridorId}
            onChange={(e) => setCorridorId(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            {corridors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} ({c.fx.path.join(" → ")})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Source amount</label>
          <div className="flex items-center gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            <span className="text-sm text-secondary-text">{corridor.source.asset}</span>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Idempotency key</label>
          <input
            value={idemKey}
            onChange={(e) => setIdemKey(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
          />
          <p className="mt-1 text-xs text-secondary-text">
            Re-run with the same key to see the idempotent replay.
          </p>
        </div>

        <div className="flex gap-2">
          <Button onClick={run} disabled={running} className="flex-1">
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {running ? "Running…" : "Run payment"}
          </Button>
          <Button variant="secondary" onClick={reset} disabled={running}>
            <RotateCcw size={16} />
          </Button>
        </div>
      </Card>

      {/* Trail */}
      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">State machine</h2>
          {result && (
            <Badge variant={result.ok ? "success" : "danger"}>
              {result.ok ? <CircleCheck size={12} /> : <CircleX size={12} />}
              {result.state}
              {result.idempotentReplay ? " · idempotent replay" : ""}
            </Badge>
          )}
        </div>

        <ol className="flex flex-col gap-1.5">
          {ALL_STATES.map((state) => {
            const isReached = reached.includes(state);
            const isFailedHere = result && !result.ok && reached.includes("failed") && state === "opened";
            const verb = VERBS.find((v) =>
              state === "quoted" ? v.verb === "quote"
              : state === "compliant" ? v.verb === "comply"
              : state === "opened" ? v.verb === "open"
              : state === "settled" ? v.verb === "settle"
              : state === "reconciled" ? v.verb === "reconcile"
              : false,
            );
            return (
              <li
                key={state}
                className={
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors " +
                  (isReached ? "bg-bg-subtle" : "opacity-40")
                }
              >
                <span
                  className={
                    "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold " +
                    (isReached ? "bg-blue-600 text-white" : "border border-border text-secondary-text")
                  }
                >
                  {isReached ? "✓" : ""}
                </span>
                <span className="font-mono font-medium">{state}</span>
                {verb && <span className="text-xs text-secondary-text">{verb.sep}</span>}
              </li>
            );
          })}
        </ol>

        {result && !result.ok && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
            <span className="font-mono font-semibold">{result.error?.code}</span> —{" "}
            {result.error?.message}
          </div>
        )}
        {result?.ok && result.stellarTxHash && (
          <div className="rounded-lg bg-bg-subtle px-3 py-2 text-xs">
            <span className="text-secondary-text">stellar tx: </span>
            <span className="font-mono break-all">{result.stellarTxHash}</span>
          </div>
        )}
      </Card>
    </div>
  );
}
