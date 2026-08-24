/**
 * `morpho.vaults.discover` - filtered, ranked Morpho vault screening across both
 * vault generations.
 *
 * THE MERGE IS THE INTERESTING PART, so it is described here and repeated in the
 * tool's own description rather than left implicit.
 *
 * Morpho serves V1 (MetaMorpho) vaults and V2 vaults through two SEPARATE
 * queries. Filtering and ranking are server-side within each, so a single-version
 * call is a plain page: `offset` maps onto `skip`, `hasMore` comes from Morpho's
 * own `countTotal`, and nothing is reordered locally.
 *
 * At `version: both` this handler fetches the first `offset + limit` rows from
 * EACH generation under the same sort key and direction, merges them, re-sorts
 * the union locally, and returns the requested window. That produces the EXACT
 * global ranking rather than an approximation, and the reason is the standard
 * merge property: each source is already sorted, so the true top N of the union
 * cannot contain a row that was outside its own source's top N. The cost is that
 * the window has to fit inside one page, which is why `offset + limit` above the
 * page ceiling is refused by name at the param boundary instead of being served
 * as a merge that could silently miss rows.
 *
 * `matched` is the SUM of both generations' `countTotal`, which is exact. The
 * alternative shape - rank each source separately and interleave the pages - was
 * rejected: it presents a ranking that is true within each half and false across
 * them, which is precisely the dishonest ordering rules/90 forbids.
 *
 * `listedOnly` defaults to TRUE. The 2026-08-14 probe is the reason and it is
 * concrete: reading `vaults` with no explicit ordering put a vault literally
 * named `tstcntrct` in second position, alongside another named `Test`, both
 * unlisted and holding roughly ten dollars between them. An agent screening for
 * a place to deposit without that default meets somebody's deploy test first.
 */

import { getMorphoClient } from "@tools/morpho/client.js";
import type { MorphoVault } from "@tools/morpho/types.js";
import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoVaultsParams } from "../read-params.js";
// The route comparison is imported from its own module rather than through
// `../read-params.js` / `../projectors.js`: those two barrels are the public
// entry points and are being edited concurrently, so this lane keeps its own
// import direct. Promote both to the barrels once the concurrent work lands.
import type { MorphoVaultsDiscoverQuery } from "../read-params/vaults.js";
import {
  MORPHO_USD_DISCLAIMER,
  MORPHO_VAULT_APY_DISCLAIMER,
  MORPHO_VAULT_CURATOR_NOTE,
  MORPHO_VAULT_GATING_NOTE,
  projectMarketRow,
  projectVaultRow,
  selectVaultFields,
} from "../projectors.js";
import {
  MORPHO_ROUTE_COMPARISON_NOTE,
  curatedRouteOption,
  directRouteOption,
  rankRouteOptions,
  type MorphoCallableNames,
  type MorphoRouteOption,
} from "../projectors/vault-routes.js";
import { MORPHO_TOOLS } from "../manifest.js";
import { morphoFailureDetail } from "./shared.js";

/**
 * The `toolId -> publicName` projection for the tools this namespace ships, so
 * a routing pointer can emit a CALLABLE name and can say `available: false`
 * instead of naming a tool that does not resolve. Built from the namespace
 * manifest, which is the same source the catalog registers, so the pointer can
 * never name a tool this build does not carry.
 */
const MORPHO_CALLABLE_NAMES: MorphoCallableNames = new Map(
  MORPHO_TOOLS.map((tool) => [tool.toolId, tool.publicName]),
);

/** The value the merged ranking compares. `name` is V1-only and never merged. */
function sortValue(vault: MorphoVault, sort: string): number | null {
  if (sort === "tvlUsd") return vault.totalAssets.usd;
  if (sort === "netApy") return vault.apy.netApy;
  if (sort === "apy") return vault.apy.apy;
  return null;
}

/**
 * Re-sort the union. A row whose sort field is null goes LAST in both
 * directions: an absent APY is not a low APY, and floating it to the top of an
 * ascending sort would present "we do not know" as "cheapest".
 */
function mergeSorted(vaults: MorphoVault[], sort: string, order: "asc" | "desc"): MorphoVault[] {
  const direction = order === "asc" ? 1 : -1;
  return [...vaults].sort((a, b) => {
    const left = sortValue(a, sort);
    const right = sortValue(b, sort);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * direction;
  });
}

