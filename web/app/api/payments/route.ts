import { NextResponse } from "next/server";
import { runPayment } from "@/lib/engine-sim";

// POST /api/payments — mirrors @corridor/service's POST /payments.
//
// If CORRIDOR_SERVICE_URL is set, this PROXIES to a real @corridor/service
// instance (the production engine). Otherwise it falls back to the in-repo
// simulation (lib/engine-sim.ts) so the showcase runs with zero backend. The
// simulation is demo-only and can drift from the engine — prefer the real
// service for anything load-bearing. Set CORRIDOR_SERVICE_API_KEY if the service
// is behind API-key auth.
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

  const serviceUrl = process.env.CORRIDOR_SERVICE_URL;
  if (serviceUrl) {
    return proxyToService(serviceUrl, body);
  }

  const result = runPayment(b.corridorId, b.sourceAmount.amount, b.idempotencyKey);
  return NextResponse.json(result, { status: 200 });
}

/** Forward the payment to a real @corridor/service POST /payments and relay its response. */
async function proxyToService(serviceUrl: string, body: unknown) {
  const apiKey = process.env.CORRIDOR_SERVICE_API_KEY;
  try {
    const res = await fetch(`${serviceUrl.replace(/\/$/, "")}/payments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "service_unreachable", message: "could not reach CORRIDOR_SERVICE_URL" },
      { status: 502 },
    );
  }
}
