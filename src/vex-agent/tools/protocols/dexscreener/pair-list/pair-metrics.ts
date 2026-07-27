/**
 * Derived numbers for one DexScreener pair row.
 *
 * This is the ONE place a provider field becomes a Vex number. Filters, sorting
 * and projection all read the same `PairMetrics`, so a threshold, an ordering
 * and an emitted value can never disagree about what "24 h volume" or "age"
 * means.
 *
 * Two rules from `rules/90-vex-project.md` shape every reader here:
 *
 * - **Tolerant reader.** Every field the provider may omit or send as `null`
 *   normalises to `null`, never to `0`. A `0` turnover ratio and an unknowable
 *   one are different facts, and coercing the second into the first is how a
 *   fake pool passes a `minTurnoverRatio` gate.
 * - **A provider's number is a hint.** Nothing here repairs a provider value;
 *   it only derives the ratios that let the agent judge one. `turnoverRatio`
 *   (volume ÷ liquidity) is the cheapest fake-depth signal available from this
 *   API: measured 2026-07-26, a genuine Ethereum WETH/USDC pool sits near 0.22
 *   while a pool reporting $1.63 B of liquidity against 59.72 quote tokens sits
 *   at 0.00013.
 *
 * `priceUsdNumeric` is the single float parse in this module and it is NEVER
 * emitted. It exists only to order pools and to compare one pool's price with
 * the median across a token's pools (see `./price-sanity.ts`). The money value
 * the agent acts on stays the provider's exact-decimal string.
 */

import type { DexPair } from "@tools/dexscreener/types.js";

/**
 * Windows DexScreener reports on `volume` / `txns` / `priceChange`.
 *
 * The live schema is an OPEN map (`additionalProperties`), so these four are
 * the windows we read, not the only keys the provider may send. Measured over
 * 489 live rows: `volume` and `txns` carry all four on 100 % of rows;
 * `priceChange` carries m5 on 31 %, h1 61 %, h6 74 %, h24 87 %.
 */
export const PAIR_WINDOWS = ["m5", "h1", "h6", "h24"] as const;

export type PairWindow = (typeof PAIR_WINDOWS)[number];

/** Per-window flow metrics. Every field is `null` when the provider omitted it. */
export interface PairWindowMetrics {
  /** USD traded in this window. */
  volumeUsd: number | null;
  /** Already a percent (`1.08` = +1.08 %) — never multiplied by 100 here. */
  priceChangePct: number | null;
  txnBuyCount: number | null;
  txnSellCount: number | null;
  /** buys + sells. `null` when either side is unknown. */
  txnCount: number | null;
  /** buys ÷ sells. `null` when sells is 0 or unknown — not `Infinity`. */
  buySellRatio: number | null;
  /** volumeUsd ÷ liquidityUsd. `null` when either input is null or liquidity is 0. */
  turnoverRatio: number | null;
}

