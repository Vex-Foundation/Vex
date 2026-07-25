/**
 * KyberSwap protocol-handler presentation helpers.
 *
 * Single source of truth for projecting the verbose aggregator route summary
 * into the compact, agent-facing shape surfaced by swap.quote / swap dryRun,
 * and for bounding the one provider-authored STRING that reaches the model on
 * the success path (`sanitizeProviderNote`).
 *
 * quote / dryRun are read-only surfaces (no `_tradeCapture` to preserve), so both the
 * `output` and `data` carry only the PROJECTED `routeSummary` — the verbose
 * provider route/pool internals (poolExtra/extra/routeID/checksum/...) are
 * dropped, not retained in `data`. The model never sees internals it cannot act
 * on. Keep this pure and deterministic — no IO, no throws on bad numbers.
 */

import type { SwapRouteSummary } from "@tools/kyberswap/aggregator/types.js";

/** One path through the route matrix: the venues it crosses, in order. */
export interface FormattedRoutePath {
  /** Exchange/venue labels for each hop in this path, in execution order. */
  readonly exchanges: string[];
  /** Raw base-unit input this path carries (the split size), from its first hop. `null` when the path is malformed. */
  readonly amountInRaw: string | null;
}

/** Compact, agent-facing projection of a KyberSwap aggregator route summary. */
export interface FormattedRouteSummary {
  readonly amountOut: string;
  readonly amountOutUsd: string;
  readonly amountIn: string;
  readonly amountInUsd: string;
  /** Estimated execution gas in USD (provider estimate). On an L2 this is the L2 execution cost only — see `l1FeeUsd`. */
  readonly gasUsd: string;
  /**
   * Estimated L1 data-availability fee in USD, on top of `gasUsd`. Present
   * only on L2s that charge one (most of the 19 supported chains are L2s), so
   * `null` here means "the provider quoted none", not "free". Provider
   * estimate, like `gasUsd`.
   */
  readonly l1FeeUsd: string | null;
  /**
   * The integrator fee this route carries, exactly as the aggregator applied
   * it (`feeAmount` is in basis points when `isInBps`, else raw base units of
   * the charged side). `null` when the route carries none.
   */
  readonly extraFee: FormattedExtraFee | null;
  /**
   * Fractional price impact derived from USD legs:
   *   (amountInUsd - amountOutUsd) / amountInUsd
   * Same fraction convention as zapDetails.priceImpact (0.0015 = 0.15%).
   * `null` when the input-USD denominator is 0 or non-finite (guarded).
   */
  readonly priceImpact: number | null;
  /** Number of non-null route hops across all paths in the route matrix. */
  readonly routeHops: number;
  /** Which venues the swap actually routes through, per path (labels only — pool internals stay dropped). */
  readonly routePaths: FormattedRoutePath[];
}

/** Integrator-fee projection — the provider's own validated fields, no derived math. */
export interface FormattedExtraFee {
  readonly feeAmount: string;
  readonly chargeFeeBy: "currency_in" | "currency_out" | null;
  readonly isInBps: boolean | null;
  readonly feeReceiver: string | null;
}

/**
 * Normalise a provider-authored note before it reaches model context.
 *
 * `additionalCostMessage` is free prose written by KyberSwap, so it is
 * untrusted content, not Vex copy. Content is NEVER truncated (owner rule:
 * agent-facing output is not silently shortened) — only control characters
 * are collapsed to spaces, so a message cannot smuggle newline/ANSI framing
 * into the surrounding output. Empty/whitespace-only degrades to `null`.
 */
