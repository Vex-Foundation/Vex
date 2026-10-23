/**
 * `vex:market:readTechnicalAnalysis`: the analysis card's own read.
 *
 * The chat's technical analysis result carries no candles (the model never
 * needs them), so the card that draws the chart reads them here, and reads a
 * fresh analysis when the user switches timeframe, without a model call. Main
 * runs the SAME engine and the SAME loaders the protocol tools use
 * (`src/vex-agent/market-analysis/`), so the card and the chat see the same
 * numbers for a market and interval.
 *
 * The input names a market exactly as the tools do (Lighter environment and
 * market id; DexScreener chain and pool address) with the tools' own bounds.
 * `until` asks for the analysis as of an earlier close, which is how the card
 * redraws the bars a past reply used. A refusal is a VALUE, not an IPC error:
 * the card shows its sentence.
 */

import { z } from "zod";
import {
  ANALYSIS_BARS_MAX,
  ANALYSIS_BARS_MIN,
  ANALYSIS_INTERVALS,
  dexscreenerAnalysisResultSchema,
  lighterAnalysisResultSchema,
  technicalAnalysisRefusalSchema,
} from "@vex-lib/market-analysis/result-schema.js";

/** Closed candles the channel returns for the chart, oldest first. */
export const TECHNICAL_ANALYSIS_CHART_MAX_CANDLES = 260;

const interval = z.enum(ANALYSIS_INTERVALS);
const bars = z.number().int().min(ANALYSIS_BARS_MIN).max(ANALYSIS_BARS_MAX).optional();
const until = z.number().int().positive().optional();

export const technicalAnalysisReadInputSchema = z.discriminatedUnion("venue", [
  z
    .object({
      venue: z.literal("lighter"),
      environment: z.enum(["core", "rhc"]),
      marketId: z.number().int().min(0).max(65_535),
      interval,
      bars,
      until,
    })
    .strict(),
  z
    .object({
      venue: z.literal("dexscreener"),
      chain: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
      // Checksum spelling on EVM and base58 on Solana: letters and digits only.
      pairAddress: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9]+$/),
      interval,
      bars,
      until,
    })
    .strict(),
]);
export type TechnicalAnalysisReadInput = z.infer<typeof technicalAnalysisReadInputSchema>;

export const technicalAnalysisCandleSchema = z
  .object({
    /** Open time, epoch milliseconds. */
    t: z.number().int().nonnegative(),
    o: z.number(),
    h: z.number(),
    l: z.number(),
    c: z.number(),
  })
  .strict();
export type TechnicalAnalysisCandle = z.infer<typeof technicalAnalysisCandleSchema>;

const candles = z.array(technicalAnalysisCandleSchema).max(TECHNICAL_ANALYSIS_CHART_MAX_CANDLES);

export const technicalAnalysisReadOutputSchema = z.union([
  lighterAnalysisResultSchema.extend({ candles }).strict(),
  dexscreenerAnalysisResultSchema.extend({ candles }).strict(),
  technicalAnalysisRefusalSchema,
]);
export type TechnicalAnalysisReadOutput = z.infer<typeof technicalAnalysisReadOutputSchema>;
