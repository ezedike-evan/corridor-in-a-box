// A seeded, dependency-free property-test driver, in the style of
// money-properties.test.ts. A failure reports the seed and the case index, so
// `SEED=<n> pnpm test <file>` replays it exactly.

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;

export const int = (r: Rand, n: number): number => Math.floor(r() * n);
export const pick = <T>(r: Rand, xs: readonly T[]): T => xs[int(r, xs.length)]!;

/** The seed for a run: `SEED` from the environment, else a fixed default. */
export function seedFromEnv(fallback: number): number {
  const raw = process.env.SEED;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

function show(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 400 ? `${s.slice(0, 400)}… (${s.length} chars)` : s;
}

/**
 * Run `property` on `runs` generated inputs. Case `i` draws from its own
 * generator seeded with `seed + i`, so one failing case replays on its own.
 */
export async function forAll<T>(
  seed: number,
  runs: number,
  gen: (r: Rand) => T,
  property: (input: T) => void | Promise<void>,
): Promise<void> {
  for (let i = 0; i < runs; i++) {
    const input = gen(rng(seed + i));
    try {
      await property(input);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(
        `property failed (SEED=${seed}, case ${i}, replay with SEED=${seed + i} and 1 run)\n` +
          `input: ${show(input)}\n${reason}`,
        { cause: e },
      );
    }
  }
}