export interface PairMetrics {
  windows: Record<PairWindow, PairWindowMetrics>;
  liquidityUsd: number | null;
  /** Base-token units held by the pool — a fake-depth detector, not USD. */
  liquidityBaseTokens: number | null;
  /** Quote-token units held by the pool — the other fake-depth detector. */
  liquidityQuoteTokens: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  /**
   * `true` when the provider reports market cap == FDV, which means
   * *circulating supply unknown*, not *no dilution*. `null` when either input
   * is missing, because then we cannot say either way. Measured on 58 % of
   * rows.
   */
  marketCapEqualsFdv: boolean | null;
  pairCreatedAtMs: number | null;
  /**
   * Age at `asOfMs`. `null` when `pairCreatedAt` is absent (~9 % of rows) or
   * would imply a pool created in the future — an age we cannot state is not
   * an age of zero.
   */
  pairAgeSeconds: number | null;
  /** Active paid boosts. Absent unless boosted (1 of 489 rows measured). */
  activeBoostCount: number | null;
  /** Ordering/median input only — never emitted. See module docstring. */
  priceUsdNumeric: number | null;
  /**
   * Tri-state: `null` means the provider sent no `info` block at all (33 % of
   * rows), which is "unknown", not "no website".
   */
  hasWebsite: boolean | null;
  hasSocials: boolean | null;
  socialPlatforms: string[] | null;
  imageUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Finite numbers only — `NaN` / `Infinity` from a provider are not values. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function windowValue(map: unknown, key: PairWindow): number | null {
  if (!isRecord(map)) return null;
  return finiteOrNull(map[key]);
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

function txnSide(txns: unknown, window: PairWindow, side: "buys" | "sells"): number | null {
  if (!isRecord(txns)) return null;
  const bucket = txns[window];
  if (!isRecord(bucket)) return null;
  return finiteOrNull(bucket[side]);
}

/** Age in whole seconds, or `null` when it cannot be stated. */
function ageSeconds(createdAtMs: number | null, asOfMs: number): number | null {
  if (createdAtMs === null || createdAtMs <= 0) return null;
  const elapsedMs = asOfMs - createdAtMs;
  if (elapsedMs < 0) return null;
  return Math.floor(elapsedMs / 1000);
}

/** Parse the exact-decimal `priceUsd` for ORDERING only. Never for money. */
function priceForOrdering(priceUsd: unknown): number | null {
  if (typeof priceUsd !== "string" || priceUsd.trim() === "") return null;
  const parsed = Number(priceUsd);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function socialPlatformsOf(info: unknown): string[] | null {
  if (!isRecord(info)) return null;
  const socials = info.socials;
  if (!Array.isArray(socials)) return [];
  const platforms: string[] = [];
  for (const entry of socials) {
    if (isRecord(entry) && typeof entry.platform === "string" && entry.platform !== "") {
      platforms.push(entry.platform);
    }
  }
  return platforms;
}

/** Derive every number the pipeline needs from one raw provider row. */
export function computePairMetrics(pair: DexPair, asOfMs: number): PairMetrics {
  const liquidity = isRecord(pair.liquidity) ? pair.liquidity : null;
  const liquidityUsd = liquidity ? finiteOrNull(liquidity.usd) : null;
  const fdvUsd = finiteOrNull(pair.fdv);
  const marketCapUsd = finiteOrNull(pair.marketCap);
  const pairCreatedAtMs = finiteOrNull(pair.pairCreatedAt);
  const info = isRecord(pair.info) ? pair.info : null;

  const metricsFor = (window: PairWindow): PairWindowMetrics => {
    const volumeUsd = windowValue(pair.volume, window);
    const txnBuyCount = txnSide(pair.txns, window, "buys");
    const txnSellCount = txnSide(pair.txns, window, "sells");
    return {
      volumeUsd,
      priceChangePct: windowValue(pair.priceChange, window),
      txnBuyCount,
      txnSellCount,
      txnCount:
        txnBuyCount === null || txnSellCount === null ? null : txnBuyCount + txnSellCount,
      buySellRatio: ratio(txnBuyCount, txnSellCount),
      turnoverRatio: ratio(volumeUsd, liquidityUsd),
    };
  };

  return {
    // Spelled out rather than accumulated into an empty object: the compiler then
    // proves the record is complete, instead of a cast asserting it.
    windows: {
      m5: metricsFor("m5"),
      h1: metricsFor("h1"),
      h6: metricsFor("h6"),
      h24: metricsFor("h24"),
    },
    liquidityUsd,
    liquidityBaseTokens: liquidity ? finiteOrNull(liquidity.base) : null,
    liquidityQuoteTokens: liquidity ? finiteOrNull(liquidity.quote) : null,
    fdvUsd,
    marketCapUsd,
    marketCapEqualsFdv:
      fdvUsd === null || marketCapUsd === null ? null : fdvUsd === marketCapUsd,
    pairCreatedAtMs,
    pairAgeSeconds: ageSeconds(pairCreatedAtMs, asOfMs),
    activeBoostCount: isRecord(pair.boosts) ? finiteOrNull(pair.boosts.active) : null,
    priceUsdNumeric: priceForOrdering(pair.priceUsd),
    hasWebsite: info ? Array.isArray(info.websites) && info.websites.length > 0 : null,
    hasSocials: info ? Array.isArray(info.socials) && info.socials.length > 0 : null,
    socialPlatforms: socialPlatformsOf(info),
    imageUrl: info && typeof info.imageUrl === "string" ? info.imageUrl : null,
  };
}

/** A provider row paired with its derived numbers — the unit the pipeline moves. */
export interface PairRow {
  readonly pair: DexPair;
  readonly metrics: PairMetrics;
}
