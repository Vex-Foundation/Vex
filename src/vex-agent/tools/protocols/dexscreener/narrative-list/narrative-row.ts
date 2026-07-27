/**
 * `AgentDexNarrative` — one row of the DexScreener trending-NARRATIVES feed.
 *
 * A narrative (DexScreener calls it a "meta") is a theme: `cat`, `ai`, `dog`,
 * `knockoff-legends`. The feed is the only market-wide rotation signal this API
 * offers, and it returns THEMES, never tokens.
 *
 * THE ORDER IS UNDISCLOSED AND MUST NEVER BE CALLED A RANKING
 *
 * Nine candidate sorts — market cap, liquidity, volume, token count, and each of
 * the four market-cap change windows, ascending and descending — were tested
 * against the live feed and none reproduces its order. So `providerOrder` is
 * `"unspecified"`, position carries no meaning, and the honest sentence rides in
 * the envelope note. An agent told "ranked by market cap" would read row 1 as the
 * leading narrative, which is a claim nobody can support.
 *
 * THE AGGREGATES ARE INTERNALLY INCONSISTENT, AND THAT IS THE PROVIDER'S DOING
 *
 * Measured on `/metas/meta/v1/cat`, 2026-07-27: `marketCap` is EXACTLY
 * `sum(pairs[].marketCap)` (224,446,681 both sides, to the last digit), while
 * `liquidity` (23,354,089.77) and `volume` (1,706,297.56) are NOT sums over the
 * same pairs (21,774,508.92 and 1,463,001.72). And the detail endpoint's
 * `tokenCount` equalled `pairs.length` exactly (31 = 31) while the TRENDING feed
 * reported 67 tokens for the same slug on the same minute.
 *
 * Those three facts are why the detail output renames things: a field that is the
 * sum of the 31 pools we were sent must not be readable as the market cap of a
 * 67-token narrative. `../narrative-list/narrative-pipeline.ts` names the
 * renames; this module owns the feed row.
 *
 * UNITS ARE IN THE NAMES because the provider's are not: raw `marketCap`,
 * `liquidity`, `volume` and a `marketCapChange` map whose values are already
 * percentages sitting beside a `marketCapDelta` map whose values are absolute USD.
 * Two maps, same shape, different units, neither named.
 */

import type { DexMeta, DexMetaWindows } from "@tools/dexscreener/types.js";

import { stripStructuralCharacters } from "../list-core/index.js";

import type { NarrativeFieldSelection } from "./narrative-fields.js";
import type { NarrativeWindow } from "./narrative-query.js";

export interface AgentDexNarrative {
  /** The identifier to pass back to `dexscreener.meta`. */
  slug: string | null;
  /** DexScreener's editorial display name — third-party free text. */
  name?: string | null;
  /** The emoji DexScreener attaches, when the icon is an emoji rather than a URL. */
  iconEmoji?: string | null;
  /**
   * Tokens DexScreener counts in this narrative. This is the narrative-level
   * truth; `dexscreener.meta` returns a SUBSET of them and counts it separately.
   */
  narrativeTokenCount: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsdH24: number | null;
  /** Already a percent (`-3.07` = −3.07 %) in the selected `window`. */
  marketCapChangePctSelected: number | null;

  // Opt-in via `fields`.
  description?: string | null;
  marketCapChangePctM5?: number | null;
  marketCapChangePctH1?: number | null;
  marketCapChangePctH6?: number | null;
  marketCapChangePctH24?: number | null;
  /** Absolute USD move, NOT a percent — the provider's second unnamed map. */
  marketCapDeltaUsdM5?: number | null;
  marketCapDeltaUsdH1?: number | null;
  marketCapDeltaUsdH6?: number | null;
  marketCapDeltaUsdH24?: number | null;
}

/** Derived numbers, so a filter and a sort read the same value. */
export interface NarrativeMetrics {
  readonly marketCapUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly volumeUsdH24: number | null;
  readonly narrativeTokenCount: number | null;
  readonly marketCapChangePct: Readonly<Record<NarrativeWindow, number | null>>;
}

