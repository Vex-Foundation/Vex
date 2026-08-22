import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_YIELDS_DISCOVERY } from "../../embeddings/pendle/yields.js";

/**
 * The two Pendle READ tools.
 *
 * Every filter is AGENT-CONTROLLED and echoed back in `filtersApplied`. There is
 * no hidden ceiling and no silent default narrowing: the previous `limit` was
 * clamped to 50 with no echo, so a request for 200 markets returned 50 and said
 * nothing (the owner's no-silent-truncation rule). A value outside a declared
 * enum or range is REJECTED BY NAME rather than dropped.
 *
 * Param descriptions carry the retrieval vocabulary as well as the contract —
 * they feed the lexical discovery lane, where an exact term match is valuable.
 */
export const PENDLE_READ_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.yields",
    publicName: "pendle__markets_discover",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Screen Pendle term-yield markets across all Pendle-supported chains (some have no active markets) - principal "
      + "tokens (PT) locking a FIXED rate to a maturity date, yield tokens (YT), and LP. A Pendle market is one "
      + "underlying asset split into PT and YT with a single EXPIRY: the rate a PT locks is fixed until that date, "
      + "and nothing about the position floats. Use this when the user asks where to lock a fixed rate, what they "
      + "would earn if they held to a given date, which maturities exist for an asset, where the highest implied APY "
      + "is, or how deep a term market is; use `morpho__markets_discover` instead when they want a VARIABLE rate "
      + "that floats with utilization and has no maturity, and the `solana__lend_*` tools for Solana. Filter by chain, "
      + "liquidity, implied APY, expiry window, days to maturity, underlying, category, new/prime; sort by "
      + "liquidity, implied APY, aggregated APY, boosted APY, TVL, volume, expiry or name; every filter that ran is "
      + "echoed in `filtersApplied` and an off-enum or out-of-range value is rejected by name, never clamped. "
      + "RETURNS `summary`, `asOf`, `filtersApplied`, `matched`, `returned`, `catalogComplete`, `catalogTotal`, "
      + "`partial` with `failedChains` and `unsupportedChains`, `chainCounts`, `nextStep`, and `markets`: one row "
      + "per market carrying `chain`, `market`, `name`, `protocol`, `expiry`, `daysToExpiry`, `matured`, the `pt`, "
      + "`yt`, `sy` and `underlying` legs each with address, symbol and decimals, `liquidityUsd`, `tvlUsd`, "
      + "`volume24hUsd`, `impliedApyPercent`, `underlyingApyPercent`, `pendleApyPercent`, `aggregatedApyPercent`, "
      + "`maxBoostedApyPercent`, `ytFloatingApyPercent`, `swapFeeRateBps`, `categories`, `isNew`, `isPrime`, and "
      + "`points` and `externalProtocols` risk flags where they apply. APYs are PERCENT values (5 = 5%), liquidity "
      + "and TVL are USD. Set `fields` to narrow the row shape. PAGE WITH `offset`/`limit`: the reply carries "
      + "`hasMore` and `nextOffset`, and there is no hidden ceiling, so pass back the `nextOffset` it returned. Set "
      + "`includeMatured` to also see expired markets, which can only be redeemed or removed, never bought. "
      + "Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chainIds", type: "string", description: "Comma-separated chains to scope to (e.g. 'ethereum,arbitrum,base'), or 'all'. Each entry is a chain slug/alias or a numeric chain id. Omit for every Pendle chain. An unsupported chain is rejected by name." },
      { key: "includeMatured", type: "boolean", description: "Include EXPIRED/matured markets (default false). Matured markets can only be redeemed or removed, never bought." },
      { key: "minLiquidityUsd", type: "number", description: "Minimum market liquidity in USD — screen out thin markets you could not exit." },
      { key: "maxLiquidityUsd", type: "number", description: "Maximum market liquidity in USD." },
      { key: "minImpliedApyPercent", type: "number", description: "Minimum implied APY as a PERCENT (5 = 5%), not a fraction." },
      { key: "maxImpliedApyPercent", type: "number", description: "Maximum implied APY as a PERCENT (25 = 25%). Useful to exclude implausible headline rates." },
      { key: "expiryBefore", type: "string", description: "Only markets expiring before this ISO-8601 date (e.g. '2027-01-01')." },
      { key: "expiryAfter", type: "string", description: "Only markets expiring after this ISO-8601 date." },
      { key: "minDaysToExpiry", type: "number", description: "Minimum whole days until maturity. Negative values match already-matured markets." },
      { key: "maxDaysToExpiry", type: "number", description: "Maximum whole days until maturity — find the nearest maturities." },
      { key: "underlyingSymbol", type: "string", description: "Substring match on the underlying asset symbol or market name (e.g. 'usde', 'weth', 'susd')." },
      { key: "categories", type: "string", description: "Comma-separated Pendle category ids to KEEP (e.g. 'stables,points,ethena')." },
      { key: "excludeCategories", type: "string", description: "Comma-separated Pendle category ids to EXCLUDE (e.g. 'points' to skip points-farming markets)." },
      { key: "isNew", type: "boolean", description: "Only markets Pendle flags as new (true), or only established ones (false)." },
      { key: "isPrime", type: "boolean", description: "Only markets Pendle flags as prime (true), or only non-prime (false)." },
      { key: "sort", type: "string", description: "Ranking key: liquidity (default), impliedApy, aggregatedApy, underlyingApy, maxBoostedApy, tvl, volume, expiry, name. Anything else is rejected by name." },
      { key: "order", type: "string", description: "'desc' (default) or 'asc'." },
      { key: "offset", type: "number", description: "Row offset for paging (default 0). Pair with the returned nextOffset." },
      { key: "limit", type: "number", description: "Max markets to return (default 20). There is NO hidden ceiling — hasMore and nextOffset report what is left." },
      { key: "fields", type: "string", description: "Comma-separated row field groups to keep: identity, apy, liquidity, expiry, legs, points, protocols — or 'all' (default). Use it to keep large result sets small." },
    ],
    exampleParams: { chainIds: "all", sort: "impliedApy", minLiquidityUsd: 100000, maxDaysToExpiry: 180, limit: 10 },
    discovery: PENDLE_YIELDS_DISCOVERY["pendle.yields"],
  },
  {
    toolId: "pendle.position.value",
    publicName: "pendle__positions_get",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Value EVERY Pendle position the session wallet holds on every Pendle chain - principal tokens (PT), yield "
      + "tokens (YT), LP, standardised yield (SY) and cross-chain PT legs. Use this when the user asks what their "
      + "Pendle positions are worth, which of them have matured or are ready to redeem, how much interest has "
      + "accrued, or which position to exit first; it reads the session's OWN wallet and takes no wallet address. "
      + "A matured PT is valued at its face and accounting value, never underlying spot. RETURNS `summary`, "
      + "`wallet`, `asOf`, `filtersApplied`, `count`, `totalValueUsd`, `valuedLegs`, `unvaluedLegs`, "
      + "`countsByState`, `countsByKind`, `partial` with `failedChains` and `unsupportedChains`, `chainFreshness` "
      + "(per chain `dataAsOf`, `ageHours` and a `stalenessWarning`), `crossPtPositions`, `nextStep`, and "
      + "`positions`: one leg per row carrying `chain`, `kind`, `state`, `stateDetermined`, `market`, `token`, "
      + "`expiry`, `daysToExpiry`, `balance`, `valueUsd`, `valuationBasis`, and where they apply `stateNote`, "
      + "`activeBalance` with `activeBalanceNote` (the staked versus wallet LP split), and `accrued` with its "
      + "`items`, `totalUsd` and `note`. `state` is exactly one of earning, matured_redeemable, matured_removable "
      + "or expired_worthless, and it is what decides which tool can act on the leg. Balances travel as raw base "
      + "units WITH their decimals and an exact human amount; USD values are exact decimal strings labelled with "
      + "how they were derived. READ `chainFreshness` BEFORE ACTING: Pendle's dashboard can lag by weeks, so a "
      + "stale chain's numbers are a snapshot, not the current position. Every matching leg is returned in one "
      + "reply and there is no pagination. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chainIds", type: "string", description: "Comma-separated chains to scope to, or 'all'. Each entry is a chain slug/alias or a numeric chain id. Omit for every chain the dashboard returns." },
      { key: "kinds", type: "string", description: "Comma-separated position kinds to keep: pt, yt, lp, sy. Omit for all four. Cross-chain PT legs are always reported separately." },
      { key: "redeemableOnly", type: "boolean", description: "Only legs in state matured_redeemable — the matured PTs ready to redeem (default false)." },
      { key: "minValueUsd", type: "number", description: "Server-side minimum USD value per position; smaller ones are not returned at all. Use it to drop dust. Default: unfiltered." },
      { key: "includeAccrued", type: "boolean", description: "Include accrued unclaimed interest and rewards per leg (default true). Pendle caches these up to 24h." },
      { key: "sort", type: "string", description: "'value' (default), 'expiry' or 'chain'. Anything else is rejected by name." },
      { key: "fields", type: "string", description: "Comma-separated leg field groups to keep: identity, balance, value, expiry, accrued — or 'all' (default)." },
    ],
    exampleParams: { kinds: "pt,lp", redeemableOnly: true, sort: "value" },
    discovery: PENDLE_YIELDS_DISCOVERY["pendle.position.value"],
  },
];
