import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_MARKET_READ_DISCOVERY } from "../../embeddings/morpho/market-reads.js";
import { MORPHO_MARKET_SORT_KEYS, MORPHO_MAX_PAGE_LIMIT, MORPHO_ORDERS } from "@tools/morpho/request.js";
import { MORPHO_MARKET_FIELD_GROUPS } from "../read-params.js";

/**
 * `morpho.markets.discover` - the screening entry point for the namespace.
 *
 * Every filter here is a REAL server-side predicate and every sort key a real
 * `MarketOrderBy` member, both verified by live introspection on 2026-08-14. A
 * value outside a declared set is refused BY NAME rather than dropped, and every
 * filter that ran is echoed in `filtersApplied` - a screening tool that silently
 * ignores a floor is worse than one that errors, because the agent then believes
 * it filtered and every later decision inherits the mistake.
 *
 * The description is long on purpose (owner decree): the claims in it are
 * grounded in the live 2026-08-14 capture, not in documentation prose. The
 * 297,995% figure is a real row from that capture.
 *
 * It does NOT enumerate the nine chain slugs. That list has ONE home in the
 * retrieval surface - the structured `chains` discovery field, which exists so a
 * chain name recalls a tool at a deliberately low weight. Repeating it in the
 * description as well made this tool outrank `relay.quote.get` on the eval query
 * "Move USDC from Base to Arbitrum using Relay" by two points, purely on two
 * duplicated chain tokens. The agent still gets the list from the `chains`
 * metadata, the namespace navigation summary, and a rejection that names every
 * supported slug.
 */
