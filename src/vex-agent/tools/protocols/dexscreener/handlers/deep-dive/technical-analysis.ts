/**
 * Handler for `dexscreener__technical_analysis_get`.
 *
 * The shared analysis engine (`src/vex-agent/market-analysis/`) on one pool's
 * closed candles. The pool is named, never chosen: there is no `tokenAddress`
 * here, because a token resolves to "the deepest of at most 30 pools" and an
 * analysis of a pool nobody picked would read as an analysis of the token. The
 * model picks the pool first with dexscreener__pairs_search or
 * dexscreener__token_pairs_list.
 *
 * Every refusal is a sentence carrying its code (`market-analysis/refusals.ts`),
 * the same wording the analysis card's channel uses.
 */

import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import { createDexscreenerCandleLoader } from "@vex-agent/market-analysis/dexscreener-loader.js";
import { describeAnalysisRefusal } from "@vex-agent/market-analysis/refusals.js";
import { runTechnicalAnalysis } from "@vex-agent/market-analysis/run.js";
import {
  ANALYSIS_BARS_DEFAULT,
  ANALYSIS_BARS_MAX,
  ANALYSIS_BARS_MIN,
  ANALYSIS_INTERVALS,
  type AnalysisInterval,
} from "../../../../../../lib/market-analysis/result-schema.js";
import { fail, ok, str } from "../../../handler-helpers.js";
import { readBoundedInteger, readEnum } from "./_shared.js";

export async function runTechnicalAnalysisTool(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof ok>> {
  const chain = str(params, "chain").trim();
  const pairAddress = str(params, "pairAddress").trim();
  if (chain === "" || pairAddress === "") {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      "\"chain\" and \"pairAddress\" are both required: the analysis is of ONE named pool",
      "Find the pool first with dexscreener__pairs_search or dexscreener__token_pairs_list, then pass its chain and pairAddress.",
    );
  }
  if (str(params, "interval") === "") {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      "\"interval\" is required",
      `Accepted values: ${ANALYSIS_INTERVALS.join(", ")}.`,
    );
  }
  const interval = readEnum<AnalysisInterval>(params, "interval", ANALYSIS_INTERVALS, "1h");
  const bars = readBoundedInteger(
    params,
    "bars",
    ANALYSIS_BARS_MIN,
    ANALYSIS_BARS_MAX,
    ANALYSIS_BARS_DEFAULT,
    `Closed candles the price facts cover; ${ANALYSIS_BARS_DEFAULT} when omitted.`,
  );

  const outcome = await runTechnicalAnalysis(
    createDexscreenerCandleLoader({ chain, pairAddress }, signal),
    { interval, bars },
  );
  if (!outcome.ok) {
    return fail(describeAnalysisRefusal("DexScreener", outcome.reason, outcome.detail));
  }
  const { transport, ...market } = outcome.market;
  return ok({
    ...market,
    ...outcome.analysis,
    provenance: {
      source: outcome.analysis.source,
      provider: "dexscreener",
      toolId: "dexscreener.technicalAnalysis",
      transport,
      resolution: interval,
      retrievedAt: outcome.analysis.fetchedAt,
      priceBasis: "usd",
    },
  });
}
