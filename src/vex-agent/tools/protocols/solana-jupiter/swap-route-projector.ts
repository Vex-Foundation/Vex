/**
 * Jupiter swap execution-route + price-impact projector (2026-07-25).
 *
 * `solana.swap.quote` used to return amounts, slippage, and the Vex fee
 * preview and nothing about HOW the swap executes or what it costs in
 * slippage — Solana was the only venue in the repo whose swap quote carried
 * no price impact (KyberSwap surfaces one via `kyberswap/helpers.ts`, Pendle
 * ships `priceImpact` on every quote). Both fields were already on the
 * validated `/build` response (`JupiterSwapBuildResponse.priceImpactPct` /
 * `.routePlan`, schema-checked in `jupiter-swaps/schemas.ts`), so this is
 * pure projection of data already fetched — no extra provider call.
 *
 * UNIT TRAP, named deliberately: Jupiter's field is called `priceImpactPct`
 * but its value is a decimal FRACTION, not a percent — the repo's own
 * captured reference (`agents_dm/agentscan-phase3/recon-docs-swap.md` §"Full
 * /order response schema") states `priceImpactPct` = `priceImpact` ÷ 100, and
 * the recorded live quote fixture shows `priceImpactPct
 * "-0.00015864212550172836"` against `priceImpact -0.015864212550172837`.
 * Surfacing it under the provider's own name would hand the agent a number
 * 100x smaller than the label implies, so it is surfaced as
 * `priceImpactFraction` — the SAME fraction convention KyberSwap's
 * `routeSummary.priceImpact` already uses (0.0015 = 0.15%).
 *
 * The value is passed through as the provider's exact STRING, never parsed:
 * a fabricated or rounded price impact is worse than the raw one, and the
 * agent can compare fractions lexically-safely against its own thresholds
 * after its own parse. A non-string/absent value degrades to `null`
 * ("unknown"), never to a reassuring `0`.
 */

import type {
  JupiterSwapBuildResponse,
  JupiterSwapRoutePlanStep,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/types.js";

/** One leg of the executed route — which venue fills which fraction of the swap. */
export interface ConciseJupiterSwapHop {
  /** Venue name as Jupiter reports it (e.g. "Whirlpool", "GoonFi V2"). */
  amm: string;
  /** The venue's pool/market account, for verification against the decoded transaction. */
  ammKey: string;
  inputMint: string;
  outputMint: string;
  /** Raw atomic units of `inputMint` routed through this hop. */
  inAmountRaw: string;
  /** Raw atomic units of `outputMint` produced by this hop. */
  outAmountRaw: string;
  /** Share of the whole swap this hop carries, 0-100. */
  percent: number;
}

export interface JupiterSwapRouteProjection {
  /**
   * Price impact as a decimal FRACTION (0.0015 = 0.15%), the provider's exact
   * string — Jupiter names this `priceImpactPct` but the value is not a
   * percent (see the module doc). `null` when the provider omitted it: unknown
   * impact, never assume zero.
   */
  priceImpactFraction: string | null;
  /** The venues this swap actually routes through, in provider order. */
  routePlan: ConciseJupiterSwapHop[];
}

function projectHop(step: JupiterSwapRoutePlanStep): ConciseJupiterSwapHop {
  return {
    amm: step.swapInfo.label,
    ammKey: step.swapInfo.ammKey,
    inputMint: step.swapInfo.inputMint,
    outputMint: step.swapInfo.outputMint,
    inAmountRaw: step.swapInfo.inAmount,
    outAmountRaw: step.swapInfo.outAmount,
    percent: step.percent,
  };
}

/**
 * Project a validated `/build` response's execution route and price impact.
 * Defensive on both fields: the response is external data, and `routePlan` is
 * only schema-checked as an array — a non-array degrades to an empty route
 * rather than throwing inside a quote handler.
 */
export function projectJupiterSwapRoute(raw: JupiterSwapBuildResponse): JupiterSwapRouteProjection {
  return {
    priceImpactFraction: typeof raw.priceImpactPct === "string" ? raw.priceImpactPct : null,
    routePlan: Array.isArray(raw.routePlan) ? raw.routePlan.map(projectHop) : [],
  };
}
