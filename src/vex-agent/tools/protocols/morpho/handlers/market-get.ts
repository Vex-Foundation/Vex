/**
 * `morpho.market.get` - one Morpho Blue market in full.
 *
 * Everything this returns beyond the discovery row is a risk fact the screening
 * call cannot carry: outstanding and realized bad debt, the oracle price
 * liquidations are actually decided against, the adaptive-curve target rate,
 * the Public Allocator liquidity broken down per vault, and the curated vaults
 * supplying the market.
 *
 * `includeHistory` uses GraphQL, NOT the REST timeseries. Live introspection on
 * 2026-08-14 showed that no field of `MarketState` takes arguments: Morpho
 * exposes averages as fixed named fields (`weeklyNetSupplyApy` and siblings), so
 * a `lookback` selects a field name after one response arrives rather than
 * driving a second call to `api.morpho.org/v0`. That keeps the whole tool on one
 * request, one budget, and one error contract. The reasoning is recorded in
 * `src/tools/morpho/Morpho.md` as well as here.
 */

import { getMorphoClient } from "@tools/morpho/client.js";
import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoMarketGetParams } from "../read-params.js";
import { MORPHO_APY_DISCLAIMER, MORPHO_USD_DISCLAIMER, projectMarketDetail } from "../projectors.js";
import { morphoFailureDetail } from "./shared.js";

export async function morphoMarketGet(
  params: Record<string, unknown>,
  context?: { abortSignal?: AbortSignal },
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoMarketGetParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  let detail;
  try {
    detail = await getMorphoClient().getMarket(
      {
        marketId: q.marketId,
        chainId: q.chainId,
        includeHistory: q.includeHistory,
        lookback: q.lookback,
        includeSupplyingVaults: q.includeSupplyingVaults,
      },
      context?.abortSignal,
    );
  } catch (err) {
    return fail(`morpho.market.get failed ${morphoFailureDetail(err)}`);
  }

  const market = projectMarketDetail(detail, q.lookback);
  const redWarnings = detail.warnings.filter((w) => w.level === "RED");

  return ok({
    summary:
      `${detail.loanAsset.symbol ?? "loan asset"} borrowed against `
      + `${detail.collateralAsset?.symbol ?? "no collateral (idle market)"} on ${q.chainSlug}, `
      + `${detail.listed ? "curated by Morpho" : "PERMISSIONLESS and NOT curated by Morpho"}.`
      + (redWarnings.length > 0
        ? ` ${redWarnings.length} RED warning(s): ${redWarnings.map((w) => w.type).join(", ")}.`
        : ""),
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    market,
    notes: {
      apy: MORPHO_APY_DISCLAIMER,
      usd: MORPHO_USD_DISCLAIMER,
      entry:
        "Before treating this market as an entry: `listed:false` means nobody vetted it, a RED warning names a "
        + "concrete defect (an unusable oracle makes every USD figure and every liquidation price here unreliable), "
        + "and non-zero outstanding bad debt means suppliers have already lost principal.",
      history: q.includeHistory
        ? "`apyWindow` is an AVERAGE over the requested window, on the same base-versus-net split as the live block."
        : "Set includeHistory:true with a `lookback` to see whether today's rate is high or low for this market.",
    },
    nextStep:
      "Compare against siblings with morpho.markets.discover on the same loan asset before committing. "
      + "Vex has no Morpho mutating tools yet - this namespace is read-only.",
  });
}
