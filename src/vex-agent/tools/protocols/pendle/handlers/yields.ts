/**
 * `pendle.yields` — market discovery across every Pendle chain.
 *
 * Backed by the READ shelf's DOCUMENTED cross-chain catalogue, in ONE call. The
 * per-chain fan-out this replaces cost 11 sequential requests and ~1,940 ms to
 * build a view a single 2-CU request returns, and applied its limit AFTER
 * merging — so an "all chains" call could return 50 rows from one chain and
 * present them as the best markets.
 *
 * Every narrowing is agent-controlled and echoed back in `filtersApplied`; there
 * is no hidden ceiling on `limit`. The old MAX_LIMIT=50 silently rewrote any
 * larger request with no echo, which is the owner's no-silent-truncation rule
 * broken in the plainest possible way.
 */

import { buildAssetMap } from "../market-lookup.js";
import { getPendleReadClient } from "@tools/pendle/read/client.js";
import type { PendleReadMarket } from "@tools/pendle/read/types.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import type { PendleAsset } from "@tools/pendle/types.js";
import { ok, fail } from "../../handler-helpers.js";
import { parsePendleYieldsParams, type PendleYieldsQuery } from "../read-params.js";
import { compareMarketRows, projectMarketRow, type ProjectedMarketRow } from "../projectors.js";
import { countBy, failureDetail, type FailedChain } from "./read-shared.js";

function matchesFilters(row: ProjectedMarketRow, q: PendleYieldsQuery, chainSlugs: Set<string> | null): boolean {
  if (chainSlugs !== null && !chainSlugs.has(row.chain)) return false;
  if (!q.includeMatured && row.matured) return false;

  const liquidity = row.liquidityUsd === null ? null : Number(row.liquidityUsd);
  if (q.minLiquidityUsd !== undefined && (liquidity === null || liquidity < q.minLiquidityUsd)) return false;
  if (q.maxLiquidityUsd !== undefined && (liquidity === null || liquidity > q.maxLiquidityUsd)) return false;

  const apy = row.impliedApyPercent === null ? null : Number(row.impliedApyPercent);
  if (q.minImpliedApyPercent !== undefined && (apy === null || apy < q.minImpliedApyPercent)) return false;
  if (q.maxImpliedApyPercent !== undefined && (apy === null || apy > q.maxImpliedApyPercent)) return false;

  const expiryMs = row.expiry === null ? null : Date.parse(row.expiry);
  if (q.expiryBeforeMs !== undefined && (expiryMs === null || expiryMs > q.expiryBeforeMs)) return false;
  if (q.expiryAfterMs !== undefined && (expiryMs === null || expiryMs < q.expiryAfterMs)) return false;
  if (q.minDaysToExpiry !== undefined && (row.daysToExpiry === null || row.daysToExpiry < q.minDaysToExpiry)) return false;
  if (q.maxDaysToExpiry !== undefined && (row.daysToExpiry === null || row.daysToExpiry > q.maxDaysToExpiry)) return false;

  if (q.underlyingSymbol !== undefined) {
    const symbol = row.underlying?.symbol?.toLowerCase() ?? "";
    const name = row.name?.toLowerCase() ?? "";
    if (!symbol.includes(q.underlyingSymbol) && !name.includes(q.underlyingSymbol)) return false;
  }
  if (q.categories !== undefined && !q.categories.some((c) => row.categories.includes(c))) return false;
  if (q.excludeCategories !== undefined && q.excludeCategories.some((c) => row.categories.includes(c))) return false;
  if (q.isNew !== undefined && row.isNew !== q.isNew) return false;
  if (q.isPrime !== undefined && row.isPrime !== q.isPrime) return false;
  return true;
}

/** Keep only the requested field groups. `undefined` keeps the whole row. */
function selectMarketFields(row: ProjectedMarketRow, fields: PendleYieldsQuery["fields"]): Record<string, unknown> {
  if (fields === undefined) return { ...row };
  const kept: Record<string, unknown> = { chain: row.chain, market: row.market };
  for (const field of fields) {
    switch (field) {
      case "identity":
        Object.assign(kept, { name: row.name, protocol: row.protocol, isNew: row.isNew, isPrime: row.isPrime });
        break;
      case "apy":
        Object.assign(kept, {
          impliedApyPercent: row.impliedApyPercent,
          underlyingApyPercent: row.underlyingApyPercent,
          pendleApyPercent: row.pendleApyPercent,
          aggregatedApyPercent: row.aggregatedApyPercent,
          maxBoostedApyPercent: row.maxBoostedApyPercent,
          ytFloatingApyPercent: row.ytFloatingApyPercent,
        });
        break;
      case "liquidity":
        Object.assign(kept, {
          liquidityUsd: row.liquidityUsd,
          tvlUsd: row.tvlUsd,
          volume24hUsd: row.volume24hUsd,
          swapFeeRateBps: row.swapFeeRateBps,
        });
        break;
      case "expiry":
        Object.assign(kept, { expiry: row.expiry, daysToExpiry: row.daysToExpiry, matured: row.matured });
        break;
      case "legs":
        Object.assign(kept, { pt: row.pt, yt: row.yt, sy: row.sy, underlying: row.underlying });
        break;
      case "points":
        Object.assign(kept, { categories: row.categories, points: row.points, pointsWarning: row.pointsWarning });
        break;
      case "protocols":
        Object.assign(kept, {
          externalProtocols: row.externalProtocols,
          externalProtocolsWarning: row.externalProtocolsWarning,
        });
        break;
    }
  }
  return kept;
}

