// A Redis-backed token bucket that enforces one rate limit across every replica
// of the service. The in-process `TokenBucket` in ./index counts per process, so
// N replicas multiply the limit by N; this keeps the bucket in Redis instead.
//
// Like `Queryable` in @corridor/engine's idempotency-pg, we depend on a tiny
// structural `RedisLike` rather than a client package, so neither ioredis nor
// node-redis is forced on consumers. Adapt yours in one line:
//
//   // ioredis
//   const redis: RedisLike = {
//     eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
//   };
//   // node-redis v4+
//   const redis: RedisLike = {
//     eval: (script, keys, args) =>
//       client.eval(script, { keys, arguments: args.map(String) }),
//   };

import type { RateLimiter, RateLimitOptions } from "./index";

/** The one Redis command the limiter needs. */
export interface RedisLike {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

/**
 * Atomic refill-and-take. Runs entirely inside Redis, so concurrent replicas
 * cannot interleave a read and a write, and it reads the clock from Redis
 * `TIME` so replicas with skewed clocks still agree. The key expires once an
 * idle bucket would have fully refilled — at that point it is indistinguishable
 * from a new one — which mirrors the eviction in the in-process `TokenBucket`
 * and bounds memory. With no refill a drained bucket never recovers, so it
 * never expires.
 *
 * KEYS[1] bucket key; ARGV[1] capacity; ARGV[2] refill tokens per second.
 * Returns 1 when a token was taken, 0 when the bucket is empty.
 */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local s = redis.call('HMGET', KEYS[1], 'tokens', 'last')
local tokens = tonumber(s[1])
local last = tonumber(s[2])
if tokens == nil or last == nil then
  tokens = capacity
  last = now
end
tokens = math.min(capacity, tokens + ((now - last) / 1000) * refill)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'last', tostring(now))
if refill > 0 then
  redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill * 1000))
end
return allowed
`;

export interface RedisTokenBucketOptions {
  /**
   * What `take()` answers when Redis errors. `closed` (default) rejects the
   * request, so an outage costs availability but never lets traffic past the
   * limit; `open` admits it, trading the limit for availability.
   */
  onError?: "closed" | "open";
  /** Prefix for bucket keys. Default `corridor:rl:`. */
  keyPrefix?: string;
  /**
   * Called when Redis errors, with the failure. Default writes one line to
   * stderr. The key is never passed in, since it may be derived from an API key.
   */
  log?: (message: string, error: unknown) => void;
}

const defaultLog = (message: string, error: unknown): void => {
  console.error(message, error instanceof Error ? error.message : String(error));
};

export class RedisTokenBucket implements RateLimiter {
  private readonly onError: "closed" | "open";
  private readonly keyPrefix: string;
  private readonly log: (message: string, error: unknown) => void;

  constructor(
    private readonly redis: RedisLike,
    private readonly opts: RateLimitOptions,
    options: RedisTokenBucketOptions = {},
  ) {
    this.onError = options.onError ?? "closed";
    this.keyPrefix = options.keyPrefix ?? "corridor:rl:";
    this.log = options.log ?? defaultLog;
  }

  async take(key: string): Promise<boolean> {
    try {
      const reply = await this.redis.eval(
        TOKEN_BUCKET_LUA,
        [this.keyPrefix + key],
        [this.opts.capacity, this.opts.refillPerSec],
      );
      return reply === 1 || reply === "1" || reply === true;
    } catch (error) {
      this.log(
        `corridor.ratelimit.redis_error (failing ${this.onError}, returning ${
          this.onError === "open" ? "allow" : "429"
        })`,
        error,
      );
      return this.onError === "open";
    }
  }
}
