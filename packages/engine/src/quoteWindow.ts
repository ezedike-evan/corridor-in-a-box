// Gate check: the firm quote must outlive a configurable settle+confirm
// margin (#152). The engine used to refuse only a quote that had *already*
// expired, so a quote with seconds left would pass, then submit + Horizon
// confirmation (up to confirmTimeoutMs) landed after expiry and the anchor
// could reject or re-price the payout — after our money had moved. This
// check refuses to start settling unless `quote.expiresAt − now ≥ margin`,
// where the margin is the manifest's `fx.min_quote_remaining_seconds`.
//
// Engine-side and protocol-agnostic on purpose: everything it needs is
// already on the GateContext, so unlike the chain/anchor checks it needs no
// inspector or client injected.

import type { CheckResult, GateCheck, GateContext } from "./gate";

const NAME = "quote.window";

export function quoteWindowCheck(): GateCheck {
  return {
    name: NAME,
    async run(ctx: GateContext): Promise<CheckResult> {
      const start = Date.now();
      const done = (partial: Omit<CheckResult, "name" | "durationMs">): CheckResult => ({
        name: NAME,
        durationMs: Date.now() - start,
        ...partial,
      });

      if (!ctx.quote.firm) {
        // An indicative quote binds nobody to a rate, so there is no window
        // to protect — the receiving side re-prices at payout regardless.
        return done({ passed: true, detail: "indicative quote" });
      }

      const marginMs = ctx.corridor.fx.min_quote_remaining_seconds * 1000;
      const remainingMs = ctx.quote.expiresAt - ctx.now;

      if (remainingMs <= 0) {
        return done({
          passed: false,
          code: "PRESETTLE_QUOTE_WINDOW",
          detail: `firm quote expired ${Math.ceil(-remainingMs / 1000)}s ago`,
        });
      }
      if (remainingMs < marginMs) {
        return done({
          passed: false,
          code: "PRESETTLE_QUOTE_WINDOW",
          detail: `firm quote has ${Math.floor(remainingMs / 1000)}s left, below the ${ctx.corridor.fx.min_quote_remaining_seconds}s settle+confirm margin`,
        });
      }
      return done({
        passed: true,
        detail: `firm quote has ${Math.floor(remainingMs / 1000)}s left, within the ${ctx.corridor.fx.min_quote_remaining_seconds}s margin`,
      });
    },
  };
}