export const MORPHO_MARKETS_DISCOVER_TOOL: ProtocolToolManifest = {
  toolId: "morpho.markets.discover",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "Screen Morpho Blue VARIABLE-RATE lending markets across the nine EVM chains Vex reads Morpho on (the exact "
    + "slugs ship on this tool's `chains` metadata). "
    + "A Morpho market is ONE loan asset borrowed against ONE collateral asset at a fixed liquidation threshold; "
    + "rates float with utilization and there is no maturity. Use this when the user asks where to lend or deposit an "
    + "asset, what a deposit would earn, where the cheapest borrow rate is, which markets accept a given collateral, or "
    + "how deep a lending market is; use `pendle.yields` instead when they want a FIXED rate locked to an expiry date, "
    + "and `solana.lend.*` for Solana. Filter by chain, free-text search, loan token, collateral token, supplied USD, "
    + "borrowed USD, utilization percent, net supply APY percent, net borrow APY percent and liquidation-threshold "
    + "percent; sort by supplyUsd, netSupplyApy, netBorrowApy, utilization, liquidityUsd or lltv; page with "
    + `offset/limit (max ${MORPHO_MAX_PAGE_LIMIT}). Every filter is applied SERVER-SIDE and echoed back in `
    + "`filtersApplied`; an off-enum or out-of-range value is REJECTED BY NAME, never clamped or dropped. "
    + "RETURNS one row per market: marketId (a 64-hex id, not an address) plus chain, loan and collateral asset each "
    + "with address, symbol and decimals, lltvPercent, utilizationPercent, supply/borrow/collateral and liquidity each "
    + "as {raw, decimals, symbol, human, usd}, oracle address and type, irmAddress, the listed flag, Morpho's own "
    + "per-market warnings, and an APY block. APY LABELLING IS THE CONTRACT: `supplyApyPercent` and "
    + "`borrowApyPercent` EXCLUDE incentives, `netSupplyApyPercent` and `netBorrowApyPercent` INCLUDE them, and each "
    + "`rewards[]` entry is a separate APR paid in its own token - never compare across those three bases. "
    + "`listedOnly` defaults to TRUE because Morpho Blue is permissionless: in a live capture, ranking UNLISTED markets "
    + "by net supply APY returned 297,995% on a market holding 0.04 USD and flagged `oracle_unusable`. "
    + "LIMITS: rates are point-in-time and move with every block, USD values are the market oracle's marks rather than "
    + "traded prices, `liquidity.reallocatable` is liquidity that COULD be moved in and is not committed, and Morpho "
    + "publishes no SLA so this is never a hard dependency. Read-only - it signs nothing and spends nothing.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "chainIds",
      type: "string",
      acceptsStringArray: true,
      description:
        "Comma-separated chains to scope to, an array of the same, or 'all'. Each entry is a chain slug or a numeric "
        + "chain id; discovery ships the supported slugs on this tool's `chains` metadata, and an unsupported entry is "
        + "rejected with the full set spelled out. Omit for every supported chain. A chain Morpho serves but Vex does "
        + "not operate on is rejected by name, so a coverage gap is never reported as an absence of markets.",
    },
    {
      key: "search",
      type: "string",
      description:
        "Free-text substring match on the market's asset symbols and name (for example 'usdc', 'wsteth'). Use it when "
        + "the user names an asset informally instead of by contract address.",
    },
    {
      key: "loanTokenAddress",
      type: "string",
      description:
        "Comma-separated contract addresses of the BORROWABLE asset - the token a lender supplies and a borrower "
        + "receives. Up to 20 entries. Addresses only; a symbol is rejected by name.",
    },
    {
      key: "collateralTokenAddress",
      type: "string",
      description:
        "Comma-separated contract addresses of the COLLATERAL asset - what a borrower locks up. Up to 20 entries. "
        + "Use it to answer 'where can I borrow against X'. Addresses only.",
    },
    {
      key: "minSupplyUsd",
      type: "number",
      description:
        "Minimum total supplied value in USD - the main way to screen out dust markets whose headline rate is "
        + "meaningless. USD is the market oracle's estimate, not a traded price.",
    },
    {
      key: "maxSupplyUsd",
      type: "number",
      description: "Maximum total supplied value in USD. USD is the market oracle's estimate, not a traded price.",
    },
    {
      key: "minBorrowUsd",
      type: "number",
      description:
        "Minimum total borrowed value in USD - real borrowing demand, as opposed to a market that merely holds "
        + "deposits. USD is the market oracle's estimate.",
    },
    {
      key: "maxBorrowUsd",
      type: "number",
      description: "Maximum total borrowed value in USD. USD is the market oracle's estimate.",
    },
    {
      key: "minUtilizationPercent",
      type: "number",
      description:
        "Minimum borrowed/supplied as a PERCENT, 0-100 (80 means 80%), not a fraction. High utilization means a high "
        + "supply rate but little free liquidity to withdraw.",
    },
    {
      key: "maxUtilizationPercent",
      type: "number",
      description:
        "Maximum borrowed/supplied as a PERCENT, 0-100. Cap it to keep markets you could actually exit; a market at "
        + "100% has no withdrawable liquidity at all.",
    },
    {
      key: "minNetSupplyApyPercent",
      type: "number",
      description:
        "Minimum NET supply APY as a PERCENT (5 means 5%), incentives INCLUDED. Not comparable with the incentive-free "
        + "`supplyApyPercent` in the result; pair it with minSupplyUsd or the top hits will be dust.",
    },
    {
      key: "maxNetBorrowApyPercent",
      type: "number",
      description:
        "Maximum NET borrow APY as a PERCENT (8 means 8%), incentives INCLUDED. The filter for 'cheapest place to "
        + "borrow'. Not comparable with the incentive-free `borrowApyPercent`.",
    },
    {
      key: "minLltvPercent",
      type: "number",
      description:
        "Minimum liquidation loan-to-value threshold as a PERCENT, 0-100 (86 means 86%). Higher lets a borrower take "
        + "more debt per unit of collateral and liquidates sooner in a drawdown.",
    },
    {
      key: "maxLltvPercent",
      type: "number",
      description:
        "Maximum liquidation loan-to-value threshold as a PERCENT, 0-100. Cap it for a wider safety margin before "
        + "liquidation.",
    },
    {
      key: "listedOnly",
      type: "boolean",
      description:
        "Keep only markets Morpho itself curates (default true). Set false to include permissionless deployments - "
        + "expect unusable oracles and enormous headline rates on near-empty markets, and check every row's warnings.",
    },
    {
      key: "sort",
      type: "string",
      enum: MORPHO_MARKET_SORT_KEYS,
      description:
        "Ranking key, one of: supplyUsd (default), netSupplyApy, netBorrowApy, utilization, liquidityUsd, lltv. "
        + "Applied server-side over ALL matches, not just the returned page. Anything else is rejected by name.",
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
      description: "Row offset for paging (default 0). Pair it with the `nextOffset` the reply returns.",
    },
    {
      key: "limit",
      type: "number",
      description:
        `Max markets to return (default 20, maximum ${MORPHO_MAX_PAGE_LIMIT}). A larger value is REJECTED by name `
        + "rather than clamped, so what you asked for is always what was applied; `hasMore` and `nextOffset` report "
        + "what is left.",
    },
    {
      key: "fields",
      type: "string",
      acceptsStringArray: true,
      description:
        `Row field groups to keep: a comma list, an array of the same, or 'all' (default). Groups: `
        + `${MORPHO_MARKET_FIELD_GROUPS.join(", ")}. Keeps a large result small; marketId, chain and chainId are `
        + "always present. An unknown group is rejected by name.",
    },
  ],
  exampleParams: { chainIds: "base,ethereum", sort: "netSupplyApy", minSupplyUsd: 1000000, limit: 10 },
  discovery: MORPHO_MARKET_READ_DISCOVERY["morpho.markets.discover"],
};
