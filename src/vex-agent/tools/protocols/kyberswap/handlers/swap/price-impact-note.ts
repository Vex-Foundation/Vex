/**
 * The agent-facing meaning of a NEGATIVE price impact on a swap quote.
 *
 * Vex derives price impact as (inUsd - outUsd) / inUsd (`kyberswap/helpers.ts`),
 * so a negative value means the quoted output is priced ABOVE the reference
 * value of the input. A live day-trading session (2026-08-10) showed the agent
 * re-deriving that semantic from scratch four times, so the explanation lives
 * next to the number instead of in the agent's reasoning budget.
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
