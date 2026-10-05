import { compareAmounts, type CorridorErrorCode, type Outcome } from "@corridor/types";
import {
  buildSettlementRequest,
  type CheckResult,
  type GateCheck,
  type GateContext,
} from "@corridor/engine";
import type { Sep31Info } from "./index";

export interface InfoAdapterLike {
  getInfo(): Promise<Outcome<Sep31Info>>;
}

/** Resolves the anchor's /info for one gate run. */
export type InfoSource = (ctx: GateContext) => Promise<Outcome<Sep31Info>>;

/**
 * Memoises a single /info fetch per gate run (keyed on the GateContext), so
 * `sep31InfoCheck` and `amountRangeCheck` share one request even though the
 * CompositeGate runs them concurrently.
 */
export function sharedInfoSource(adapter: InfoAdapterLike): InfoSource {
  const cache = new WeakMap<GateContext, Promise<Outcome<Sep31Info>>>();
  return (ctx) => {
    let p = cache.get(ctx);
    if (!p) {
      p = adapter.getInfo();
      cache.set(ctx, p);
    }
    return p;
  };
}

type Bound = { ok: true; value: string | undefined } | { ok: false; message: string };

function pick(a: string | undefined, b: string | undefined, want: "max" | "min"): Bound {
  if (!a) return { ok: true, value: b };
  if (!b) return { ok: true, value: a };
  const cmp = compareAmounts(a, b);
  if (!cmp.ok) return { ok: false, message: cmp.error.message };
  const aWins = want === "max" ? cmp.value > 0 : cmp.value < 0;
  return { ok: true, value: aWins ? a : b };
}

const OUT_OF_RANGE: CorridorErrorCode = "PRESETTLE_AMOUNT_OUT_OF_RANGE";

export function amountRangeCheck(adapter: InfoAdapterLike, info?: InfoSource): GateCheck {
  const source: InfoSource = info ?? (() => adapter.getInfo());
  return {
    name: "sep31.amount.range",
    async run(ctx: GateContext): Promise<CheckResult> {
      const start = Date.now();
      const failed = (detail: string, code: CorridorErrorCode): CheckResult => ({
        name: "sep31.amount.range",
        passed: false,
        code,
        detail,
        durationMs: Date.now() - start,
      });

      const bridgeAsset = ctx.corridor.settlement.bridge_asset;
      const amount = buildSettlementRequest(ctx.opened, ctx.quote, ctx.corridor).amount.amount;

      const infoOutcome = await source(ctx);
      if (!infoOutcome.ok) {
        return failed(
          `failed to fetch /info for amount check: ${infoOutcome.error.message}`,
          "PRESETTLE_ANCHOR_DRIFT",
        );
      }

      const assetInfo = infoOutcome.value.receive[bridgeAsset];
      const min = pick(ctx.corridor.limits?.min_amount, assetInfo?.minAmount, "max");
      const max = pick(ctx.corridor.limits?.max_amount, assetInfo?.maxAmount, "min");
      if (!min.ok)
        return failed(`cannot compare minimum bounds: ${min.message}`, OUT_OF_RANGE);
      if (!max.ok)
        return failed(`cannot compare maximum bounds: ${max.message}`, OUT_OF_RANGE);

      if (min.value) {
        const cmp = compareAmounts(amount, min.value);
        if (!cmp.ok)
          return failed(`cannot compare amount ${amount}: ${cmp.error.message}`, OUT_OF_RANGE);
        if (cmp.value < 0)
          return failed(`amount ${amount} is below minimum ${min.value}`, OUT_OF_RANGE);
      }
      if (max.value) {
        const cmp = compareAmounts(amount, max.value);
        if (!cmp.ok)
          return failed(`cannot compare amount ${amount}: ${cmp.error.message}`, OUT_OF_RANGE);
        if (cmp.value > 0)
          return failed(`amount ${amount} is above maximum ${max.value}`, OUT_OF_RANGE);
      }

      return {
        name: "sep31.amount.range",
        passed: true,
        detail: `amount ${amount} is within range`,
        durationMs: Date.now() - start,
      };
    },
  };
}
