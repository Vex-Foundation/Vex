/**
 * The agent-facing meaning of a NEGATIVE price impact on a swap quote.
 *
 * Shared by every quote surface whose impact is COST-POSITIVE, i.e. where a
 * positive value is value given up and a negative value means the quoted output
 * is priced ABOVE the reference value of the input:
 *   - `kyberswap.swap.quote`, derived by Vex as (inUsd - outUsd) / inUsd
 *     (`kyberswap/helpers.ts`);
 *   - `solana.swap.quote`, the provider fraction pinned cost-positive by a live
 *     capture (`solana-jupiter/swap-route-projector.ts`, sign settled 2026-08-03).
 * A live day-trading session (2026-08-10) showed the agent re-deriving that
 * semantic from scratch four times, so the explanation lives next to the number
 * instead of in the agent's reasoning budget.
 *
 * NOT every impact figure in the repo shares this convention: some curve quotes
 * reports (execPrice - spotPrice) / spotPrice against the bonding curve, which is
 * structurally negative on EVERY sell (`curve-reader.ts` `computePriceImpactPct`),
 * so the note deliberately does not apply there.
 *
 * The input is a decimal FRACTION (-0.02 = -2%), never a percent.
 */

/**
 * Impacts inside this band are rounding/reference noise, not a pricing signal:
 * only a favourable impact of MORE than 0.1% is annotated.
 */
export const NEGATIVE_PRICE_IMPACT_EPSILON = -0.001;

export const NEGATIVE_PRICE_IMPACT_NOTE =
  "A negative price impact means the quoted output is priced above the pool's reference value; "
  + "on thin or fresh pools this usually signals stale or fragmented pricing, "
  + "so treat this quote as unreliable and re-quote before executing.";

/**
 * The sentence to append after a rendered price-impact figure, or "" when the
 * impact is absent, non-negative, or inside the noise band.
 */
export function negativePriceImpactNote(priceImpact: number | null): string {
  if (priceImpact === null || priceImpact >= NEGATIVE_PRICE_IMPACT_EPSILON) return "";
  return ` ${NEGATIVE_PRICE_IMPACT_NOTE}`;
}
