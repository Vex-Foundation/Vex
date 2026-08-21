import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_VAULT_READ_DISCOVERY } from "../../embeddings/morpho/vault-reads.js";
import {
  MORPHO_MAX_PAGE_LIMIT,
  MORPHO_ORDERS,
  MORPHO_VAULT_SORT_KEYS,
  MORPHO_VAULT_VERSIONS,
} from "@tools/morpho/request.js";
import { MORPHO_VAULT_FIELD_GROUPS } from "../read-params.js";
// Direct import: `../read-params.js` is the public barrel and is being edited
// concurrently, so this lane's newest export is taken from its own module.
import { MORPHO_VAULT_ROUTES } from "../read-params/vaults.js";

/**
 * `morpho.vaults.discover` - the screening entry point for the vaults lane.
 *
 * Every filter is a REAL server-side predicate on the generation it is sent to,
 * and every sort key a real order-by member, both verified by live introspection
 * on 2026-08-14. Where the two generations DIVERGE the tool refuses by name
 * rather than half-applying: `search` and `assetSymbol` exist only on V1's
 * filter input and `sort: name` only on V1's order-by, so asking for one while
 * V2 is in scope is an error naming the `version` that would work.
 *
 * The description is long on purpose (owner decree). Its concrete claims are
 * from the live capture, not from documentation: the `tstcntrct` vault, the fee
 * arithmetic, and the two fee scales were all observed on 2026-08-14.
 */
