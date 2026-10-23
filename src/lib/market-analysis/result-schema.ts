/**
 * The technical analysis result contract.
 *
 * ONE definition for three readers: the agent runtime that produces a result
 * (`src/vex-agent/market-analysis/`), the main-process channel the analysis
 * card re-reads through, and the renderer card that parses a tool act's output
 * before drawing it. Two copies would drift into a card that silently stops
 * drawing a result the engine still produces.
 *
 * WHAT IS NOT HERE: candles. The model never sees them (they would cost
 * context for numbers it cannot read better than the indicators); the card
 * reads its own over IPC and the channel's schema adds them there.
 *
 * Pure by construction: imports only `zod`, so the renderer may hold it
 * (`vex-app/scripts/check-process-boundaries.mjs`).
 */

import { z } from "zod";

// ── Bounds every surface shares ──────────────────────────────────

/** The five intervals both candle sources serve. */
export const ANALYSIS_INTERVALS = ["5m", "15m", "1h", "4h", "1d"] as const;
export type AnalysisInterval = (typeof ANALYSIS_INTERVALS)[number];

export const ANALYSIS_INTERVAL_MS: Readonly<Record<AnalysisInterval, number>> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Closed bars the price facts cover. Fewer than the minimum is a refusal. */
export const ANALYSIS_BARS_MIN = 30;
export const ANALYSIS_BARS_MAX = 200;
export const ANALYSIS_BARS_DEFAULT = 100;
/** Extra history read so the slow indicators are warm on the first bar shown. */
export const ANALYSIS_WARMUP_BARS = 60;
/** The least ever read, so EMA 200 is warm at the default bar count. */
export const ANALYSIS_READ_MIN = 220;
/** Newest bars carried in `recent`. */
export const ANALYSIS_RECENT_BARS = 10;

/**
 * Why an analysis did not happen. `no_candle_source` is the DexScreener
 * transport refusal (no site bridge); the rest can come from either venue.
 */
export const ANALYSIS_REFUSAL_REASONS = [
  "market_not_found",
  "no_candles",
  "not_enough_history",
  "source_unavailable",
  "no_candle_source",
] as const;
export type AnalysisRefusalReason = (typeof ANALYSIS_REFUSAL_REASONS)[number];

// ── Parts ────────────────────────────────────────────────────────

const reading = z.number().nullable();

export const analysisIndicatorsSchema = z
  .object({
    ema20: reading,
    ema50: reading,
    ema200: reading,
    rsi14: reading,
    macd: reading,
    macdSignal: reading,
    macdHistogram: reading,
    bollingerUpper: reading,
    bollingerMiddle: reading,
    bollingerLower: reading,
    atr14: reading,
  })
  .strict();
export type AnalysisIndicators = z.infer<typeof analysisIndicatorsSchema>;

export const RSI_ZONES = ["overbought", "neutral", "oversold"] as const;
export const MACD_MOMENTUM = ["bullish", "bearish", "flat"] as const;
export const BOLLINGER_POSITIONS = ["above_upper", "upper_half", "lower_half", "below_lower"] as const;

/** Each signal is `null` when the reading it compares is still warming up. */
export const analysisSignalsSchema = z
  .object({
    aboveEma20: z.boolean().nullable(),
    aboveEma50: z.boolean().nullable(),
    ema20AboveEma50: z.boolean().nullable(),
    rsiZone: z.enum(RSI_ZONES).nullable(),
    macdMomentum: z.enum(MACD_MOMENTUM).nullable(),
    bollingerPosition: z.enum(BOLLINGER_POSITIONS).nullable(),
  })
  .strict();
export type AnalysisSignals = z.infer<typeof analysisSignalsSchema>;

export const analysisRecentBarSchema = z
  .object({
    closeTime: z.iso.datetime(),
    close: z.number(),
    rsi14: reading,
    macdHistogram: reading,
  })
  .strict();

/**
 * What the closed-candle rule did to the provider's rows. Nothing is ever
 * filled: a missing bucket is counted, never invented.
 */
export const analysisClosedCandlesSchema = z
  .object({
    /** Rows dropped because their bucket had not closed by `asOf`'s cut-off. */
    droppedForming: z.number().int().min(0),
    /** Expected buckets between the first and the newest kept bar that the provider did not emit. */
    gaps: z.number().int().min(0),
    /** Kept bars whose high or low was widened to cover their open and close. */
    normalized: z.number().int().min(0),
    /** Rows dropped because a price was missing or not a number. */
    unpriced: z.number().int().min(0),
    /** True when the gaps exceed a tenth of the window. */
    sparse: z.boolean(),
  })
  .strict();
export type AnalysisClosedCandles = z.infer<typeof analysisClosedCandlesSchema>;

/** The venue-independent part of an analysis. */
export const analysisCoreShape = {
  ok: z.literal(true),
  interval: z.enum(ANALYSIS_INTERVALS),
  /** ISO close time of the newest closed bar used. */
  asOf: z.iso.datetime(),
  fetchedAt: z.iso.datetime(),
  /** Closed bars the price facts cover. */
  bars: z.number().int().min(1).max(ANALYSIS_BARS_MAX),
  price: z.number(),
  changePct: reading,
  high: z.number(),
  low: z.number(),
  indicators: analysisIndicatorsSchema,
  signals: analysisSignalsSchema,
  recent: z.array(analysisRecentBarSchema).max(ANALYSIS_RECENT_BARS),
  closedCandles: analysisClosedCandlesSchema,
  /** Where the numbers came from, as the tool's provenance names it. */
  source: z.string().min(1).max(80),
  provenance: z.record(z.string(), z.unknown()).optional(),
} as const;

export const lighterAnalysisMarketShape = {
  venue: z.literal("lighter"),
  environment: z.enum(["core", "rhc"]),
  marketId: z.number().int().min(0).max(65_535),
  symbol: z.string().min(1).max(64),
  marketType: z.enum(["perp", "spot"]),
} as const;

export const dexscreenerAnalysisMarketShape = {
  venue: z.literal("dexscreener"),
  chain: z.string().min(1).max(64),
  pairAddress: z.string().min(1).max(128),
  pairLabel: z.string().min(1).max(128).nullable(),
} as const;

export const lighterAnalysisResultSchema = z
  .object({ ...analysisCoreShape, ...lighterAnalysisMarketShape })
  .strict();
export const dexscreenerAnalysisResultSchema = z
  .object({ ...analysisCoreShape, ...dexscreenerAnalysisMarketShape })
  .strict();

/** A successful analysis, as the tool returns it and the card parses it. */
export const technicalAnalysisResultSchema = z.discriminatedUnion("venue", [
  lighterAnalysisResultSchema,
  dexscreenerAnalysisResultSchema,
]);
export type TechnicalAnalysisResult = z.infer<typeof technicalAnalysisResultSchema>;
export type LighterAnalysisResult = z.infer<typeof lighterAnalysisResultSchema>;
export type DexscreenerAnalysisResult = z.infer<typeof dexscreenerAnalysisResultSchema>;

/** An analysis that did not happen, with a sentence that names why. */
export const technicalAnalysisRefusalSchema = z
  .object({
    ok: z.literal(false),
    reason: z.enum(ANALYSIS_REFUSAL_REASONS),
    message: z.string().min(1).max(600),
  })
  .strict();
export type TechnicalAnalysisRefusal = z.infer<typeof technicalAnalysisRefusalSchema>;
