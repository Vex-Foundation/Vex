/**
 * `AgentDexPair` — the one pair row every DexScreener market tool emits.
 *
 * Replaces the previous `ConciseDexPair` for `search` / `pairs` / `tokens` /
 * `tokenPairs`. Four differences carry the weight:
 *
 * - **Names carry units.** `liquidityUsd`, `volumeUsdSelected`,
 *   `priceChangePctSelected`, `pairAgeSeconds`, `turnoverRatioH24`,
 *   `liquidityQuoteTokens`. The predecessor emitted `pairCreatedAt` (a bare ms
 *   epoch), `priceNative` (which reads as "the chain's gas token" and is not),
 *   `fdv` and `marketCap` — four numbers whose unit the agent had to guess.
 * - **`priceUsd` stays an exact-decimal string.** It is never float-parsed on
 *   the way to the agent.
 * - **`turnoverRatioH24` is computed by us** and emitted on every row. It is the
 *   cheapest defence this API affords against fabricated depth.
 * - **`liquidityBaseTokens` / `liquidityQuoteTokens` exist.** The predecessor
 *   parsed both and then deleted them, leaving the agent unable to see that 13
 *   of 30 rows in one search reported >$1 M of USD liquidity while holding fewer
 *   than 1,000 quote-token units.
 *
 * `decimalsAvailable: false` is a constant rather than an omission because
 * `rules/90-vex-project.md` requires a raw amount to travel with the decimals
 * needed to read it, and DexScreener publishes no token decimals at all. The
 * envelope names the resolver to use instead.
 */

import type { DexPair } from "@tools/dexscreener/types.js";

import { stripStructuralCharacters } from "../list-core/index.js";

import type { PairFieldSelection } from "./agent-pair-fields.js";
import type { PairRow, PairWindow } from "./pair-metrics.js";
import type { PriceSanityVerdict } from "./price-sanity.js";

export interface AgentDexPair {
  // ── Lean set — always emitted ──────────────────────────────────
  chainId: string;
  dexId: string;
  pairAddress: string | null;
  baseAddress: string | null;
  baseSymbol: string | null;
  quoteSymbol: string | null;
  /** USD per 1 base token, exact decimal. Never float-parse for money. */
  priceUsd: string | null;
  /** A hint, not a floor — see `turnoverRatioH24` and `liquidityQuoteTokens`. */
  liquidityUsd: number | null;
  /** USD traded in the window named by `filtersApplied.window`. */
  volumeUsdSelected: number | null;
  /** Already a percent (`1.08` = +1.08 %) in the selected window. */
  priceChangePctSelected: number | null;
  /** volumeUsdH24 ÷ liquidityUsd, computed by Vex. `null` if either is null. */
  turnoverRatioH24: number | null;
  pairAgeSeconds: number | null;
  /** `null` means the provider sent no labels — NOT "unknown". */
  labels: string[] | null;

  // ── Rich set — opt in via `fields` / `includeAllWindows` ───────
  baseName?: string | null;
  quoteAddress?: string | null;
  quoteName?: string | null;
  /** Price denominated in the QUOTE token (renames the provider's `priceNative`). */
  priceInQuoteToken?: string | null;
  liquidityBaseTokens?: number | null;
  liquidityQuoteTokens?: number | null;
  fdvUsd?: number | null;
  marketCapUsd?: number | null;
  /** `true` = circulating supply unknown, not "no dilution". `null` = cannot say. */
  marketCapEqualsFdv?: boolean | null;
  pairCreatedAtMs?: number | null;
  activeBoostCount?: number | null;
  hasWebsite?: boolean | null;
  hasSocials?: boolean | null;
  socialPlatforms?: string[] | null;
  imageUrl?: string | null;
  dexScreenerUrl?: string | null;
  /** Always `false`: DexScreener publishes no token decimals. */
  decimalsAvailable?: false;

