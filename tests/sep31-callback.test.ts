import { afterEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryWaker,
  createMockSubmitter,
  reconcileUntil,
  type EngineDeps,
} from "@corridor/engine";
import { CallbackVerifier, createService } from "@corridor/service";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32(buf: Buffer): string {
  let bits = 0;
  let val = 0;
  let out = "";
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  // Version byte + 32-byte key + 2 checksum bytes (not checked by the verifier).
  const signingKey = b32(Buffer.concat([Buffer.from([0x30]), raw, Buffer.from([0, 0])]));
  return { privateKey, signingKey };
}

function stubToml(signingKey: string | null, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      text: async () => (signingKey ? `SIGNING_KEY="${signingKey}"\n` : "# nothing\n"),
    })),
  );
}

function sign(privateKey: crypto.KeyObject, payload: string): string {
  return crypto.sign(null, Buffer.from(payload), privateKey).toString("base64");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CallbackVerifier (SEP-31 callback signatures)", () => {
  it("accepts a valid signature", async () => {
    const k = newKey();
    stubToml(k.signingKey);
    const payload = '1700000000.{"a":1}';
    const ok = await new CallbackVerifier().verify(
      "d.example",
      Buffer.from(payload),
      sign(k.privateKey, payload),
    );
    expect(ok).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const k = newKey();
    stubToml(k.signingKey);
    const sig = sign(k.privateKey, '1700000000.{"a":1}');
    const ok = await new CallbackVerifier().verify(
      "d.example",
      Buffer.from('1700000000.{"a":2}'),
      sig,
    );
    expect(ok).toBe(false);
  });

  it("rejects a signature made by a different key", async () => {
    const k = newKey();
    const other = newKey();
    stubToml(k.signingKey);
    const payload = "1700000000.{}";
    const ok = await new CallbackVerifier().verify(
      "d.example",
      Buffer.from(payload),
      sign(other.privateKey, payload),
    );
    expect(ok).toBe(false);
  });

  it("fails closed when the toml is unreachable or has no SIGNING_KEY", async () => {
    const k = newKey();
    const payload = "1.{}";
    stubToml(null, false);
    expect(
      await new CallbackVerifier().verify(
        "d.example",
        Buffer.from(payload),
        sign(k.privateKey, payload),
      ),
    ).toBe(false);
    stubToml(null, true);
    expect(
      await new CallbackVerifier().verify(
        "d.example",
        Buffer.from(payload),
        sign(k.privateKey, payload),
      ),
    ).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(
      await new CallbackVerifier().verify(
        "d.example",
        Buffer.from(payload),
        sign(k.privateKey, payload),
      ),
    ).toBe(false);
  });

  it("fails closed on a garbage signature", async () => {
    const k = newKey();
    stubToml(k.signingKey);
    expect(
      await new CallbackVerifier().verify("d.example", Buffer.from("x"), "!!not-base64!!"),
    ).toBe(false);
  });
});

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

function service(waker: InMemoryWaker, now?: () => number) {
  const deps: EngineDeps = {
    resolver: new StaticRouteResolver(() => createMockAdapter(), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    waker,
  };
  return createService({ corridors: new Map([["test", corridor()]]), deps, now });
}

describe("service: callback route is fail-closed", () => {
  const body = { transaction: { id: "tx-1" } };
  const rawBody = JSON.stringify(body);

  it("wakes the pending reconcile only for a validly signed callback", async () => {
    const k = newKey();
    stubToml(k.signingKey);
    const waker = new InMemoryWaker();
    let woken = false;
    waker.signal("tx-1").addEventListener("abort", () => {
      woken = true;
    });
    const t = String(Math.floor(Date.now() / 1000));
    const r = await service(waker).route({
      method: "POST",
      path: "/callbacks/sep31/test",
      headers: { signature: `t=${t}, s=${sign(k.privateKey, `${t}.${rawBody}`)}` },
      body,
      rawBody,
    });
    expect(r.status).toBe(200);
    expect(woken).toBe(true);
  });

  it("rejects a bad signature and does not wake", async () => {
    const k = newKey();
    const other = newKey();
    stubToml(k.signingKey);
    const waker = new InMemoryWaker();
    let woken = false;
    waker.signal("tx-1").addEventListener("abort", () => {
      woken = true;
    });
    const t = String(Math.floor(Date.now() / 1000));
    const r = await service(waker).route({
      method: "POST",
      path: "/callbacks/sep31/test",
      headers: { signature: `t=${t}, s=${sign(other.privateKey, `${t}.${rawBody}`)}` },
      body,
      rawBody,
    });
    expect(r.status).toBe(401);
    expect(woken).toBe(false);
  });

  it("rejects a stale timestamp even with a valid signature", async () => {
    const k = newKey();
    stubToml(k.signingKey);
    const t = String(Math.floor(Date.now() / 1000) - 3600);
    const r = await service(new InMemoryWaker()).route({
      method: "POST",
      path: "/callbacks/sep31/test",
      headers: { signature: `t=${t}, s=${sign(k.privateKey, `${t}.${rawBody}`)}` },
      body,
      rawBody,
    });
    expect(r.status).toBe(401);
  });

  it("rejects malformed headers quickly (no regex backtracking)", async () => {
    const svc = service(new InMemoryWaker());
    for (const signature of [
      "garbage",
      "t=1",
      "t=abc, s=xx",
      "t=1, s=",
      "t=".repeat(50_000),
    ]) {
      const started = Date.now();
      const r = await svc.route({
        method: "POST",
        path: "/callbacks/sep31/test",
        headers: { signature },
        body,
        rawBody,
      });
      expect(r.status).toBe(401);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });
});

describe("reconcile with the callback waker", () => {
  it("polling still completes when no callback ever arrives", async () => {
    let clock = 0;
    let polls = 0;
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async () => {
        polls += 1;
        const done = polls >= 3;
        return {
          ok: true as const,
          value: {
            status: done ? "completed" : "pending_receiver",
            settled: done,
            terminalFailure: false,
          },
        };
      },
    };
    const waker = new InMemoryWaker();
    const r = await reconcileUntil(adapter, "tx-nocb", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      deadlineMs: 60_000,
      pollMs: 1000,
      wake: waker.signal("tx-nocb"),
    });
    expect(r.ok).toBe(true);
    expect(polls).toBe(3);
  });

  it("a callback wakes the poll early and does not cause a busy loop", async () => {
    let polls = 0;
    const waker = new InMemoryWaker();
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async () => {
        polls += 1;
        const done = polls >= 3;
        return {
          ok: true as const,
          value: {
            status: done ? "completed" : "pending_receiver",
            settled: done,
            terminalFailure: false,
          },
        };
      },
    };
    waker.wake("tx-cb");
    let sleeps = 0;
    const r = await reconcileUntil(adapter, "tx-cb", {
      now: () => 0,
      // Never resolves on its own: only a wake can end the wait.
      sleep: () => {
        sleeps += 1;
        if (sleeps === 1) setTimeout(() => waker.wake("tx-cb"), 5);
        return new Promise<void>(() => {});
      },
      deadlineMs: 1_000_000,
      pollMs: 1000,
      wake: waker.signal("tx-cb"),
    });
    expect(r.ok).toBe(true);
    expect(polls).toBe(3);
    expect(sleeps).toBeLessThanOrEqual(2);
  });
});
