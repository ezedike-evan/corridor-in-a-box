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

/**
 * Pluggable rate limiter. The default `TokenBucket` is per-process — fine for a
 * single replica. For multiple replicas, inject a shared implementation (e.g. a
 * Redis token bucket via a Lua script) so the limit is enforced across the
 * fleet rather than per-instance. `take()` may be sync or async (Redis is
 * async). See docs/operations.md §5.
 */
export interface RateLimiter {
  /** Consume one unit for `key`. Return false to reject (429). */
  take(key: string): boolean | Promise<boolean>;
}

export interface ServiceOptions {
  /** Corridor manifests, keyed by corridor id. */
  corridors: Map<string, Corridor>;
  /** Engine dependencies (resolver, submitter, store, …). */
  deps: EngineDeps;
  /** If set, requests must carry `Authorization: Bearer <key>` with a known key. */
  apiKeys?: Set<string>;
  /** If set, requests are rate-limited per client (API key, else resolved client IP)
   *  using the default in-process TokenBucket. Ignored when `rateLimiter` is given. */
  rateLimit?: RateLimitOptions;
  /** Inject a custom (e.g. shared/Redis) limiter. Takes precedence over `rateLimit`. */
  rateLimiter?: RateLimiter;
  /**
   * If set, `GET /metrics` serves Prometheus text exposition (public + unmetered).
   * Pass `() => prometheusMetrics.render()` and hand the SAME `PrometheusMetrics`
   * to the engine as `deps.metrics` so scrapes see live counters/timings.
   */
  metricsText?: () => string;
  /** Max request body size in bytes. Larger bodies are rejected with 413. Default 64 KiB. */
  maxBodyBytes?: number;
  /**
   * Trust `X-Forwarded-For` for the client IP. Default `false`: the header is
   * client-controlled, so trusting it lets an attacker forge a fresh identity
   * per request and slip the rate limiter. Enable ONLY when a trusted reverse
   * proxy (your ingress) sets the header and strips any inbound value. When
   * false, the transport uses the socket's peer address instead.
   */
  trustProxy?: boolean;
  now?: () => number;
}

/** Default cap on a buffered request body. A payment intent is well under 1 KiB. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface RouteResponse {
  status: number;
  body: unknown;
  /** Defaults to application/json (body is JSON-encoded). Set e.g. text/plain to
   *  send a string body verbatim (used by /metrics). */
  contentType?: string;
}

