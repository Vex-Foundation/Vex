/**
 * Projections — raw Indexify rows to agent-sized rows.
 *
 * One raw stack row measured ~3.6 KB (every row embeds full token objects with
 * categories arrays and CDN URLs). The projections here keep what an agent
 * acts on — identity, price, performance, composition — and drop the rest, so
 * a 10-row browse stays ~2 KB instead of ~36 KB.
 */

import type { IndexifyStack } from "@tools/indexify/types.js";
import { indexifyStackUrl } from "@tools/indexify/constants.js";

/** Compact browse/search row. */
export interface ProjectedStackRow {
  stackId: number;
  slug: string;
  name: string;
  category: string | null;
  priceUsd: number | null;
  change1D: number | null;
  change1W: number | null;
  changeAll: number | null;
  weightedMarketCapUsd: number | null;
  creatorFeePercent: number | null;
  creator: string | null;
  tokenCount: number;
  topTokenSymbols: readonly string[];
  isOfficial: boolean;
  isClosed: boolean;
}

/** How many token symbols a browse row carries. */
const TOP_SYMBOLS = 5;

export function projectStackRow(row: IndexifyStack): ProjectedStackRow {
  const tokens = row.tokens ?? [];
  return {
    stackId: row.id,
    slug: row.slug,
    name: row.stack_name,
    category: row.category ?? null,
    // Every stack is indexed from $1.00 at inception, so price doubles as
    // lifetime performance — worth carrying on every row.
    priceUsd: row.price ?? null,
    change1D: row.change1D ?? null,
    change1W: row.change1W ?? null,
    changeAll: row.changeAll ?? null,
    weightedMarketCapUsd: row.weighted_market_cap ?? null,
    creatorFeePercent: row.creator_fee ?? null,
    creator: row.user?.username ?? null,
    tokenCount: tokens.length,
    topTokenSymbols: tokens.slice(0, TOP_SYMBOLS).map((t) => t.symbol),
    isOfficial: row.is_company_stack === true || row.is_verified === true,
    isClosed: row.is_closed === true || row.archived === true,
  };
}

/** One allocation inside the full stack detail. */
export interface ProjectedAllocation {
  symbol: string;
  name: string;
  mintAddress: string;
  weightPercent: number | null;
  priceUsd: number | null;
}

/** Full single-stack detail. */
export interface ProjectedStackDetail extends ProjectedStackRow {
  description: string | null;
  url: string;
  tvlUsd: number | null;
  change4H: number | null;
  change1M: number | null;
  marketVolume24hUsd: number | null;
  allocationVersion: number | null;
  createdAt: number | null;
  allocations: readonly ProjectedAllocation[];
}

export function projectStackDetail(row: IndexifyStack): ProjectedStackDetail {
  const tokens = row.tokens ?? [];
  const weights = row.token_weights ?? [];
  return {
    ...projectStackRow(row),
    description: row.description ?? null,
    url: indexifyStackUrl(row.slug),
    tvlUsd: row.tvl ?? null,
    change4H: row.change4H ?? null,
    change1M: row.change1M ?? null,
    marketVolume24hUsd: row.market_volume_24h ?? null,
    allocationVersion: row.current_allocation_version ?? null,
    createdAt: row.time_p ?? null,
    allocations: tokens.map((token, index) => {
      // `token_weights` is a PARALLEL array of integer-percent strings; a
      // missing or malformed entry projects to null, never to a guessed 0.
      const rawWeight = weights[index];
      const weight = rawWeight === undefined ? Number.NaN : Number.parseFloat(rawWeight);
      return {
        symbol: token.symbol,
        name: token.name,
        mintAddress: token.address,
        weightPercent: Number.isFinite(weight) ? weight : null,
        priceUsd: token.price ?? null,
      };
    }),
  };
}