export interface NarrativeRow {
  readonly meta: DexMeta;
  readonly metrics: NarrativeMetrics;
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function windowValue(windows: DexMetaWindows | null, window: NarrativeWindow): number | null {
  if (windows === null) return null;
  return finiteOrNull(windows[window]);
}

export function computeNarrativeMetrics(meta: DexMeta): NarrativeMetrics {
  return {
    marketCapUsd: finiteOrNull(meta.marketCap),
    liquidityUsd: finiteOrNull(meta.liquidity),
    volumeUsdH24: finiteOrNull(meta.volume),
    narrativeTokenCount: finiteOrNull(meta.tokenCount),
    marketCapChangePct: {
      m5: windowValue(meta.marketCapChange, "m5"),
      h1: windowValue(meta.marketCapChange, "h1"),
      h6: windowValue(meta.marketCapChange, "h6"),
      h24: windowValue(meta.marketCapChange, "h24"),
    },
  };
}

export function toNarrativeRows(metas: readonly DexMeta[]): NarrativeRow[] {
  return metas.map((meta) => ({ meta, metrics: computeNarrativeMetrics(meta) }));
}

/**
 * DexScreener sends `icon` as `{type, value}`; the live `cat` narrative is
 * `{type:"emoji", value:"🐈"}`. A non-emoji type is NOT emitted as an emoji — a
 * URL rendered into an `iconEmoji` field would be a lie about what the value is.
 */
function iconEmojiOf(meta: DexMeta): string | null {
  if (meta.icon === null || meta.icon.type !== "emoji") return null;
  return stripStructuralCharacters(meta.icon.value);
}

export function projectAgentNarrative(
  row: NarrativeRow,
  fields: NarrativeFieldSelection,
  window: NarrativeWindow,
): AgentDexNarrative {
  const { meta, metrics } = row;
  const projected: AgentDexNarrative = {
    slug: meta.slug,
    narrativeTokenCount: metrics.narrativeTokenCount,
    marketCapUsd: metrics.marketCapUsd,
    liquidityUsd: metrics.liquidityUsd,
    volumeUsdH24: metrics.volumeUsdH24,
    marketCapChangePctSelected: metrics.marketCapChangePct[window],
  };

  if (fields.has("name")) projected.name = stripStructuralCharacters(meta.name);
  if (fields.has("iconEmoji")) projected.iconEmoji = iconEmojiOf(meta);
  if (fields.has("description")) {
    projected.description = stripStructuralCharacters(meta.description);
  }

  if (fields.has("marketCapChangePctM5")) {
    projected.marketCapChangePctM5 = metrics.marketCapChangePct.m5;
  }
  if (fields.has("marketCapChangePctH1")) {
    projected.marketCapChangePctH1 = metrics.marketCapChangePct.h1;
  }
  if (fields.has("marketCapChangePctH6")) {
    projected.marketCapChangePctH6 = metrics.marketCapChangePct.h6;
  }
  if (fields.has("marketCapChangePctH24")) {
    projected.marketCapChangePctH24 = metrics.marketCapChangePct.h24;
  }
  if (fields.has("marketCapDeltaUsdM5")) {
    projected.marketCapDeltaUsdM5 = windowValue(meta.marketCapDelta, "m5");
  }
  if (fields.has("marketCapDeltaUsdH1")) {
    projected.marketCapDeltaUsdH1 = windowValue(meta.marketCapDelta, "h1");
  }
  if (fields.has("marketCapDeltaUsdH6")) {
    projected.marketCapDeltaUsdH6 = windowValue(meta.marketCapDelta, "h6");
  }
  if (fields.has("marketCapDeltaUsdH24")) {
    projected.marketCapDeltaUsdH24 = windowValue(meta.marketCapDelta, "h24");
  }

  return projected;
}