/**
 * The direct-supply side of the comparison: the Blue markets whose LOAN asset is
 * the asset the vaults hold, ranked by the same thing a depositor cares about.
 *
 * This reuses `getMarketPage` rather than adding a second markets query. The
 * predicate Morpho already serves - `loanAssetAddress_in` - is exactly the
 * relationship being asked about: a vault holding USDC earns its yield by
 * lending USDC, and the alternative to handing that USDC to a curator is
 * supplying one of those same markets directly.
 */
async function fetchDirectOptions(
  direct: NonNullable<MorphoVaultsDiscoverQuery["direct"]>,
  q: MorphoVaultsDiscoverQuery,
  signal: AbortSignal | undefined,
): Promise<{ options: MorphoRouteOption[]; matched: number; dropped: number }> {
  const page = await getMorphoClient().getMarketPage(
    {
      first: q.limit,
      skip: 0,
      orderBy: "netSupplyApy",
      order: "desc",
      where: {
        listed: q.listedOnly,
        loanAssetAddress_in: [direct.assetAddress],
        ...(direct.chainIds ? { chainId_in: direct.chainIds } : {}),
      },
    },
    signal,
  );
  return {
    options: page.markets.map((market) => directRouteOption(projectMarketRow(market), MORPHO_CALLABLE_NAMES)),
    matched: page.countTotal,
    dropped: page.droppedRows,
  };
}

/** The notes every route that returns direct options carries. */
const DIRECT_ROUTE_NOTES = {
  comparison: MORPHO_ROUTE_COMPARISON_NOTE,
  routing:
    "Every option names the tool it is acted on with under `routing`, as a callable `publicName` plus the params "
    + "that tool already knows. Emit that `publicName` verbatim. Check `routing.execute.available` before calling "
    + "it: false means this build does not ship that tool, and `publicName` is then null.",
  concentration:
    "A direct supply concentrates the whole position in ONE market: one collateral asset, one oracle and one LLTV, "
    + "with no curator able to reallocate out of it. A vault spreads the same deposit across several markets and can "
    + "move it, and charges a fee for doing so. Neither is safer in the abstract.",
};

