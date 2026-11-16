// Integration test for RedisTokenBucket against a REAL Redis, running the real
// Lua script.
//
// Opt-in, like idempotency-pg.test.ts: skipped unless CORRIDOR_TEST_REDIS_URL is
// set. CI provides a redis:7 service container (.github/workflows/ci.yml).
// Locally:
//
//   docker run --rm -p 6379:6379 redis:7
//   CORRIDOR_TEST_REDIS_URL=redis://localhost:6379 \
//     pnpm exec vitest run tests/integration/redis-rate-limiter.test.ts

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisTokenBucket } from "@corridor/service";
import { RespClient } from "../helpers/redis-resp";

const url = process.env.CORRIDOR_TEST_REDIS_URL;
const run = url ? describe : describe.skip;

run("RedisTokenBucket (live Redis)", () => {
  let redis: RespClient;
  // A fresh prefix per run, so a shared Redis and reruns never see old buckets.
  const keyPrefix = `corridor:test:${randomUUID()}:`;

  beforeAll(async () => {
    redis = await RespClient.connect(url!);
  });

  afterAll(async () => {
    const keys = (await redis.command("KEYS", `${keyPrefix}*`)) as string[];
    if (keys.length > 0) await redis.command("DEL", ...keys);
    redis.close();
  });

  it("allows a burst up to capacity, then rejects", async () => {
    const bucket = new RedisTokenBucket(
      redis,
      { capacity: 3, refillPerSec: 0 },
      { keyPrefix },
    );
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await bucket.take("burst"));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("keeps a bucket per key", async () => {
    const bucket = new RedisTokenBucket(
      redis,
      { capacity: 1, refillPerSec: 0 },
      { keyPrefix },
    );
    expect(await bucket.take("one")).toBe(true);
    expect(await bucket.take("one")).toBe(false);
    expect(await bucket.take("two")).toBe(true);
  });

  it("enforces one limit across replicas sharing Redis, under concurrency", async () => {
    const opts = { capacity: 10, refillPerSec: 0 };
    const replicas = [1, 2, 3].map(() => new RedisTokenBucket(redis, opts, { keyPrefix }));
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => replicas[i % 3]!.take("fleet")),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
  });

  it("refills over time using the Redis clock", async () => {
    const bucket = new RedisTokenBucket(
      redis,
      { capacity: 1, refillPerSec: 10 },
      { keyPrefix },
    );
    expect(await bucket.take("refill")).toBe(true);
    expect(await bucket.take("refill")).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect(await bucket.take("refill")).toBe(true);
  });

  it("expires an idle bucket once it would have fully refilled", async () => {
    const bucket = new RedisTokenBucket(
      redis,
      { capacity: 1, refillPerSec: 10 },
      { keyPrefix },
    );
    await bucket.take("ttl");
    const ttl = (await redis.command("PTTL", `${keyPrefix}ttl`)) as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it("never expires a bucket that cannot refill", async () => {
    const bucket = new RedisTokenBucket(
      redis,
      { capacity: 1, refillPerSec: 0 },
      { keyPrefix },
    );
    await bucket.take("no-refill");
    expect(await redis.command("PTTL", `${keyPrefix}no-refill`)).toBe(-1);
  });
});
