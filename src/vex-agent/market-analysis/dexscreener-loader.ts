/**
 * DexScreener pool candles for the analysis engine, EVM and Solana alike.
 *
 * Through `readRecentCandles` (`src/tools/dexscreener/candles-read.ts`), the
 * seam that resolves the pool's AMM id and quote token itself, so a series can
 * never come back inverted from a hand-built key. Its `lastBarPartial` flag is
 * ignored: it is true for ANY non-empty answer, and the engine applies the
 * time rule instead (`closed.ts`).
 *
 * The decimal strings become numbers HERE and nowhere earlier: this is
 * analysis, never money math. A bar missing any USD price is dropped and
 * counted. High and low are widened to cover the bar's own open and close by
 * the engine and counted there, because the provider's USD columns are
 * converted at different moments and were measured disagreeing on the same
 * bar (the `dexscreener.candles` manifest documents it). The seam carries OHLC
 * only, so volume is `null`; nothing in the bundle needs it.
 *
 * The chart route lives on a site host. Without the desktop app's site bridge
 * the degraded transport refuses by name, and that refusal is answered as
 * `no_candle_source` with the transport's own words, never as an empty
 * analysis.
 */

import {
  readRecentCandles,
  RECENT_CANDLES_MAX,
  type RecentCandle,
} from "@tools/dexscreener/candles-read.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
} from "@tools/dexscreener/site-errors.js";
import { getDexScreenerTransport } from "@tools/dexscreener/transport.js";
import { ANALYSIS_INTERVAL_MS } from "../../lib/market-analysis/result-schema.js";
import { assertChain } from "../tools/protocols/dexscreener/handlers/deep-dive/_shared.js";

import type { AnalysisBar, CandleLoadRequest, LoadCandles, LoadedCandles } from "./bars.js";

export interface DexscreenerAnalysisMarket {
  readonly venue: "dexscreener";
  readonly chain: string;
  readonly pairAddress: string;
  /** `BASE/QUOTE` from the provider's own pair snapshot, when it names both. */
  readonly pairLabel: string | null;
  /** The transport that served the bars, for the provenance block. */
  readonly transport: string;
}

export interface DexscreenerLoaderDeps {
  readonly resolveChain: (chain: string, signal: AbortSignal | undefined) => Promise<string>;
  readonly readCandles: typeof readRecentCandles;
  readonly now: () => number;
}

const DEFAULT_DEPS: DexscreenerLoaderDeps = {
  resolveChain: (chain, signal) => assertChain(chain, getDexScreenerTransport(), signal),
  readCandles: readRecentCandles,
  now: Date.now,
};

/** Site refusals that mean "this process has no route to the chart", not an outage. */
const NO_SOURCE_CODES: ReadonlySet<string> = new Set([
  DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE,
  DexScreenerSiteErrorCodes.TRANSPORT_HOST_NOT_ALLOWED,
]);

/** Site refusals that mean the chain or the pool is not one the provider knows. */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  DexScreenerSiteErrorCodes.CHAIN_SLUG_UNKNOWN,
  DexScreenerSiteErrorCodes.PAIR_NOT_RESOLVED,
  DexScreenerSiteErrorCodes.PAIR_IDENTITY_MISSING,
  DexScreenerSiteErrorCodes.AMM_ID_UNRESOLVED,
  DexScreenerSiteErrorCodes.BARS_QUOTE_UNRESOLVED,
]);

function usd(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toBar(candle: RecentCandle, intervalMs: number): AnalysisBar | null {
  const open = usd(candle.openUsd);
  const high = usd(candle.highUsd);
  const low = usd(candle.lowUsd);
  const close = usd(candle.closeUsd);
  if (open === null || high === null || low === null || close === null) return null;
  if (!Number.isSafeInteger(candle.timestampMs)) return null;
  return {
    openTime: candle.timestampMs,
    closeTime: candle.timestampMs + intervalMs,
    open,
    high,
    low,
    close,
    volume: null,
  };
}

export function createDexscreenerCandleLoader(
  target: { readonly chain: string; readonly pairAddress: string },
  signal?: AbortSignal,
  deps: DexscreenerLoaderDeps = DEFAULT_DEPS,
): LoadCandles<DexscreenerAnalysisMarket> {
  return async (request: CandleLoadRequest): Promise<LoadedCandles<DexscreenerAnalysisMarket>> => {
    const intervalMs = ANALYSIS_INTERVAL_MS[request.interval];
    // The seam reads the NEWEST buckets only, so a read that ends in the past
    // reads further back by the buckets since then, within one 999-bar page.
    const since = request.untilMs === null
      ? 0
      : Math.max(0, Math.ceil((deps.now() - request.untilMs) / intervalMs));
    const limit = Math.min(RECENT_CANDLES_MAX, request.count + 1 + since);
    try {
      const chainId = await deps.resolveChain(target.chain, signal);
      const read = await deps.readCandles({
        subject: { chainId, pairAddress: target.pairAddress },
        resolution: request.interval,
        limit,
        ...(signal === undefined ? {} : { signal }),
      });
      const bars: AnalysisBar[] = [];
      let unpriced = 0;
      for (const candle of read.candles) {
        const bar = toBar(candle, intervalMs);
        if (bar === null) unpriced += 1;
        else bars.push(bar);
      }
      const base = read.subject.baseTokenSymbol;
      const quote = read.subject.quoteTokenSymbol;
      return {
        ok: true,
        market: {
          venue: "dexscreener",
          chain: read.subject.chainId,
          pairAddress: read.subject.pairAddress,
          pairLabel: base !== null && quote !== null ? `${base}/${quote}`.slice(0, 128) : null,
          transport: getDexScreenerTransport().name,
        },
        bars,
        fetchedAtMs: read.fetchedAtMs,
        unpriced,
        source: "dexscreener_site_bars",
      };
    } catch (error) {
      // Only the site's typed refusals are answers; anything else is a defect
      // and keeps propagating, as the deep-dive handlers' `guarded` does.
      if (!isDexScreenerSiteError(error)) throw error;
      const detail = `${error.message}${error.hint === undefined ? "" : ` ${error.hint}`}`;
      if (NO_SOURCE_CODES.has(error.code)) return { ok: false, reason: "no_candle_source", detail };
      if (NOT_FOUND_CODES.has(error.code)) return { ok: false, reason: "market_not_found", detail };
      return { ok: false, reason: "source_unavailable", detail, cause: error };
    }
  };
}
