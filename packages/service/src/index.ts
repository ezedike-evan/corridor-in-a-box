// @corridor/service — a thin HTTP layer over the engine. The engine is a
// library; this turns it into a service with the things a real endpoint needs:
// JSON in/out, sensible HTTP status mapping, optional API-key auth, and a simple
// in-memory rate limiter. Zero runtime dependencies — Node's built-in http.
//
// The core is a pure `route()` you can unit-test without binding a socket;
// `server()` is a thin node:http adapter around it.

import {
  createServer as httpCreateServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Corridor } from "@corridor/manifest";
import { execute, type EngineDeps } from "@corridor/engine";
import { isValidAmount, type CorridorErrorCode, type PaymentIntent } from "@corridor/types";

export interface RateLimitOptions {
  /** Bucket size (max burst). */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
}

export interface ServiceOptions {
  /** Corridor manifests, keyed by corridor id. */
  corridors: Map<string, Corridor>;
  /** Engine dependencies (resolver, submitter, store, …). */
  deps: EngineDeps;
  /** If set, requests must carry `Authorization: Bearer <key>` with a known key. */
  apiKeys?: Set<string>;
  /** If set, requests are rate-limited per client (API key, else x-forwarded-for). */
  rateLimit?: RateLimitOptions;
  now?: () => number;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

export interface RouteRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const STATUS_BY_CODE: Record<CorridorErrorCode, number> = {
  MANIFEST_INVALID: 422,
  AMOUNT_INVALID: 422,
  QUOTE_UNAVAILABLE: 502,
  QUOTE_EXPIRED: 409,
  KYC_REQUIRED: 409,
  KYC_REJECTED: 403,
  ANCHOR_UNAVAILABLE: 502,
  SETTLEMENT_FAILED: 500,
  SETTLEMENT_TIMEOUT: 504,
  RECONCILE_MISMATCH: 500,
  IDEMPOTENCY_CONFLICT: 409,
};

/** Token-bucket rate limiter, keyed per client. In-memory; swap for Redis at scale. */
class TokenBucket {
  private readonly state = new Map<string, { tokens: number; last: number }>();
  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const s = this.state.get(key) ?? { tokens: this.opts.capacity, last: t };
    s.tokens = Math.min(
      this.opts.capacity,
      s.tokens + ((t - s.last) / 1000) * this.opts.refillPerSec,
    );
    s.last = t;
    const allowed = s.tokens >= 1;
    if (allowed) s.tokens -= 1;
    this.state.set(key, s);
    return allowed;
  }
}

function isPaymentBody(b: unknown): b is PaymentIntent {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  const amount = o.sourceAmount as Record<string, unknown> | undefined;
  return (
    typeof o.idempotencyKey === "string" &&
    typeof o.corridorId === "string" &&
    typeof (o.sender as Record<string, unknown>)?.id === "string" &&
    typeof (o.recipient as Record<string, unknown>)?.id === "string" &&
    typeof amount?.asset === "string" &&
    typeof amount?.amount === "string"
  );
}

export interface Service {
  route(req: RouteRequest): Promise<RouteResponse>;
  /** A node:http server that delegates to route(). Call .listen(port). */
  server(): ReturnType<typeof httpCreateServer>;
}

export function createService(options: ServiceOptions): Service {
  const now = options.now ?? (() => Date.now());
  const limiter = options.rateLimit ? new TokenBucket(options.rateLimit, now) : undefined;

  const clientKey = (headers: Record<string, string>): string => {
    const auth = headers["authorization"];
    if (auth?.startsWith("Bearer ")) return `key:${auth.slice(7)}`;
    return `ip:${headers["x-forwarded-for"] ?? "anon"}`;
  };

  async function route(req: RouteRequest): Promise<RouteResponse> {
    const headers = req.headers ?? {};
    const path = req.path.replace(/\/+$/, "") || "/";

    // Health is public and unmetered.
    if (req.method === "GET" && path === "/healthz") {
      return { status: 200, body: { status: "ok" } };
    }

    // --- auth ---
    if (options.apiKeys) {
      const auth = headers["authorization"];
      const key = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!key || !options.apiKeys.has(key)) {
        return { status: 401, body: { error: "unauthorized" } };
      }
    }

    // --- rate limit ---
    if (limiter && !limiter.take(clientKey(headers))) {
      return { status: 429, body: { error: "rate_limited" } };
    }

    // --- POST /payments ---
    if (req.method === "POST" && path === "/payments") {
      if (!isPaymentBody(req.body)) {
        return { status: 400, body: { error: "invalid payment body" } };
      }
      const intent = req.body;
      if (!isValidAmount(intent.sourceAmount.amount)) {
        return { status: 422, body: { error: "AMOUNT_INVALID", message: "invalid amount" } };
      }
      const corridor = options.corridors.get(intent.corridorId);
      if (!corridor) {
        return {
          status: 404,
          body: { error: "unknown corridor", corridorId: intent.corridorId },
        };
      }
      const result = await execute(intent, corridor, options.deps);
      if (result.ok) {
        return { status: 200, body: result.value };
      }
      return {
        status: STATUS_BY_CODE[result.error.code] ?? 500,
        body: { error: result.error.code, message: result.error.message },
      };
    }

    // --- GET /payments/:key ---
    const m = path.match(/^\/payments\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const store = options.deps.idempotency;
      const run = store ? await store.get(decodeURIComponent(m[1])) : undefined;
      if (!run) return { status: 404, body: { error: "not found" } };
      return {
        status: 200,
        body: {
          idempotencyKey: run.idempotencyKey,
          corridorId: run.corridorId,
          state: run.state,
          transactionId: run.transactionId,
          stellarTxHash: run.stellarTxHash,
          lastError: run.lastError,
        },
      };
    }

    return { status: 404, body: { error: "not found" } };
  }

  function server() {
    return httpCreateServer((incoming: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (c: Buffer) => chunks.push(c));
      incoming.on("end", async () => {
        let body: unknown;
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid JSON" }));
            return;
          }
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(incoming.headers)) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
        }
        const url = new URL(incoming.url ?? "/", "http://localhost");
        const out = await route({
          method: incoming.method ?? "GET",
          path: url.pathname,
          body,
          headers,
        });
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
  }

  return { route, server };
}
