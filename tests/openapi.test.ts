// Tests packages/service/openapi.yaml against the real `route()`: the spec cannot drift
// from the service without this failing. Responses are produced by the service and
// validated, as JSON, against the response schema the spec declares for that status.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { createMockAdapter } from "@corridor/adapter-kit";
import { parseCorridor, parseYaml, type Corridor } from "@corridor/manifest";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  type EngineDeps,
} from "@corridor/engine";
import {
  STATUS_BY_CODE,
  createService,
  type RouteResponse,
  type ServiceOptions,
} from "@corridor/service";
import type { PaymentIntent } from "@corridor/types";

// The spec is parsed YAML of a shape this file walks dynamically.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const SPEC = parseYaml(
  readFileSync(new URL("../packages/service/openapi.yaml", import.meta.url), "utf8"),
) as Json;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
// Register the whole document so `$ref: "#/components/..."` resolves against it.
ajv.addSchema({
  $id: "spec",
  $defs: JSON.parse(JSON.stringify(SPEC.components).replace(/"#\/components\//g, '"#/$defs/')),
});

const compiled = new Map<string, ValidateFunction>();
function validator(schema: Json): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = compiled.get(key);
  if (!v) {
    // Rewrite the document-relative refs to the registered schema's.
    v = ajv.compile(JSON.parse(key.replace(/"#\/components\//g, '"spec#/$defs/')));
    compiled.set(key, v);
  }
  return v;
}

/** Resolve a `$ref: "#/components/..."` object, or return the object. */
function deref(node: Json): Json {
  if (typeof node?.$ref !== "string") return node;
  return node.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((n: Json, k: string) => n[k], SPEC);
}

/** The schema the spec declares for `method path` at `status`, for `contentType`. */
function responseSchema(
  path: string,
  method: string,
  status: number,
  contentType: string,
): Json {
  const op = SPEC.paths[path]?.[method];
  expect(op, `${method.toUpperCase()} ${path} is documented`).toBeDefined();
  const declared = op.responses[String(status)];
  expect(declared, `${method.toUpperCase()} ${path} documents ${status}`).toBeDefined();
  const response = deref(declared);
  const media = response.content?.[contentType];
  expect(media, `${status} of ${path} documents ${contentType}`).toBeDefined();
  return media.schema;
}

function check(
  res: RouteResponse,
  path: string,
  method: string,
  contentType = "application/json",
): void {
  const schema = responseSchema(path, method, res.status, contentType);
  const body =
    contentType === "application/json"
      ? JSON.parse(JSON.stringify(res.body ?? null))
      : res.body;
  const validate = validator(schema);
  const ok = validate(body);
  expect(
    ok,
    `${method.toUpperCase()} ${path} -> ${res.status}: ${ajv.errorsText(validate.errors)} in ${JSON.stringify(body)}`,
  ).toBe(true);
  // A header the spec lists for the response must really be sent.
  const op = SPEC.paths[path][method];
  const declaredHeaders = Object.keys(deref(op.responses[String(res.status)]).headers ?? {});
  for (const h of declaredHeaders) expect(res.headers?.[h], `header ${h}`).toBeTruthy();
}

// --- the service under test ---------------------------------------------------

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
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent = (key: string): PaymentIntent => ({
  idempotencyKey: key,
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
});

function svc(
  adapter: Parameters<typeof createMockAdapter>[0] = {},
  over: Partial<ServiceOptions> = {},
) {
  const deps: EngineDeps = {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapter), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
  };
  return createService({ corridors: new Map([["test", corridor()]]), deps, ...over });
}

const post = (s: ReturnType<typeof svc>, body: unknown, headers?: Record<string, string>) =>
  s.route({ method: "POST", path: "/payments", body, headers });

describe("openapi.yaml: the document", () => {
  it("is OpenAPI 3.1 with unique operation ids and a response on every operation", () => {
    expect(SPEC.openapi).toBe("3.1.0");
    const ids: string[] = [];
    for (const [path, item] of Object.entries<Json>(SPEC.paths)) {
      for (const [method, op] of Object.entries<Json>(item)) {
        expect(op.operationId, `${method} ${path}`).toBeTruthy();
        ids.push(op.operationId);
        expect(Object.keys(op.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every $ref", () => {
    const refs: string[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        for (const [k, v] of Object.entries(n)) {
          if (k === "$ref" && typeof v === "string") refs.push(v);
          else walk(v);
        }
      }
    };
    walk(SPEC);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(deref({ $ref: ref }), ref).toBeDefined();
    }
  });

  it("documents every route the service serves", () => {
    expect(Object.keys(SPEC.paths).sort()).toEqual(
      [
        "/callbacks/sep31/{corridorId}",
        "/healthz",
        "/metrics",
        "/payments",
        "/payments/{key}",
        "/readyz",
      ].sort(),
    );
  });

  it("lists exactly the engine error codes, and every status they map to", () => {
    expect([...SPEC.components.schemas.ErrorCode.enum].sort()).toEqual(
      Object.keys(STATUS_BY_CODE).sort(),
    );
    const documented = Object.keys(SPEC.paths["/payments"].post.responses);
    for (const status of new Set(Object.values(STATUS_BY_CODE))) {
      expect(documented, `POST /payments documents ${status}`).toContain(String(status));
    }
    for (const status of ["400", "401", "404", "413", "429"]) {
      expect(documented).toContain(status);
    }
  });

  it("rejects a shape the spec does not allow (the check has teeth)", () => {
    const schema = SPEC.components.schemas.RunStatus;
    const validate = validator(schema);
    expect(validate({ idempotencyKey: "k", corridorId: "c", state: "completed" })).toBe(true);
    expect(validate({ idempotencyKey: "k", corridorId: "c", state: "bogus" })).toBe(false);
    expect(
      validate({ idempotencyKey: "k", corridorId: "c", state: "held", leaked: "x" }),
    ).toBe(false);
  });
});

describe("openapi.yaml: route() responses match the spec", () => {
  it("GET /healthz", async () => {
    check(await svc().route({ method: "GET", path: "/healthz" }), "/healthz", "get");
  });

  it("GET /readyz: 200 when every check passes, 503 when one fails or the service drains", async () => {
    const ok = svc({}, { readinessChecks: [{ name: "store", check: async () => {} }] });
    check(await ok.route({ method: "GET", path: "/readyz" }), "/readyz", "get");
    const bad = svc(
      {},
      {
        readinessChecks: [
          { name: "store", check: async () => Promise.reject(new Error("x")) },
        ],
      },
    );
    const degraded = await bad.route({ method: "GET", path: "/readyz" });
    expect(degraded.status).toBe(503);
    check(degraded, "/readyz", "get");
    const draining = svc();
    await draining.drain();
    const res = await draining.route({ method: "GET", path: "/readyz" });
    expect(res.status).toBe(503);
    check(res, "/readyz", "get");
  });

  it("GET /metrics", async () => {
    const s = svc({}, { metricsText: () => "# HELP x y\nx 1\n" });
    check(await s.route({ method: "GET", path: "/metrics" }), "/metrics", "get", "text/plain");
  });

  it("POST /payments: 200 with a RunResult", async () => {
    const res = await post(svc(), intent("openapi-ok"));
    expect(res.status).toBe(200);
    check(res, "/payments", "post");
  });

  it("POST /payments: 400 for an invalid body, naming the field", async () => {
    const res = await post(svc(), { ...intent("openapi-400"), sender: { id: "" } });
    expect(res.status).toBe(400);
    check(res, "/payments", "post");
  });

  it("POST /payments: 404 for an unknown corridor", async () => {
    const res = await post(svc(), { ...intent("openapi-404"), corridorId: "nope" });
    expect(res.status).toBe(404);
    check(res, "/payments", "post");
  });

  it("POST /payments: 422 for an amount or asset the corridor refuses", async () => {
    const amount = await post(svc(), {
      ...intent("openapi-422a"),
      sourceAmount: { asset: "USDC", amount: "-5" },
    });
    expect(amount.status).toBe(422);
    check(amount, "/payments", "post");
    const asset = await post(svc(), {
      ...intent("openapi-422b"),
      sourceAmount: { asset: "EURC", amount: "5" },
    });
    expect(asset.status).toBe(422);
    check(asset, "/payments", "post");
  });

  it("POST /payments: 401 without a known key, 429 when the bucket is empty", async () => {
    const keyed = svc({}, { apiKeys: new Set(["k-secret"]) });
    const denied = await post(keyed, intent("openapi-401"));
    expect(denied.status).toBe(401);
    check(denied, "/payments", "post");

    const limited = svc({}, { rateLimiter: { take: () => false } });
    const res = await post(limited, intent("openapi-429"));
    expect(res.status).toBe(429);
    check(res, "/payments", "post");
  });

  it("POST /payments: 503 while draining", async () => {
    const s = svc();
    await s.drain();
    const res = await post(s, intent("openapi-503"));
    expect(res.status).toBe(503);
    check(res, "/payments", "post");
  });

  it("POST /payments: an engine refusal carries an error code and message", async () => {
    const res = await post(svc({ kyc: "rejected" }), intent("openapi-engine"));
    expect(res.status).toBe(STATUS_BY_CODE.KYC_REJECTED);
    check(res, "/payments", "post");
  });

  it("GET /payments/{key}: 200 for the owner and 404 for an unknown key", async () => {
    const s = svc();
    await post(s, intent("openapi-get"));
    const found = await s.route({ method: "GET", path: "/payments/openapi-get" });
    expect(found.status).toBe(200);
    check(found, "/payments/{key}", "get");
    const missing = await s.route({ method: "GET", path: "/payments/nope" });
    expect(missing.status).toBe(404);
    check(missing, "/payments/{key}", "get");
  });

  it("GET /payments/{key}: a failed run exposes only its error code", async () => {
    const s = svc({ kyc: "rejected" });
    await post(s, intent("openapi-failed"));
    const res = await s.route({ method: "GET", path: "/payments/openapi-failed" });
    expect(res.status).toBe(200);
    check(res, "/payments/{key}", "get");
    expect((res.body as { error?: string }).error).toMatch(/^[A-Z_]+$/);
  });

  it("POST /callbacks/sep31/{corridorId}: 404 for an unknown corridor, 401 without a signature", async () => {
    const s = svc();
    const unknown = await s.route({ method: "POST", path: "/callbacks/sep31/nope", body: {} });
    expect(unknown.status).toBe(404);
    check(unknown, "/callbacks/sep31/{corridorId}", "post");
    const unsigned = await s.route({
      method: "POST",
      path: "/callbacks/sep31/test",
      body: {},
    });
    expect(unsigned.status).toBe(401);
    check(unsigned, "/callbacks/sep31/{corridorId}", "post");
  });
});