export const MORPHO_VAULTS_DISCOVER_TOOL: ProtocolToolManifest = {
  toolId: "morpho.vaults.discover",
  publicName: "morpho__vaults_discover",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "Screen Morpho VAULTS across the EVM chains Vex reads Morpho on (the exact slugs ship on this tool's `chains` "
    + "metadata). "
    + "A Morpho vault is a CURATED, MANAGED deposit: the depositor hands one asset to a curator who spreads it across "
    + "many Morpho Blue lending markets and takes a fee from the yield. That is a different product from a lending "
    + "market, and the routing rule is simple - use THIS tool when the user wants somewhere passive to park an asset, "
    + "asks which vault pays best, or wants to compare curators; use `morpho.markets.discover` when they want to lend "
    + "into ONE specific asset pair themselves, or to borrow. Use `pendle.*` for a FIXED rate locked to an expiry date "
    + "and `solana.lend.*` for Solana. "
    + "COVERS BOTH VAULT GENERATIONS. `version` selects v1 (MetaMorpho), v2, or both (the default). At `both` this "
    + "tool queries BOTH generations, takes the top (offset + limit) rows from EACH under your sort key, merges them "
    + "and re-sorts the union, so the returned ordering is the exact global ranking for that window and `matched` is "
    + "the sum of both totals; paging beyond one window is refused by name rather than served as a merge that could "
    + "miss rows. "
    + "Filter by chain, vault asset address, curator address, TVL in USD, minimum net APY percent and maximum curator "
    + "cut percent (the fee bound is spelled `maxCuratorCutPercent`: a key containing 'fee' is reserved here for a "
    + "fee VEX charges); also filter by asset TAGS and by which lending MARKETS a vault supplies "
    + "(`suppliesMarketIds`, the way to ask 'which vaults are exposed to this market'). "
    + "`search`, `assetSymbol`, `assetTags` and `suppliesMarketIds` are V1-only predicates and are REJECTED BY NAME "
    + "when v2 is in scope, "
    + "because applying a filter to half a result set and not the other half is worse than refusing. Sort by "
    + `${MORPHO_VAULT_SORT_KEYS.join(", ")} (default tvlUsd); a key only one generation's order-by declares is `
    + "rejected by name, naming the `version` that can serve it; page with offset/limit (max "
    + `${MORPHO_MAX_PAGE_LIMIT}). Every filter that ran is echoed in \`filtersApplied\`. `
    + "RETURNS one row per vault: address, version, chain, name, symbol, listed flag, the vault asset with address, "
    + "symbol and decimals, TVL as {raw, decimals, symbol, human, usd}, share supply as a SHARE count at an "
    + "explicitly unknown scale, share price, "
    + "curator address plus any named curator Morpho attributes it to, owner, fees, warnings, and an APY block. "
    + "APY LABELLING IS THE CONTRACT AND IT DIFFERS FROM THE MARKETS LANE: a vault APY is NET of the vault's fee "
    + "while a market APY is GROSS, so the two must never be ranked against each other. `apyPercent` is the yield "
    + "BEFORE the curator's fee, `netApyPercent` is what a depositor actually earns with incentives included, "
    + "`netApyExcludingRewardsPercent` is after the fee and EXCLUDES incentives while `netApyPercent` INCLUDES them, and each `rewards[]` entry is a separate APR "
    + "paid in its own token. In a live capture a vault reported 4.12% before a 25% fee and 3.07% after "
    + "it - that gap is larger than the spread between most vaults in the same list. "
    + "GATING IS A HARD WARNING AND ONLY V2 VAULTS HAVE IT. `gating.withdrawalGated` true means a gate contract "
    + "decides whether a depositor may exit at all; `gating.depositGated` blocks entry. Live gated vaults exist, so "
    + "never recommend a deposit without reading this flag. V1 vaults report `gating: null` and a single "
    + "`timelockSeconds`; V2 vaults report `timelockSeconds: null` because their timelocks are per-function and are "
    + "returned by `morpho.vault.get`. "
    + "`listedOnly` defaults to TRUE because anyone can deploy a vault: reading Morpho's own unordered vault list in "
    + "a live capture put a vault named `tstcntrct` in SECOND position, next to one named `Test`, both unlisted and "
    + "holding about ten dollars between them. "
    + "LIMITS: rates are point-in-time and move every block, USD values are Morpho's oracle marks rather than traded "
    + "prices, a curator can change a vault's allocations and therefore its risk at any time subject to a timelock, "
    + "and Morpho publishes no SLA so this is never a hard dependency. "
    + "COMPARES CURATED VAULTS AGAINST SUPPLYING A MARKET DIRECTLY, in one call, through `route`. "
    + "`route: \"curated\"` (the DEFAULT) returns only the vault rows described above and is exactly what this tool "
    + "returned before the parameter existed. `route: \"direct\"` returns only the Morpho Blue markets whose LOAN "
    + "asset is the asset you named, with net supply APY, utilization, liquidity, collateral asset, LLTV and the "
    + "market's own warnings, and queries no vault at all. `route: \"both\"` is the COMPARISON MODE: both sets are "
    + "returned and merged into one `options` list ranked on the single comparable rate, each entry carrying its net "
    + "APY after every fee, the fee itself, what diversification stands behind it, its gating status, and "
    + "`deltaVsBestDirectPercentagePoints` - how far it is, in PERCENTAGE POINTS, from the best direct option. "
    + "`direct` and `both` need `assetTokenAddress` to name EXACTLY ONE asset, because a comparison is per-asset; "
    + "any other count is rejected by name. "
    + "THE TRADEOFF, stated once and not resolved for you: a curator's fee buys diversification across many markets "
    + "and the right to reallocate out of one that deteriorates, while a direct supply pays no curator and "
    + "concentrates the entire position in ONE market's collateral, oracle and LLTV. On a live Base read every "
    + "curated USDC vault earned the same gross 4.13% because they allocate into the same markets and differed only "
    + "by fee - 0%, 5%, 10% and 25% giving 4.13%, 3.92%, 3.71% and 3.08% net - while supplying cbBTC/USDC directly "
    + "earned that same 4.13% with no fee and no diversification at all. "
    + "EVERY OPTION NAMES THE TOOL IT IS ACTED ON WITH. `routing.quote` and `routing.execute` carry a `publicName` - "
    + "the callable name, and the one to emit - the params this call already knows, the params still to decide, and "
    + "an `available` flag; a curated option routes to `morpho__vault_quote` then `morpho__vault_deposit`, a direct "
    + "option to `morpho__market_quote` then `morpho__market_supply`. Read-only - it signs nothing and spends "
    + "nothing.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "version",
      type: "string",
      enum: MORPHO_VAULT_VERSIONS,
      description:
        "Which vault generation to read, one of: both (default), v1, v2. V1 is MetaMorpho with a single global "
        + "timelock and no gating; V2 adds per-function timelocks, a management fee and transfer gates. At 'both' the "
        + "two are queried separately and merged into one exact ranking, which bounds paging to a single window. "
        + "Anything else is rejected by name.",
    },
    {
      key: "route",
      type: "string",
      enum: MORPHO_VAULT_ROUTES,
      description:
        "Which option SETS to return, one of: curated (default), direct, both. `curated` returns the vault rows "
        + "only, unchanged from before this key existed. `direct` returns only the Blue markets that lend the same "
        + "asset, each with its supply APY, utilization, liquidity, collateral asset, LLTV and warnings, and queries "
        + "no vault. `both` returns both sets AND a merged `options` list ranked on net APY, where every entry "
        + "carries its net APY after fees, the fee, its diversification, its gating status, the tool to act on it "
        + "with, and its distance in PERCENTAGE POINTS from the best direct option. `direct` and `both` require "
        + "`assetTokenAddress` to name exactly one asset. Anything else is rejected by name.",
    },
    {
      key: "chainIds",
      type: "string",
      acceptsStringArray: true,
      description:
        "Comma-separated chains to scope to, an array of the same, or 'all'. Each entry is a chain slug or a numeric "
        + "chain id; discovery ships the supported slugs on this tool's `chains` metadata, and an unsupported entry "
        + "is rejected with the full set spelled out. Omit for every supported chain.",
    },
    {
      key: "search",
      type: "string",
      description:
        "Free-text substring match on the vault's name and symbol (for example 'steakhouse', 'usdc'). V1-ONLY: "
        + "Morpho's V2 filter input has no search predicate, so this is rejected by name unless `version` is 'v1'.",
    },
    {
      key: "assetTokenAddress",
      type: "string",
      description:
        "Comma-separated contract addresses of the asset the vault holds and pays out in - the token a depositor "
        + "puts in. Up to 20 entries. Works on BOTH generations, which is why it is the right way to ask for 'USDC "
        + "vaults'. Addresses only; a symbol is rejected by name.",
    },
    {
      key: "assetSymbol",
      type: "string",
      description:
        "Comma-separated symbols of the vault's asset (for example 'USDC,USDT'). V1-ONLY: Morpho's V2 filter input "
        + "has no symbol predicate, so this is rejected by name unless `version` is 'v1'. Prefer `assetTokenAddress`, "
        + "which both generations serve and which cannot match the wrong token.",
    },
    {
      key: "curatorAddress",
      type: "string",
      description:
        "Comma-separated addresses of the curator, the party that decides where the vault's money goes. Up to 20 "
        + "entries. Use it to find every vault run by a manager the user already trusts.",
    },
    {
      key: "assetTags",
      type: "string",
      acceptsStringArray: true,
      description:
        "Comma list or array of Morpho's own asset-class TAGS the vault's asset must carry, to screen a whole class "
        + "of vault rather than one named token. The accepted set is not enumerated here, for the reason recorded on "
        + "`morpho.markets.discover.loanAssetTags`; an unknown tag is rejected by name with the full set spelled out, "
        + "rather than sent as a predicate that matches nothing. V1-ONLY: "
        + "Morpho's V2 filter input declares no tag predicate, so this is rejected by name unless `version` is 'v1'.",
    },
    {
      key: "suppliesMarketIds",
      type: "string",
      acceptsStringArray: true,
      description:
        "Comma list or array of up to 20 64-hex MARKET ids; keeps only vaults that supply at least one listed market. This "
        + "is the 'which vaults are exposed to this market' question - use it to find the curated routes into a "
        + "market you already picked, or to size who else is exposed when a market looks unsafe. V1-ONLY: Morpho's V2 "
        + "filter input has no equivalent, so it is rejected by name unless `version` is 'v1'.",
    },
    {
      key: "minTvlUsd",
      type: "number",
      description:
        "Minimum total deposits in USD - the main way to screen out empty and test vaults, whose headline rates are "
        + "meaningless. USD is Morpho's oracle estimate, not a traded price.",
    },
    {
      key: "maxTvlUsd",
      type: "number",
      description: "Maximum total deposits in USD. USD is Morpho's oracle estimate, not a traded price.",
    },
    {
      key: "minNetApyPercent",
      type: "number",
      description:
        "Minimum NET APY as a PERCENT (5 means 5%), meaning after the curator's fee and with incentives included. "
        + "Not comparable with a market's `supplyApyPercent`, which is gross of any vault fee. Pair it with "
        + "minTvlUsd or the top hits will be near-empty vaults.",
    },
    {
      key: "maxCuratorCutPercent",
      type: "number",
      description:
        "Maximum curator fee as a PERCENT, 0-100 (20 means 20%). On V1 this bounds the vault's single fee; on V2 it "
        + "bounds the PERFORMANCE fee only, because V2's management fee is a separate field Morpho does not offer a "
        + "combined filter for - the management fee is still reported on every row.",
    },
    {
      key: "listedOnly",
      type: "boolean",
      description:
        "Keep only vaults Morpho itself curates (default true). Set false to include uncurated deployments - expect "
        + "deploy tests holding a few dollars, and check every row's warnings, TVL and curator.",
    },
    {
      key: "sort",
      type: "string",
      enum: MORPHO_VAULT_SORT_KEYS,
      description:
        `Ranking key, one of: ${MORPHO_VAULT_SORT_KEYS.join(", ")} (default tvlUsd). Only tvlUsd, apy and netApy are `
        + "served by BOTH generations. `name`, `curator`, `fee` and the four trailing-average keys (avgApy, avgNetApy, "
        + "dailyApy, dailyNetApy) are V1-ONLY; `liquidityUsd`, `idleAssetsUsd` and `realAssetsUsd` are V2-ONLY. A key "
        + "the selected generation cannot serve is rejected by name, naming the `version` that can, rather than being "
        + "swapped for a key that exists. Applied server-side over ALL matches within each generation.",
    },
    {
      key: "order",
      type: "string",
      enum: MORPHO_ORDERS,
      description: "Ranking direction, one of: desc (default), asc. Anything else is rejected by name.",
    },
    {
      key: "offset",
      type: "number",
      description:
        "Row offset for paging (default 0). Pair it with the `nextOffset` the reply returns. At `version: both`, "
        + `offset + limit must stay within ${MORPHO_MAX_PAGE_LIMIT} rows so the merged ranking stays provably exact.`,
    },
    {
      key: "limit",
      type: "number",
      description:
        `Max vaults to return (default 20, maximum ${MORPHO_MAX_PAGE_LIMIT}). A larger value is REJECTED by name `
        + "rather than clamped, so what you asked for is always what was applied; `hasMore` and `nextOffset` report "
        + "what is left.",
    },
    {
      key: "fields",
      type: "string",
      acceptsStringArray: true,
      description:
        `Row field groups to keep: a comma list, an array of the same, or 'all' (default). Groups: `
        + `${MORPHO_VAULT_FIELD_GROUPS.join(", ")}. Keeps a large result small; address, version and chain are `
        + "always present, the gated flags survive dropping the gating group, and an unknown group is rejected by "
        + "name.",
    },
  ],
  exampleParams: { chainIds: "base,ethereum", sort: "netApy", minTvlUsd: 1000000, limit: 10 },
  discovery: MORPHO_VAULT_READ_DISCOVERY["morpho.vaults.discover"],
};
