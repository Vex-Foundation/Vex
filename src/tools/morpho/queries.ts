/**
 * The GraphQL documents this lane sends, and nothing else.
 *
 * Kept as named constants rather than built per call so the exact text is
 * reviewable, diffable, and comparable against the live schema. Morpho runs an
 * ACTIVE deprecation programme with dated removals, and the 2026-08-14
 * introspection found that the previous generation of names is already GONE
 * rather than merely deprecated: `whitelisted`, `uniqueKey` and `priceUsd` are
 * hard `GRAPHQL_VALIDATION_FAILED` errors, not warnings. Every field below was
 * verified present by that introspection.
 *
 * Field-name notes worth keeping next to the text:
 *   - `listed`, not `whitelisted`.
 *   - `marketId`, not `uniqueKey`.
 *   - `loanAsset.price.usd`, not `loanAsset.priceUsd`.
 *   - `oracle.address`, not `oracleAddress` (`irmAddress` genuinely IS flat).
 *   - `marketById` takes `chainId: Int!` - the non-null matters, a nullable
 *     variable is refused at validation time.
 *   - THE SUPPLIER LIST IS TWO FIELDS, NOT ONE. `supplyingVaults` returns V1
 *     (MetaMorpho) vaults only and `supplyingVaultV2s` returns V2 vaults, and
 *     the two nest differently: V1's APY is under `state { netApy }` while V2's
 *     is FLAT, the same V1/V2 split `./queries-vaults.ts` documents. Reading
 *     only the first was silently answering "who supplies this market" with half
 *     the truth: on the Base cbBTC/USDC market, 13 V1 vaults were reported and
 *     14 V2 vaults were invisible (measured 2026-08-18).
 *
 * The averaged-APY windows in {@link MORPHO_MARKET_QUERY} are FIXED FIELDS. No
 * field of `MarketState` accepts arguments (introspection, 2026-08-14), so a
 * lookback is a field-name choice made after the response arrives, not a
 * variable. All six windows are fetched together because they cost one round
 * trip and the complexity budget is 1,000,000 against a measured 3,030 for the
 * whole document.
 */

/** Fields shared by both reads, so the two can never drift apart. */
const MARKET_CORE_FIELDS = `
  marketId
  lltv
  listed
  irmAddress
  creationTimestamp
  reallocatableLiquidityAssets
  chain { id network }
  loanAsset { address symbol decimals price { usd } }
  collateralAsset { address symbol decimals price { usd } }
  oracle { address type }
  warnings { type level }
`;

const MARKET_STATE_FIELDS = `
  timestamp
  blockNumber
  supplyAssets
  supplyAssetsUsd
  borrowAssets
  borrowAssetsUsd
  collateralAssets
  collateralAssetsUsd
  liquidityAssets
  liquidityAssetsUsd
  utilization
  fee
  supplyApy
  netSupplyApy
  borrowApy
  netBorrowApy
  apyAtTarget
  rewards { supplyApr borrowApr asset { address symbol decimals } }
`;

/** Every averaging window Morpho exposes under a name this lane offers. */
const MARKET_WINDOW_FIELDS = `
  dailySupplyApy dailyNetSupplyApy dailyBorrowApy dailyNetBorrowApy
  weeklySupplyApy weeklyNetSupplyApy weeklyBorrowApy weeklyNetBorrowApy
  monthlySupplyApy monthlyNetSupplyApy monthlyBorrowApy monthlyNetBorrowApy
  quarterlySupplyApy quarterlyNetSupplyApy quarterlyBorrowApy quarterlyNetBorrowApy
  yearlySupplyApy yearlyNetSupplyApy yearlyBorrowApy yearlyNetBorrowApy
  allTimeSupplyApy allTimeNetSupplyApy allTimeBorrowApy allTimeNetBorrowApy
`;

export const MORPHO_MARKETS_QUERY = `
query VexMorphoMarkets($first: Int!, $skip: Int!, $orderBy: MarketOrderBy, $orderDirection: OrderDirection, $where: MarketFilters) {
  markets(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) {
    pageInfo { countTotal count limit skip }
    items {
      ${MARKET_CORE_FIELDS}
      state { ${MARKET_STATE_FIELDS} }
    }
  }
}`;

export const MORPHO_MARKET_QUERY = `
query VexMorphoMarket($marketId: String!, $chainId: Int!) {
  marketById(marketId: $marketId, chainId: $chainId) {
    ${MARKET_CORE_FIELDS}
    badDebt { underlying usd }
    realizedBadDebt { underlying usd }
    publicAllocatorSharedLiquidity { assets vault { address name } }
    supplyingVaults { address name state { netApy } }
    supplyingVaultV2s { address name netApy }
    state {
      ${MARKET_STATE_FIELDS}
      price
      rateAtTarget
      totalLiquidity
      totalLiquidityUsd
      ${MARKET_WINDOW_FIELDS}
    }
  }
}`;

/** Liveness and coverage read. Not an agent tool - used by tests and diagnostics. */
export const MORPHO_CHAINS_QUERY = `
query VexMorphoChains {
  chains { id network currency blockTimeMs }
}`;

/**
 * The CURATION check, deliberately the smallest document in this file.
 *
 * `listed` is Morpho's own statement that it curates this market. It is asked
 * for on its own, uncached, at execution time, because a signing decision must
 * not ride on a value fetched for some other purpose minutes earlier. Nothing
 * else is requested: a narrow document is a cheap one against the complexity
 * budget and it cannot fail because an unrelated field was removed.
 */
export const MORPHO_MARKET_CURATION_QUERY = `
query VexMorphoMarketCuration($marketId: String!, $chainId: Int!) {
  marketById(marketId: $marketId, chainId: $chainId) {
    marketId
    listed
    chain { id }
  }
}`;