  volumeUsdM5?: number | null;
  volumeUsdH1?: number | null;
  volumeUsdH6?: number | null;
  volumeUsdH24?: number | null;
  priceChangePctM5?: number | null;
  priceChangePctH1?: number | null;
  priceChangePctH6?: number | null;
  priceChangePctH24?: number | null;
  txnBuyCountM5?: number | null;
  txnBuyCountH1?: number | null;
  txnBuyCountH6?: number | null;
  txnBuyCountH24?: number | null;
  txnSellCountM5?: number | null;
  txnSellCountH1?: number | null;
  txnSellCountH6?: number | null;
  txnSellCountH24?: number | null;
  buySellRatioM5?: number | null;
  buySellRatioH1?: number | null;
  buySellRatioH6?: number | null;
  buySellRatioH24?: number | null;
  turnoverRatioM5?: number | null;
  turnoverRatioH1?: number | null;
  turnoverRatioH6?: number | null;

  /** Cross-pool price verdict. Emitted only by `dexscreener.tokenPairs`. */
  priceSanity?: PriceSanityVerdict;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Issuer-authored display text: kept in full, stripped of structural characters. */
function displayText(value: unknown): string | null {
  return stripStructuralCharacters(strOrNull(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tokenField(token: unknown, key: "address" | "name" | "symbol"): unknown {
  return isRecord(token) ? token[key] : undefined;
}

export interface ProjectAgentPairOptions {
  readonly fields: PairFieldSelection;
  /** Which window feeds `*Selected`. */
  readonly window: PairWindow;
  readonly priceSanity?: PriceSanityVerdict | null;
}

/**
 * Project one provider row + its derived metrics into the agent-facing row.
 *
 * Every rich field is assigned explicitly rather than through a computed key, so
 * "where is `volumeUsdH24` emitted?" has exactly one grep answer and the field
 * vocabulary in `./agent-pair-fields.ts` can be asserted against what this
 * function actually produces.
 */
export function projectAgentPair(row: PairRow, options: ProjectAgentPairOptions): AgentDexPair {
  const { pair, metrics } = row;
  const { fields, window } = options;
  const selected = metrics.windows[window];

  const projected: AgentDexPair = {
    chainId: typeof pair.chainId === "string" ? pair.chainId : "",
    dexId: typeof pair.dexId === "string" ? pair.dexId : "",
    pairAddress: strOrNull(pair.pairAddress),
    baseAddress: strOrNull(tokenField(pair.baseToken, "address")),
    baseSymbol: displayText(tokenField(pair.baseToken, "symbol")),
    quoteSymbol: displayText(tokenField(pair.quoteToken, "symbol")),
    priceUsd: strOrNull(pair.priceUsd),
    liquidityUsd: metrics.liquidityUsd,
    volumeUsdSelected: selected.volumeUsd,
    priceChangePctSelected: selected.priceChangePct,
    turnoverRatioH24: metrics.windows.h24.turnoverRatio,
    pairAgeSeconds: metrics.pairAgeSeconds,
    labels: Array.isArray(pair.labels) ? pair.labels : null,
  };

  if (fields.has("baseName")) projected.baseName = displayText(tokenField(pair.baseToken, "name"));
  if (fields.has("quoteAddress")) {
    projected.quoteAddress = strOrNull(tokenField(pair.quoteToken, "address"));
  }
  if (fields.has("quoteName")) {
    projected.quoteName = displayText(tokenField(pair.quoteToken, "name"));
  }
  if (fields.has("priceInQuoteToken")) projected.priceInQuoteToken = strOrNull(pair.priceNative);
  if (fields.has("liquidityBaseTokens")) {
    projected.liquidityBaseTokens = metrics.liquidityBaseTokens;
  }
  if (fields.has("liquidityQuoteTokens")) {
    projected.liquidityQuoteTokens = metrics.liquidityQuoteTokens;
  }
  if (fields.has("fdvUsd")) projected.fdvUsd = metrics.fdvUsd;
  if (fields.has("marketCapUsd")) projected.marketCapUsd = metrics.marketCapUsd;
  if (fields.has("marketCapEqualsFdv")) projected.marketCapEqualsFdv = metrics.marketCapEqualsFdv;
  if (fields.has("pairCreatedAtMs")) projected.pairCreatedAtMs = metrics.pairCreatedAtMs;
  if (fields.has("activeBoostCount")) projected.activeBoostCount = metrics.activeBoostCount;
  if (fields.has("hasWebsite")) projected.hasWebsite = metrics.hasWebsite;
  if (fields.has("hasSocials")) projected.hasSocials = metrics.hasSocials;
  if (fields.has("socialPlatforms")) {
    projected.socialPlatforms =
      metrics.socialPlatforms === null
        ? null
        : metrics.socialPlatforms.map((platform) => stripStructuralCharacters(platform));
  }
  if (fields.has("imageUrl")) projected.imageUrl = metrics.imageUrl;
  if (fields.has("dexScreenerUrl")) projected.dexScreenerUrl = strOrNull(pair.url);
  if (fields.has("decimalsAvailable")) projected.decimalsAvailable = false;

  if (fields.has("volumeUsdM5")) projected.volumeUsdM5 = metrics.windows.m5.volumeUsd;
  if (fields.has("volumeUsdH1")) projected.volumeUsdH1 = metrics.windows.h1.volumeUsd;
  if (fields.has("volumeUsdH6")) projected.volumeUsdH6 = metrics.windows.h6.volumeUsd;
  if (fields.has("volumeUsdH24")) projected.volumeUsdH24 = metrics.windows.h24.volumeUsd;
  if (fields.has("priceChangePctM5")) projected.priceChangePctM5 = metrics.windows.m5.priceChangePct;
  if (fields.has("priceChangePctH1")) projected.priceChangePctH1 = metrics.windows.h1.priceChangePct;
  if (fields.has("priceChangePctH6")) projected.priceChangePctH6 = metrics.windows.h6.priceChangePct;
  if (fields.has("priceChangePctH24")) {
    projected.priceChangePctH24 = metrics.windows.h24.priceChangePct;
  }
  if (fields.has("txnBuyCountM5")) projected.txnBuyCountM5 = metrics.windows.m5.txnBuyCount;
  if (fields.has("txnBuyCountH1")) projected.txnBuyCountH1 = metrics.windows.h1.txnBuyCount;
  if (fields.has("txnBuyCountH6")) projected.txnBuyCountH6 = metrics.windows.h6.txnBuyCount;
  if (fields.has("txnBuyCountH24")) projected.txnBuyCountH24 = metrics.windows.h24.txnBuyCount;
  if (fields.has("txnSellCountM5")) projected.txnSellCountM5 = metrics.windows.m5.txnSellCount;
  if (fields.has("txnSellCountH1")) projected.txnSellCountH1 = metrics.windows.h1.txnSellCount;
  if (fields.has("txnSellCountH6")) projected.txnSellCountH6 = metrics.windows.h6.txnSellCount;
  if (fields.has("txnSellCountH24")) projected.txnSellCountH24 = metrics.windows.h24.txnSellCount;
  if (fields.has("buySellRatioM5")) projected.buySellRatioM5 = metrics.windows.m5.buySellRatio;
  if (fields.has("buySellRatioH1")) projected.buySellRatioH1 = metrics.windows.h1.buySellRatio;
  if (fields.has("buySellRatioH6")) projected.buySellRatioH6 = metrics.windows.h6.buySellRatio;
  if (fields.has("buySellRatioH24")) projected.buySellRatioH24 = metrics.windows.h24.buySellRatio;
  if (fields.has("turnoverRatioM5")) projected.turnoverRatioM5 = metrics.windows.m5.turnoverRatio;
  if (fields.has("turnoverRatioH1")) projected.turnoverRatioH1 = metrics.windows.h1.turnoverRatio;
  if (fields.has("turnoverRatioH6")) projected.turnoverRatioH6 = metrics.windows.h6.turnoverRatio;

  if (options.priceSanity) projected.priceSanity = options.priceSanity;

  return projected;
}
