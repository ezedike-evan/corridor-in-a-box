import { describe, expect, it } from "vitest";
import { RedisTokenBucket, TOKEN_BUCKET_LUA, type RedisLike } from "@corridor/service";

/**
 * Executes TOKEN_BUCKET_LUA's logic in JS against an in-memory hash, with a
 * controllable clock standing in for Redis TIME. The real script runs in
 * tests/integration/redis-rate-limiter.test.ts.
 */
class FakeRedis implements RedisLike {
  now = 1_000_000;
  readonly buckets = new Map<string, { tokens: number; last: number }>();
  readonly ttlMs = new Map<string, number>();
  readonly calls: { script: string; keys: string[]; args: (string | number)[] }[] = [];

  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    this.calls.push({ script, keys, args });
    const [capacity, refill] = args.map(Number) as [number, number];
    const key = keys[0]!;
    const s = this.buckets.get(key) ?? { tokens: capacity, last: this.now };
    const tokens = Math.min(capacity, s.tokens + ((this.now - s.last) / 1000) * refill);
    const allowed = tokens >= 1;
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, last: this.now });
    if (refill > 0) this.ttlMs.set(key, Math.ceil((capacity / refill) * 1000));
    return allowed ? 1 : 0;
  }
}

describe("RedisTokenBucket", () => {
  it("allows a burst up to capacity, then rejects", async () => {
    const redis = new FakeRedis();
    const bucket = new RedisTokenBucket(redis, { capacity: 3, refillPerSec: 1 });
    expect([
      await bucket.take("a"),
      await bucket.take("a"),
      await bucket.take("a"),
      await bucket.take("a"),
    ]).toEqual([true, true, true, false]);
  });

  it("refills with time, capped at capacity", async () => {
    const redis = new FakeRedis();
    const bucket = new RedisTokenBucket(redis, { capacity: 2, refillPerSec: 1 });
    await bucket.take("a");
    await bucket.take("a");
    expect(await bucket.take("a")).toBe(false);
    redis.now += 1000;
    expect(await bucket.take("a")).toBe(true);
    expect(await bucket.take("a")).toBe(false);
    redis.now += 60_000;
    expect([await bucket.take("a"), await bucket.take("a"), await bucket.take("a")]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("keeps a bucket per key", async () => {
    const redis = new FakeRedis();
    const bucket = new RedisTokenBucket(redis, { capacity: 1, refillPerSec: 0 });
    expect(await bucket.take("a")).toBe(true);
    expect(await bucket.take("a")).toBe(false);
    expect(await bucket.take("b")).toBe(true);
  });

  it("shares one limit between replicas that share Redis", async () => {
    const redis = new FakeRedis();
    const one = new RedisTokenBucket(redis, { capacity: 2, refillPerSec: 0 });
    const two = new RedisTokenBucket(redis, { capacity: 2, refillPerSec: 0 });
    const results = [
      await one.take("k"),
      await two.take("k"),
      await one.take("k"),
      await two.take("k"),
    ];
    expect(results).toEqual([true, true, false, false]);
  });

  it("sends the script with the prefixed key, capacity and refill rate", async () => {
    const redis = new FakeRedis();
    await new RedisTokenBucket(
      redis,
      { capacity: 5, refillPerSec: 2.5 },
      { keyPrefix: "p:" },
    ).take("client");
    expect(redis.calls).toEqual([
      { script: TOKEN_BUCKET_LUA, keys: ["p:client"], args: [5, 2.5] },
    ]);
    expect(redis.ttlMs.get("p:client")).toBe(2000);
  });

  it("reads the clock from Redis TIME and expires idle buckets", () => {
    expect(TOKEN_BUCKET_LUA).toContain("redis.call('TIME')");
    expect(TOKEN_BUCKET_LUA).toContain("PEXPIRE");
  });

  it("accepts the reply shapes common clients return", async () => {
    for (const [reply, expected] of [
      [1, true],
      ["1", true],
      [true, true],
      [0, false],
      ["0", false],
      [null, false],
    ] as const) {
      const redis: RedisLike = { eval: async () => reply };
      expect(
        await new RedisTokenBucket(redis, { capacity: 1, refillPerSec: 1 }).take("a"),
      ).toBe(expected);
    }
  });

  describe("when Redis errors", () => {
    const failing: RedisLike = {
      eval: async () => {
        throw new Error("ECONNREFUSED");
      },
    };

    it("fails closed by default and logs once, without the key", async () => {
      const logged: [string, unknown][] = [];
      const bucket = new RedisTokenBucket(
        failing,
        { capacity: 1, refillPerSec: 1 },
        { log: (m, e) => logged.push([m, e]) },
      );
      expect(await bucket.take("api-key-secret")).toBe(false);
      expect(logged).toHaveLength(1);
      expect(logged[0]![0]).toContain("failing closed");
      expect(JSON.stringify(logged)).not.toContain("api-key-secret");
    });

    it("fails open when asked to", async () => {
      const logged: string[] = [];
      const bucket = new RedisTokenBucket(
        failing,
        { capacity: 1, refillPerSec: 1 },
        { onError: "open", log: (m) => logged.push(m) },
      );
      expect(await bucket.take("a")).toBe(true);
      expect(logged[0]).toContain("failing open");
    });
  });
});