/** Echo exactly which narrowings were applied, so the agent can widen them. */
function describeYieldFilters(q: PendleYieldsQuery): Record<string, unknown> {
  const applied: Record<string, unknown> = {
    includeMatured: q.includeMatured,
    sort: q.sort,
    order: q.order,
  };
  const optional: Array<[string, unknown]> = [
    ["chains", q.chainIds?.map((id) => pendleChainSlug(id) ?? String(id))],
    ["minLiquidityUsd", q.minLiquidityUsd],
    ["maxLiquidityUsd", q.maxLiquidityUsd],
    ["minImpliedApyPercent", q.minImpliedApyPercent],
    ["maxImpliedApyPercent", q.maxImpliedApyPercent],
    ["expiryBefore", q.expiryBeforeMs === undefined ? undefined : new Date(q.expiryBeforeMs).toISOString()],
    ["expiryAfter", q.expiryAfterMs === undefined ? undefined : new Date(q.expiryAfterMs).toISOString()],
    ["minDaysToExpiry", q.minDaysToExpiry],
    ["maxDaysToExpiry", q.maxDaysToExpiry],
    ["underlyingSymbol", q.underlyingSymbol],
    ["categories", q.categories],
    ["excludeCategories", q.excludeCategories],
    ["isNew", q.isNew],
    ["isPrime", q.isPrime],
    ["fields", q.fields],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) applied[key] = value;
  }
  return applied;
}

export async function pendleYields(p: Record<string, unknown>): Promise<ReturnType<typeof ok>> {
  const parsed = parsePendleYieldsParams(p);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const nowMs = Date.now();

  // ONE cross-chain catalogue read. `chainId` is deliberately not sent even when
  // the caller scoped `chains`: the endpoint takes a SINGLE id (a comma-separated
  // list is a documented 400), so a subset is one cross-chain walk filtered
  // locally — cheaper than a fan-out and free of the rank-per-chain-then-
  // concatenate bug that made the old merged view dishonest.
  let markets: readonly PendleReadMarket[];
  let catalogComplete: boolean;
  let catalogTotal: number;
  try {
    const catalog = await getPendleReadClient().listMarkets(q.includeMatured ? {} : { isActive: true });
    markets = catalog.markets;
    catalogComplete = catalog.complete;
    catalogTotal = catalog.total;
  } catch (err) {
    return fail(`Pendle markets unavailable (${failureDetail("pendle.yields", err)})`);
  }

  // Decimals come from the FROZEN per-chain asset catalogue, and only for the
  // chains actually present in the result. Without them every amount an agent
  // later builds against these legs would be a guess.
  const chainsPresent = [...new Set(markets.map((m) => m.chainId))];
  const assetMaps = new Map<number, Map<string, PendleAsset>>();
  const failedChains: FailedChain[] = [];
  for (const chainId of chainsPresent) {
    const slug = pendleChainSlug(chainId);
    if (slug === undefined) continue;
    try {
      assetMaps.set(chainId, await buildAssetMap(chainId));
    } catch (err) {
      failedChains.push({ chain: slug, reason: failureDetail("pendle.yields", err) });
    }
  }

  const rows: ProjectedMarketRow[] = [];
  const unsupportedChains = new Set<number>();
  for (const market of markets) {
    const slug = pendleChainSlug(market.chainId);
    if (slug === undefined) {
      // A chain Pendle lists that our registry does not carry. Counted and named
      // rather than dropped: the agent must know the view is narrower than the
      // provider's.
      unsupportedChains.add(market.chainId);
      continue;
    }
    rows.push(projectMarketRow(market, slug, assetMaps.get(market.chainId) ?? new Map(), nowMs));
  }

  const chainSlugs =
    q.chainIds === undefined
      ? null
      : new Set(q.chainIds.map((id) => pendleChainSlug(id)).filter((s): s is string => s !== undefined));

  const matched = rows.filter((row) => matchesFilters(row, q, chainSlugs));
  matched.sort(compareMarketRows(q.sort, q.order));
  const page = matched.slice(q.offset, q.offset + q.limit);
  const hasMore = q.offset + page.length < matched.length;
  const partial = !catalogComplete || failedChains.length > 0;

  return ok({
    summary:
      `${matched.length} Pendle market${matched.length === 1 ? "" : "s"} matched ` +
      `(${q.includeMatured ? "active and matured" : "active only"}), showing ${page.length} from offset ${q.offset}, ` +
      `sorted by ${q.sort} ${q.order}.` +
      (partial ? " PARTIAL — see failedChains / catalogComplete." : ""),
    asOf: new Date(nowMs).toISOString(),
    filtersApplied: describeYieldFilters(q),
    matched: matched.length,
    returned: page.length,
    offset: q.offset,
    limit: q.limit,
    hasMore,
    nextOffset: hasMore ? q.offset + page.length : null,
    partial,
    catalogComplete,
    catalogTotal,
    failedChains,
    unsupportedChains: [...unsupportedChains],
    chainCounts: Object.entries(countBy(matched, (row) => row.chain)).map(([chain, markets_]) => ({
      chain,
      markets: markets_,
    })),
    markets: page.map((row) => selectMarketFields(row, q.fields)),
    nextStep:
      "Preview a trade with pendle.pt.quote / pendle.yt.quote / pendle.lp.quote before any buy, sell or add. APY values are PERCENT (2.28 means 2.28%); an amount against any leg must use that leg's own `decimals`.",
  });
}