export interface RouteRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Resolved client IP from the transport (see `trustProxy`). Used for rate-limit keying. */
  clientIp?: string;
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
export class TokenBucket implements RateLimiter {
  private readonly state = new Map<string, { tokens: number; last: number }>();
  /**
   * How long an idle bucket takes to refill back to full capacity. Once a bucket
   * has been idle that long it's indistinguishable from a brand-new one, so it
   * can be dropped — this is what bounds memory. `Infinity` when refill is
   * disabled (a drained bucket never recovers, so we must never evict it).
   */
  private readonly fullRefillMs: number;
  private lastSweep = 0;

  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number,
  ) {
    this.fullRefillMs =
      opts.refillPerSec > 0 ? (opts.capacity / opts.refillPerSec) * 1000 : Infinity;
  }

  take(key: string): boolean {
    const t = this.now();
    // Without eviction the map grows once per distinct client (API key, or a
    // spoofable x-forwarded-for) and never shrinks — an unbounded-memory vector.
    // Sweep at most once per refill window so the cost stays amortized O(1).
    this.evictFullyRefilled(t);
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

  /** Drop buckets idle long enough to have fully refilled (behaviour-neutral:
   *  a full bucket and a fresh one are identical). Throttled to one pass per
   *  refill window to keep the hot path cheap. */
  private evictFullyRefilled(t: number): void {
    if (!Number.isFinite(this.fullRefillMs)) return;
    if (t - this.lastSweep < this.fullRefillMs) return;
    this.lastSweep = t;
    for (const [k, s] of this.state) {
      if (t - s.last >= this.fullRefillMs) this.state.delete(k);
    }
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
  const limiter: RateLimiter | undefined =
    options.rateLimiter ??
    (options.rateLimit ? new TokenBucket(options.rateLimit, now) : undefined);

  // Rate-limit identity: an API key if present (most specific), else the client
  // IP resolved by the transport. We deliberately do NOT key off a raw
  // X-Forwarded-For here — that's resolved into `clientIp` under `trustProxy`
  // control by server(); trusting it blindly would let a client forge a new
  // bucket per request.
  const clientKey = (req: RouteRequest): string => {
    const auth = req.headers?.["authorization"];
    if (auth?.startsWith("Bearer ")) return `key:${auth.slice(7)}`;
    return `ip:${req.clientIp ?? "anon"}`;
  };

  async function route(req: RouteRequest): Promise<RouteResponse> {
    const headers = req.headers ?? {};
    const path = req.path.replace(/\/+$/, "") || "/";

    // Health is public and unmetered.
    if (req.method === "GET" && path === "/healthz") {
      return { status: 200, body: { status: "ok" } };
    }

    // Metrics are public and unmetered (scrapers don't carry an API key). Only
    // exposed when a renderer is configured.
    if (req.method === "GET" && path === "/metrics" && options.metricsText) {
      return {
        status: 200,
        body: options.metricsText(),
        contentType: "text/plain; version=0.0.4",
      };
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
    if (limiter && !(await limiter.take(clientKey(req)))) {
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

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  function server() {
    return httpCreateServer((incoming: IncomingMessage, res: ServerResponse) => {
      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      // Reject oversized bodies up front when the client declares Content-Length,
      // before reading a single byte.
      const declared = Number(incoming.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        sendJson(413, { error: "payload too large" });
        incoming.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      incoming.on("data", (c: Buffer) => {
        if (aborted) return;
        size += c.length;
        // Guard against a lying/absent Content-Length: cap the actual bytes read
        // so a stream can't exhaust memory.
        if (size > maxBodyBytes) {
          aborted = true;
          sendJson(413, { error: "payload too large" });
          incoming.destroy();
          return;
        }
        chunks.push(c);
      });
      incoming.on("end", async () => {
        if (aborted) return;
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
        try {
          const out = await route({
            method: incoming.method ?? "GET",
            path: url.pathname,
            body,
            headers,
            clientIp: resolveClientIp(incoming, headers, options.trustProxy ?? false),
          });
          if (out.contentType) {
            res.writeHead(out.status, { "content-type": out.contentType });
            res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
          } else {
            res.writeHead(out.status, { "content-type": "application/json" });
            res.end(JSON.stringify(out.body));
          }
        } catch {
          // An unexpected throw (e.g. the idempotency DB is unreachable) must not
          // hang the socket or crash the process. A throw here means no payment
          // was committed past its last persisted state, so the run is safe to
          // retry; surface a 500 and let the caller back off. Settlement-time
          // store failures degrade to the same `settling`/IDEMPOTENCY_CONFLICT
          // path as a crash — never a silent double-settle.
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "internal", message: "unexpected error" }));
          }
        }
      });
    });
  }

  return { route, server };
}

/** First hop in an X-Forwarded-For list (the original client). */
function firstForwarded(xff: string | undefined): string | undefined {
  const first = xff?.split(",")[0]?.trim();
  return first || undefined;
}

/**
 * Resolve the client IP for rate-limit keying. With `trustProxy`, prefer the
 * left-most X-Forwarded-For entry set by a trusted ingress; otherwise use the
 * socket peer address, which a client cannot forge.
 */
function resolveClientIp(
  incoming: IncomingMessage,
  headers: Record<string, string>,
  trustProxy: boolean,
): string | undefined {
  if (trustProxy) {
    const fwd = firstForwarded(headers["x-forwarded-for"]);
    if (fwd) return fwd;
  }
  return incoming.socket?.remoteAddress ?? undefined;
}

/**
 * Stop accepting new connections and drain in-flight requests, then force-close
 * any that outlast the grace period. Wire this to SIGTERM/SIGINT in your entry
 * point so a deploy/rollout doesn't sever an in-flight payment mid-settle:
 *
 *   const srv = createService(opts).server();
 *   srv.listen(8080);
 *   for (const sig of ["SIGTERM", "SIGINT"] as const) {
 *     process.on(sig, () => void gracefulShutdown(srv).then(() => process.exit(0)));
 *   }
 */
export function gracefulShutdown(
  srv: ReturnType<typeof httpCreateServer>,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? 10_000;
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // Reject new connections; resolve once existing ones close.
    srv.close(() => done());
    // Free idle keep-alive sockets immediately so close() can complete.
    srv.closeIdleConnections?.();
    // Backstop: forcibly close anything still open after the grace window.
    const timer = setTimeout(() => {
      srv.closeAllConnections?.();
      done();
    }, graceMs);
    timer.unref?.();
  });
}