export function sanitizeProviderNote(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex -- deliberate: strip C0/C1 control chars from untrusted prose.
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Parse a USD string into a finite number, or `null` when it is missing,
 * empty, or not a finite number. Defensive: the provider value is untrusted
 * text and must never throw here.
 */
function parseUsd(value: string | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Safely derive fractional price impact from the USD legs.
 *
 * Returns `null` when either leg is unparseable OR the input-USD denominator
 * is 0 (division-by-zero guard) — callers surface `null` rather than NaN/Inf.
 */
function derivePriceImpact(amountInUsd: string, amountOutUsd: string): number | null {
  const inUsd = parseUsd(amountInUsd);
  const outUsd = parseUsd(amountOutUsd);
  if (inUsd === null || outUsd === null) return null;
  if (inUsd === 0) return null; // guard division-by-zero
  return (inUsd - outUsd) / inUsd;
}

/**
 * Count non-null route hops across the route matrix.
 *
 * `route` is `SwapRouteStep[][]` (paths × steps). The depth we surface is the
 * total number of non-null steps across every path. Defensive against a
 * malformed/absent `route` (treated as 0 hops) since the value is untrusted.
 */
function countRouteHops(route: SwapRouteSummary["route"] | undefined): number {
  if (!Array.isArray(route)) return 0;
  let hops = 0;
  for (const path of route) {
    if (!Array.isArray(path)) continue;
    for (const step of path) {
      if (step != null) hops += 1;
    }
  }
  return hops;
}

/**
 * Project each path in the route matrix to its venue sequence.
 *
 * The bloat in `route` is the per-step `poolExtra`/`extra` unknown blobs, not
 * the venue names — so those blobs stay dropped while the exchange path (the
 * "which venues am I trading through" signal every other venue's quote
 * surfaces) is kept, plus each path's own input amount so a split route shows
 * its split. Defensive against a malformed/absent `route` (untrusted).
 */
function projectRoutePaths(route: SwapRouteSummary["route"] | undefined): FormattedRoutePath[] {
  if (!Array.isArray(route)) return [];
  const paths: FormattedRoutePath[] = [];
  for (const path of route) {
    if (!Array.isArray(path)) continue;
    const steps = path.filter((step) => step != null);
    if (steps.length === 0) continue;
    paths.push({
      // Only real labels are listed; a step with no usable `exchange` is left
      // out rather than named "unknown" — `routeHops` remains the authoritative
      // hop count, so a dropped label can never be read as a shorter route.
      exchanges: steps.map((step) => step.exchange).filter((label): label is string => typeof label === "string"),
      amountInRaw: typeof steps[0]?.swapAmount === "string" ? steps[0].swapAmount : null,
    });
  }
  return paths;
}

/** Project the optional integrator fee. `null` when the provider attached none. */
function projectExtraFee(extraFee: SwapRouteSummary["extraFee"] | undefined): FormattedExtraFee | null {
  if (extraFee == null || typeof extraFee.feeAmount !== "string") return null;
  return {
    feeAmount: extraFee.feeAmount,
    chargeFeeBy: extraFee.chargeFeeBy ?? null,
    isInBps: extraFee.isInBps ?? null,
    feeReceiver: extraFee.feeReceiver ?? null,
  };
}

/**
 * Project a verbose aggregator route summary to the compact agent-facing shape.
 *
 * Drops the per-step poolExtra/extra blobs, routeID/checksum, tokenIn/tokenOut
 * (echoed by the handler already), and gas/gasPrice (raw units the model
 * cannot act on). KEEPS the two cost fields that used to be dropped with them:
 * `l1FeeUsd` — which on the L2s that make up most of the 19 supported chains
 * can rival or exceed `gasUsd`, so omitting it understated the true cost —
 * and `extraFee`, the integrator fee actually applied to the trade. Derives a
 * guarded fractional price impact, a route-hop count, and the venue path.
 * Pure: never throws, never performs IO.
 */
export function formatRouteSummary(s: SwapRouteSummary): FormattedRouteSummary {
  return {
    amountOut: s.amountOut,
    amountOutUsd: s.amountOutUsd,
    amountIn: s.amountIn,
    amountInUsd: s.amountInUsd,
    gasUsd: s.gasUsd,
    l1FeeUsd: s.l1FeeUsd ?? null,
    extraFee: projectExtraFee(s.extraFee),
    priceImpact: derivePriceImpact(s.amountInUsd, s.amountOutUsd),
    routeHops: countRouteHops(s.route),
    routePaths: projectRoutePaths(s.route),
  };
}
