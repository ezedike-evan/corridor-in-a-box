import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  type EngineDeps,
} from "@corridor/engine";
import { createService, type ServiceOptions } from "@corridor/service";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function intentBody(key = "p1"): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

function deps(adapterOpts = {}): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts)),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    sleep: async () => {},
  };
}

function svc(over: Partial<ServiceOptions> = {}) {
  return createService({
    corridors: new Map([["test", corridor()]]),
    deps: deps(),
    ...over,
  });
}

describe("service: POST /payments", () => {
  it("runs a payment and returns 200 completed", async () => {
    const s = svc();
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("completed");
  });

  it("returns 200 on idempotent replay of a completed key", async () => {
    const s = svc();
    await s.route({ method: "POST", path: "/payments", body: intentBody("dup") });
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody("dup") });
    expect(r.status).toBe(200);
  });

  it("maps a malformed amount to 422", async () => {
    const s = svc();
    const body = { ...intentBody(), sourceAmount: { asset: "USDC", amount: "1,000" } };
    const r = await s.route({ method: "POST", path: "/payments", body });
    expect(r.status).toBe(422);
  });

  it("maps a KYC rejection to 403", async () => {
    const s = createService({
      corridors: new Map([["test", corridor()]]),
      deps: deps({ kyc: "rejected" }),
    });
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(r.status).toBe(403);
  });

  it("returns 404 for an unknown corridor", async () => {
    const s = svc();
    const r = await s.route({
      method: "POST",
      path: "/payments",
      body: { ...intentBody(), corridorId: "nope" },
    });
    expect(r.status).toBe(404);
  });

  it("returns 400 for a malformed body", async () => {
    const s = svc();
    const r = await s.route({ method: "POST", path: "/payments", body: { foo: "bar" } });
    expect(r.status).toBe(400);
  });
});

describe("service: GET /payments/:key", () => {
  it("returns the run state after a payment", async () => {
    const s = svc();
    await s.route({ method: "POST", path: "/payments", body: intentBody("look") });
    const r = await s.route({ method: "GET", path: "/payments/look" });
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("completed");
  });

  it("404s an unknown key", async () => {
    const r = await svc().route({ method: "GET", path: "/payments/missing" });
    expect(r.status).toBe(404);
  });
});

describe("service: auth + rate limiting + health", () => {
  it("healthz is public", async () => {
    const r = await svc({ apiKeys: new Set(["secret"]) }).route({
      method: "GET",
      path: "/healthz",
    });
    expect(r.status).toBe(200);
  });

  it("rejects requests without a valid API key", async () => {
    const s = svc({ apiKeys: new Set(["secret"]) });
    const noKey = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(noKey.status).toBe(401);
    const good = await s.route({
      method: "POST",
      path: "/payments",
      body: intentBody(),
      headers: { authorization: "Bearer secret" },
    });
    expect(good.status).toBe(200);
  });

  it("rate-limits after the bucket is drained", async () => {
    let t = 0;
    const s = svc({ rateLimit: { capacity: 2, refillPerSec: 0 }, now: () => t });
    const hit = () =>
      s.route({
        method: "GET",
        path: "/payments/x",
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
    expect((await hit()).status).toBe(404); // allowed (token 1)
    expect((await hit()).status).toBe(404); // allowed (token 2)
    expect((await hit()).status).toBe(429); // drained
    t += 100; // no refill configured
    expect((await hit()).status).toBe(429);
  });
});
