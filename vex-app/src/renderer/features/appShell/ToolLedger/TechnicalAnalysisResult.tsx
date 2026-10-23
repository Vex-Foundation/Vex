/**
 * The visible result of a technical analysis (`lighter.technicalAnalysis`,
 * `dexscreener.technicalAnalysis`), shown under the act like a mission's
 * result block, because the act row is collapsed and the numbers the user
 * asked for would otherwise sit behind a disclosure.
 *
 * READ FAIL-CLOSED. Only an act of one of the two tools, only when the engine
 * recorded `success === true`, only within the act row's 20,000-character
 * parse gate, and only when the output parses with the SHARED result contract
 * (`@vex-lib/market-analysis/result-schema.js`, the definition the engine
 * produces). Anything else renders no card and the step row stays.
 *
 * WHAT THE CARD READS ITSELF. The tool's output carries no candles, so the
 * chart comes from `vex:market:readTechnicalAnalysis`: the reply's own
 * interval is re-read with `until` at the reply's `asOf`, so the chart shows
 * the bars the reply used; another interval is a fresh read. A timeframe
 * switch is that channel read, never a model call. The ledger of the reply's
 * interval is the reply's own numbers; another interval's ledger is the
 * read's.
 *
 * R3 Minimal (docs/design/R3-MINIMAL.md sections 1.2, 1.3, 6): words in
 * Instrument Sans, every figure in JetBrains Mono with `vex-num`, signals as
 * words, and status in words rather than colour. The change is ink with its
 * sign: section 1.2 lists the surfaces that take trading colour and a chat
 * card is not one of them. Candles keep their own pair inside the chart. A
 * reading is not a buy or sell signal, and the card says so.
 */

import { lazy, Suspense, useState, type JSX } from "react";

import {
  ANALYSIS_INTERVALS,
  technicalAnalysisResultSchema,
  type AnalysisInterval,
  type TechnicalAnalysisResult as AnalysisResult,
} from "@vex-lib/market-analysis/result-schema.js";
import type { TechnicalAnalysisReadInput } from "@shared/schemas/technical-analysis.js";
import { useTechnicalAnalysisRead } from "../../../lib/api/technical-analysis.js";
import type { ToolCallActView } from "../transcriptRowModel/act-ledger.js";

// Lazy: the chart pulls lightweight-charts, which the transcript must not pay
// for until an analysis is actually on screen.
const TechnicalAnalysisChart = lazy(async () => ({
  default: (await import("./TechnicalAnalysisChart.js")).TechnicalAnalysisChart,
}));

/** The act row's own parse gate (`ToolActRow.tsx`). */
const MAX_PARSE_CHARS = 20_000;
const TOOL_NAMES: ReadonlySet<string> = new Set(["lighter.technicalAnalysis", "dexscreener.technicalAnalysis"]);

/** The accepted analysis this act returned, or `null` for any other act. */
export function readTechnicalAnalysisResult(act: ToolCallActView): AnalysisResult | null {
  if (!TOOL_NAMES.has(act.toolName) || act.success !== true) return null;
  if (act.output === null || act.output.length === 0 || act.output.length > MAX_PARSE_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(act.output);
  } catch {
    return null;
  }
  const result = technicalAnalysisResultSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

const FIGURE = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });

function figure(value: number | null): string {
  return value === null ? "warming up" : FIGURE.format(value);
}

function marketLine(result: AnalysisResult): string {
  if (result.venue === "lighter") {
    const environment = result.environment === "core" ? "Lighter Core" : "Lighter on Robinhood Chain";
    return `${result.symbol} ${result.marketType === "perp" ? "perpetual" : "spot"} · ${environment}`;
  }
  return `${result.pairLabel ?? "Pool"} · DexScreener · ${result.chain}`;
}

function readInputFor(
  result: AnalysisResult,
  interval: AnalysisInterval,
): TechnicalAnalysisReadInput {
  const until = interval === result.interval ? Date.parse(result.asOf) : undefined;
  const common = { interval, ...(until === undefined ? {} : { until }) };
  return result.venue === "lighter"
    ? { venue: "lighter", environment: result.environment, marketId: result.marketId, ...common }
    : { venue: "dexscreener", chain: result.chain, pairAddress: result.pairAddress, ...common };
}

