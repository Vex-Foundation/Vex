/**
 * The analysis card's read: one technical analysis plus the closed candles
 * it was computed on.
 *
 * Same engine, same loaders as the protocol tools
 * (`src/vex-agent/market-analysis/`), so the card and the chat agree on every
 * number for a market and interval. Main owns every provider request; the
 * renderer sends a validated market identity and never sees a provider URL.
 *
 * Bounded twice: the providers' own throttles still apply underneath (the
 * Lighter public bucket, the DexScreener bridge cap), and this module allows
 * at most 20 reads a minute across all cards, so a user clicking through
 * timeframes cannot spend the agent's provider budget. Over the limit is a
 * refusal with a sentence, the same shape as every other refusal.
 */

import { createDexscreenerCandleLoader } from "@vex-agent/market-analysis/dexscreener-loader.js";
import { createLighterCandleLoader } from "@vex-agent/market-analysis/lighter-loader.js";
import { describeAnalysisRefusal } from "@vex-agent/market-analysis/refusals.js";
import {
  runTechnicalAnalysis,
  type TechnicalAnalysisOutcome,
} from "@vex-agent/market-analysis/run.js";
import {
  TECHNICAL_ANALYSIS_CHART_MAX_CANDLES,
  type TechnicalAnalysisReadInput,
  type TechnicalAnalysisReadOutput,
} from "@shared/schemas/technical-analysis.js";

export const TECHNICAL_ANALYSIS_READS_PER_MINUTE = 20;
const WINDOW_MS = 60_000;

export interface TechnicalAnalysisReadDeps {
  readonly run: typeof runTechnicalAnalysis;
  readonly now: () => number;
}

const DEFAULT_DEPS: TechnicalAnalysisReadDeps = { run: runTechnicalAnalysis, now: Date.now };

/** Read times inside the current window, oldest first. Module-wide: one budget for every card. */
let recentReads: number[] = [];

export function __resetTechnicalAnalysisReadLimiterForTests(): void {
  recentReads = [];
}

function admit(now: number): number | null {
  recentReads = recentReads.filter((at) => now - at < WINDOW_MS);
  if (recentReads.length >= TECHNICAL_ANALYSIS_READS_PER_MINUTE) {
    return WINDOW_MS - (now - recentReads[0]!);
  }
  recentReads.push(now);
  return null;
}

function candlesOf(outcome: Extract<TechnicalAnalysisOutcome<unknown>, { ok: true }>) {
  return outcome.closed.slice(-TECHNICAL_ANALYSIS_CHART_MAX_CANDLES).map((bar) => ({
    t: bar.openTime,
    o: bar.open,
    h: bar.high,
    l: bar.low,
    c: bar.close,
  }));
}

export async function readTechnicalAnalysis(
  input: TechnicalAnalysisReadInput,
  signal?: AbortSignal,
  deps: TechnicalAnalysisReadDeps = DEFAULT_DEPS,
): Promise<TechnicalAnalysisReadOutput> {
  const venueLabel = input.venue === "lighter" ? "Lighter" : "DexScreener";
  const waitMs = admit(deps.now());
  if (waitMs !== null) {
    return {
      ok: false,
      reason: "source_unavailable",
      message: describeAnalysisRefusal(
        venueLabel,
        "source_unavailable",
        `the chart has read ${TECHNICAL_ANALYSIS_READS_PER_MINUTE} times in the last minute; try again in ${Math.ceil(waitMs / 1_000)} seconds`,
      ),
    };
  }

  const request = {
    interval: input.interval,
    ...(input.bars === undefined ? {} : { bars: input.bars }),
    untilMs: input.until ?? null,
  };

  if (input.venue === "lighter") {
    const outcome = await deps.run(
      createLighterCandleLoader({ environment: input.environment, marketId: input.marketId }),
      request,
    );
    if (!outcome.ok) {
      // A provider failure's own text can carry a URL; the card gets the code's sentence.
      const detail = outcome.reason === "source_unavailable" ? null : outcome.detail;
      return { ok: false, reason: outcome.reason, message: describeAnalysisRefusal(venueLabel, outcome.reason, detail) };
    }
    return { ...outcome.market, ...outcome.analysis, candles: candlesOf(outcome) };
  }

  const outcome = await deps.run(
    createDexscreenerCandleLoader({ chain: input.chain, pairAddress: input.pairAddress }, signal),
    request,
  );
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason, message: describeAnalysisRefusal(venueLabel, outcome.reason, outcome.detail) };
  }
  // The transport name is provenance for the tool, not part of the card's contract.
  const market = {
    venue: outcome.market.venue,
    chain: outcome.market.chain,
    pairAddress: outcome.market.pairAddress,
    pairLabel: outcome.market.pairLabel,
  };
  return { ...market, ...outcome.analysis, candles: candlesOf(outcome) };
}
