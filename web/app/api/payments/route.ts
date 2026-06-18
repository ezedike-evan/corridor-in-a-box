import { NextResponse } from "next/server";
import { runPayment } from "@/lib/engine-sim";

// POST /api/payments — mirrors @corridor/service's POST /payments. In this demo
// it drives the engine simulation; set CORRIDOR_SERVICE_URL to proxy to a real
// @corridor/service instance instead.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const b = body as {
    corridorId?: string;
    sourceAmount?: { amount?: string };
    idempotencyKey?: string;
  };
  if (!b.corridorId || !b.sourceAmount?.amount || !b.idempotencyKey) {
    return NextResponse.json({ error: "invalid payment body" }, { status: 400 });
  }

  const result = runPayment(b.corridorId, b.sourceAmount.amount, b.idempotencyKey);
  return NextResponse.json(result, { status: result.ok ? 200 : 200 });
}