export async function morphoVaultsDiscover(
  params: Record<string, unknown>,
  context?: { abortSignal?: AbortSignal },
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoVaultsParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const merged = q.versions.length > 1;
  const client = getMorphoClient();

  let direct: { options: MorphoRouteOption[]; matched: number; dropped: number } | null = null;
  if (q.direct !== null) {
    try {
      direct = await fetchDirectOptions(q.direct, q, context?.abortSignal);
    } catch (err) {
      return fail(`morpho__vaults_discover failed reading the direct-supply markets ${morphoFailureDetail(err)}`);
    }
  }

  if (q.route === "direct" && direct !== null) {
    const ranked = rankRouteOptions(direct.options);
    return ok({
      summary:
        `${direct.matched} Morpho market${direct.matched === 1 ? "" : "s"} lend the requested asset directly `
        + `(${q.listedOnly ? "curated/listed only" : "INCLUDING permissionless unlisted markets"}), showing `
        + `${ranked.options.length}, ranked by net supply APY. No curated vault was queried at route "direct".`,
      asOf: new Date().toISOString(),
      filtersApplied: q.echo,
      route: q.route,
      matched: direct.matched,
      returned: ranked.options.length,
      droppedRows: direct.dropped,
      bestDirectNetApyPercent: ranked.bestDirectNetApyPercent,
      options: ranked.options,
      notes: { ...DIRECT_ROUTE_NOTES, usd: MORPHO_USD_DISCLAIMER },
      nextStep:
        "Read one market in full with morpho__market_get (it needs both `marketId` and `chain`) before supplying - "
        + "that call adds bad debt, the oracle price liquidations are decided against, and the vaults already "
        + "supplying it. Then follow the option's own `routing`. Set `route: \"both\"` to see the curated vaults "
        + "holding the same asset beside these markets.",
    });
  }

  let vaults: MorphoVault[] = [];
  let matched = 0;
  let dropped = 0;
  try {
    for (const version of q.versions) {
      const page = await client.getVaultPage(
        version,
        {
          // A merge needs the whole window from each source; a single-version
          // read pages server-side and asks only for what it will return.
          first: merged ? q.offset + q.limit : q.limit,
          skip: merged ? 0 : q.offset,
          orderBy: q.sort,
          order: q.order,
          where: version === "v1" ? q.v1Filters : q.v2Filters,
        },
        context?.abortSignal,
      );
      vaults = vaults.concat(page.vaults);
      matched += page.countTotal;
      dropped += page.droppedRows;
    }
  } catch (err) {
    return fail(`morpho__vaults_discover failed ${morphoFailureDetail(err)}`);
  }

  const window = merged ? mergeSorted(vaults, q.sort, q.order).slice(q.offset, q.offset + q.limit) : vaults;
  const rows = window.map(projectVaultRow);
  const returnedThrough = q.offset + rows.length;
  const hasMore = returnedThrough < matched;
  const gatedCount = rows.filter((row) => row.gating !== null && row.gating["gated"] === true).length;

  // At `route: "both"` the curated rows become options beside the direct ones
  // and the whole union is ranked on the one comparable rate. At the default
  // route this block is absent entirely, so an existing caller sees the exact
  // reply it saw before the route existed.
  const comparison =
    direct === null
      ? null
      : rankRouteOptions([...rows.map((row) => curatedRouteOption(row, MORPHO_CALLABLE_NAMES)), ...direct.options]);

  return ok({
    summary:
      `${matched} Morpho vault${matched === 1 ? "" : "s"} matched `
      + `(${q.listedOnly ? "curated/listed only" : "INCLUDING unlisted, uncurated vaults"}, `
      + `version ${q.versionSelector}), showing ${rows.length} from offset ${q.offset}, sorted by ${q.sort} ${q.order}.`
      + (gatedCount > 0
        ? ` ${gatedCount} of the returned vault(s) are GATED: a gate contract can refuse a deposit or a withdrawal.`
        : "")
      + (dropped > 0
        ? ` ${dropped} row(s) were dropped because their asset decimals or identity could not be read; `
          + "amounts on those vaults would not have been safe to display."
        : ""),
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    matched,
    returned: rows.length,
    offset: q.offset,
    limit: q.limit,
    hasMore,
    nextOffset: hasMore ? returnedThrough : null,
    droppedRows: dropped,
    vaults: rows.map((row) => selectVaultFields(row, q.fields)),
    ...(comparison === null || direct === null
      ? {}
      : {
          route: q.route,
          directMarketsMatched: direct.matched,
          bestDirectNetApyPercent: comparison.bestDirectNetApyPercent,
          options: comparison.options,
        }),
    ranking: merged
      ? "Both vault generations were queried, the top (offset + limit) rows were taken from EACH under this sort key, "
        + "then merged and re-sorted together. The ordering across the two generations is therefore exact for this "
        + "window, and `matched` is the sum of both generations' totals. Paging further than one page needs `version` "
        + "set to a single generation."
      : `Only Morpho ${q.versionSelector.toUpperCase()} vaults were queried; Morpho ranked and paged them server-side `
        + "over ALL matches, not just the returned page.",
    notes: {
      apy: MORPHO_VAULT_APY_DISCLAIMER,
      usd: MORPHO_USD_DISCLAIMER,
      curator: MORPHO_VAULT_CURATOR_NOTE,
      gating: MORPHO_VAULT_GATING_NOTE,
      versions:
        "V1 (MetaMorpho) vaults have one global timelock and no gating, so `timelockSeconds` is populated and "
        + "`gating` is null. V2 vaults have a per-function timelock table instead, so `timelockSeconds` is null and "
        + "the per-function durations are on morpho__vault_get; only V2 vaults can be gated.",
      listed: q.listedOnly
        ? "Only vaults Morpho curates are shown. Set listedOnly:false to also see uncurated deployments - Morpho's "
          + "own unordered vault list surfaces deploy tests holding a few dollars before it surfaces real vaults."
        : "UNLISTED vaults are included. Anyone can deploy one, including as a test: check every row's `warnings`, "
          + "its `tvl`, and who the `curators` are before believing a rate.",
      ...(direct === null ? {} : DIRECT_ROUTE_NOTES),
    },
    nextStep:
      "Read one vault in full with morpho__vault_get (it needs both `vaultAddress` and `chain`) before depositing - "
      + "that call adds the role and timelock configuration, the per-market allocations with their caps, and the "
      + "queued governance changes. Depositing goes through morpho__vault_quote and then morpho__vault_deposit, "
      + "never straight from a discover row."
      + (direct === null
        ? ""
        : " Each entry in `options` carries its OWN `routing`: a curated option is acted on with morpho__vault_quote "
          + "then morpho__vault_deposit, a direct option with morpho__market_quote then morpho__market_supply. Take the "
          + "tool NAMES from each option's own `routing.quote.publicName` and "
          + "`routing.execute.publicName` rather than from this sentence."),
  });
}