/** "14:00 UTC, 23 Oct 2026": the close the newest used bar ended on. */
export function closeStamp(iso: string): string {
  const at = new Date(iso);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  const date = at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${hh}:${mm} UTC, ${date}`;
}

const RSI_WORDS = { overbought: "RSI overbought (70 or above)", oversold: "RSI oversold (30 or below)", neutral: "RSI neutral" } as const;
const MOMENTUM_WORDS = { bullish: "MACD momentum up", bearish: "MACD momentum down", flat: "MACD momentum flat" } as const;
const BAND_WORDS = {
  above_upper: "Price above the upper band",
  upper_half: "Price in the upper half of the bands",
  lower_half: "Price in the lower half of the bands",
  below_lower: "Price below the lower band",
} as const;

function signalWords(result: AnalysisResult): string[] {
  const s = result.signals;
  const words: string[] = [];
  if (s.aboveEma20 !== null) words.push(s.aboveEma20 ? "Price above EMA 20" : "Price below EMA 20");
  if (s.aboveEma50 !== null) words.push(s.aboveEma50 ? "Price above EMA 50" : "Price below EMA 50");
  if (s.ema20AboveEma50 !== null) words.push(s.ema20AboveEma50 ? "EMA 20 above EMA 50" : "EMA 20 below EMA 50");
  if (s.rsiZone !== null) words.push(RSI_WORDS[s.rsiZone]);
  if (s.macdMomentum !== null) words.push(MOMENTUM_WORDS[s.macdMomentum]);
  if (s.bollingerPosition !== null) words.push(BAND_WORDS[s.bollingerPosition]);
  return words;
}

function dataNotes(result: AnalysisResult): string[] {
  const c = result.closedCandles;
  const notes: string[] = [];
  if (c.gaps > 0) notes.push(`${c.gaps} missing ${c.gaps === 1 ? "bucket" : "buckets"}, not filled`);
  if (c.sparse) notes.push("the series is sparse: gaps exceed a tenth of the window");
  if (c.normalized > 0) notes.push(`${c.normalized} ${c.normalized === 1 ? "bar's" : "bars'"} high or low widened to cover the open and close`);
  if (c.unpriced > 0) notes.push(`${c.unpriced} ${c.unpriced === 1 ? "row" : "rows"} without a price dropped`);
  return notes;
}

function Ledger({ result }: { readonly result: AnalysisResult }): JSX.Element {
  const i = result.indicators;
  const rows: readonly (readonly [string, number | null])[] = [
    ["EMA 20", i.ema20],
    ["EMA 50", i.ema50],
    ["EMA 200", i.ema200],
    ["RSI 14", i.rsi14],
    ["MACD", i.macd],
    ["MACD signal", i.macdSignal],
    ["MACD histogram", i.macdHistogram],
    ["Bollinger upper", i.bollingerUpper],
    ["Bollinger middle", i.bollingerMiddle],
    ["Bollinger lower", i.bollingerLower],
    ["ATR 14", i.atr14],
  ];
  return (
    <dl data-vex-area="technical-analysis-ledger" className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 border-b border-rule-quiet py-1">
          <dt className="text-[13px] text-ink-secondary">{label}</dt>
          <dd className="m-0 font-mono text-[13px] text-ink-primary vex-num">{figure(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Readout({ result }: { readonly result: AnalysisResult }): JSX.Element {
  const change = result.changePct;
  const notes = dataNotes(result);
  return (
    <>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="font-mono text-[20px] font-medium text-ink-primary vex-num">{figure(result.price)}</span>
        {change !== null ? (
          <span className="font-mono text-[13px] text-ink-secondary vex-num">
            {`${change > 0 ? "+" : ""}${FIGURE.format(change)}%`}
          </span>
        ) : null}
        <span className="text-[13px] text-ink-tertiary">{`over ${result.bars} closed ${result.interval} bars`}</span>
      </div>
      <Ledger result={result} />
      <ul data-vex-area="technical-analysis-signals" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-secondary">
        {signalWords(result).map((word) => (
          <li key={word}>{word}</li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] leading-[1.45] text-ink-tertiary">
        {`Closed candles to ${closeStamp(result.asOf)}; the forming candle is not used.`}
        {notes.length > 0 ? ` ${notes.join("; ")}.` : ""}
      </p>
    </>
  );
}

export function TechnicalAnalysisResult({ result }: { readonly result: AnalysisResult }): JSX.Element {
  const [interval, setInterval] = useState<AnalysisInterval>(result.interval);
  const read = useTechnicalAnalysisRead(readInputFor(result, interval));
  const isReply = interval === result.interval;
  const data = read.data?.ok === true ? read.data.data : null;
  const live = data !== null && data.ok ? data : null;
  const refusal = data !== null && !data.ok ? data.message : null;
  const failed = read.data !== undefined && read.data.ok === false;
  // The reply's interval shows the reply's own numbers; another interval shows the read's.
  const shown: AnalysisResult | null = isReply ? result : live;

  return (
    <div data-vex-area="technical-analysis-result" className="mb-4 mt-1 border border-rule bg-surface-base px-[18px] py-4">
      <b className="text-[16px] font-medium leading-6 text-ink-primary">{marketLine(result)}</b>
      <div role="group" aria-label="Timeframe" className="mt-3 flex flex-wrap items-center gap-1">
        {ANALYSIS_INTERVALS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === interval}
            data-vex-action="technical-analysis-interval"
            className={`h-7 px-2 font-mono text-[13px] vex-num focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              option === interval ? "bg-interactive-active text-ink-primary" : "text-ink-secondary hover:bg-interactive-hover"
            }`}
            onClick={() => setInterval(option)}
          >
            {option}
          </button>
        ))}
        <span className="ml-2 text-[12px] text-ink-tertiary">
          {isReply ? `The reply was written for ${result.interval}.` : `Showing ${interval}; the reply was written for ${result.interval}.`}
        </span>
      </div>

      <div className="mt-3">
        {live !== null && live.candles.length > 0 ? (
          <Suspense fallback={<div className="h-56" />}>
            <TechnicalAnalysisChart
              subjectKey={`${marketLine(result)}:${interval}`}
              candles={live.candles}
              label={`${marketLine(result)}, ${interval} candles with EMA 20 and EMA 50`}
            />
          </Suspense>
        ) : refusal !== null || failed ? (
          <p className="text-[13px] text-ink-secondary">
            {isReply ? "The chart for this reply's window cannot be drawn now. " : ""}
            {refusal ?? "The chart could not be read."}
          </p>
        ) : (
          <p className="text-[13px] text-ink-tertiary">Reading candles…</p>
        )}
      </div>

      {shown !== null ? <Readout result={shown} /> : null}
      <p className="mt-2 text-[12px] text-ink-tertiary">A reading is not a buy or sell signal.</p>
    </div>
  );
}
