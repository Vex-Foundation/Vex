/**
 * `morpho.markets.discover` - filtered, ranked Morpho Blue market screening.
 *
 * Filtering and ranking happen SERVER-SIDE. Every predicate this tool exposes is
 * a real `MarketFilters` input and every sort key a real `MarketOrderBy` member
 * (verified by live introspection, 2026-08-14), so the page Morpho returns is
 * already the right page. That is why `offset` maps straight onto `skip` and
 * `hasMore` is computed from Morpho's own `countTotal` rather than from rows we
 * happen to hold: a client-side filter over one page would rank within the page
 * and present the result as the best markets overall, which is the dishonest
 * ranking the Pendle lane had to fix.
 *
 * `listedOnly` defaults to TRUE and the reason is in the fixture. Morpho Blue is
 * permissionless: anyone can deploy a market, and the 2026-08-14 probe found
 * unlisted markets at the top of a net-supply-APY ranking reporting 297,995% APY
 * with 100% utilization, `oracle_unusable` and `sustained_low_liquidity` RED
 * warnings, and 0.04 USD actually supplied. An agent screening for yield without
 * that default finds those first, every time.
 */

import { getMorphoClient } from "@tools/morpho/client.js";
import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoMarketsParams } from "../read-params.js";
import {
  MORPHO_APY_DISCLAIMER,
  MORPHO_USD_DISCLAIMER,
  projectMarketRow,
  selectMarketFields,
} from "../projectors.js";
import { morphoFailureDetail } from "./shared.js";

export async function morphoMarketsDiscover(
  params: Record<string, unknown>,
  context?: { abortSignal?: AbortSignal },
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoMarketsParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  let page;
  try {
    page = await getMorphoClient().getMarketPage(
      { first: q.limit, skip: q.offset, orderBy: q.sort, order: q.order, where: q.filters },
      context?.abortSignal,
    );
  } catch (err) {
    return fail(`morpho.markets.discover failed ${morphoFailureDetail(err)}`);
  }

  const rows = page.markets.map(projectMarketRow);
  const returnedThrough = q.offset + rows.length;
  const hasMore = returnedThrough < page.countTotal;

  return ok({
    summary:
      `${page.countTotal} Morpho market${page.countTotal === 1 ? "" : "s"} matched `
      + `(${q.listedOnly ? "curated/listed only" : "INCLUDING permissionless unlisted markets"}), `
      + `showing ${rows.length} from offset ${q.offset}, sorted by ${q.sort} ${q.order}.`
      + (page.droppedRows > 0
        ? ` ${page.droppedRows} row(s) were dropped because their asset decimals or identity could not be read; `
          + "amounts on those markets would not have been safe to display."
        : ""),
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    matched: page.countTotal,
    returned: rows.length,
    offset: q.offset,
    limit: q.limit,
    hasMore,
    nextOffset: hasMore ? returnedThrough : null,
    droppedRows: page.droppedRows,
    markets: rows.map((row) => selectMarketFields(row, q.fields)),
    notes: {
      apy: MORPHO_APY_DISCLAIMER,
      usd: MORPHO_USD_DISCLAIMER,
      listed: q.listedOnly
        ? "Only markets Morpho curates are shown. Set listedOnly:false to also see permissionless markets, which can "
          + "carry unusable oracles and absurd headline APYs on near-zero deposits."
        : "UNLISTED markets are included. These are permissionless deployments: check every row's `warnings`, its "
          + "`oracle`, and the SIZE of `supply` before believing an APY figure.",
      liquidity:
        "`liquidity.available` is borrowable now; `liquidity.reallocatable` is what a Public Allocator reallocation "
        + "could add and is not committed.",
    },
    nextStep:
      "Read one market in full with morpho.market.get (it needs both `marketId` and `chain`) before acting on it - "
      + "that call adds bad debt, the oracle price liquidations use, and the vaults supplying the market.",
  });
}
