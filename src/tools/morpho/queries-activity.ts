/**
 * The GraphQL document the ACTIVITY lane sends: Morpho Blue market transactions.
 *
 * Verified by live introspection and live reads on 2026-08-14.
 *
 * `data` IS A UNION, and that is the whole shape of this read. Morpho declares
 * `MarketTransactionData` with three members, and which one arrives is decided
 * by the row's `type`:
 *
 *   MarketTransactionTransferData            supply, withdraw, borrow, repay
 *                                            -> assets, shares
 *   MarketTransactionCollateralTransferData  supplyCollateral, withdrawCollateral
 *                                            -> assets only, no shares
 *   MarketTransactionLiquidationData         liquidation
 *                                            -> liquidator, repaidAssets,
 *                                               repaidShares, seizedAssets,
 *                                               badDebtAssets, badDebtShares
 *
 * `__typename` is requested explicitly so the validator branches on what ARRIVED
 * rather than on what the row's `type` string promised. The two agreeing is the
 * normal case, not a guarantee we are entitled to assume.
 *
 * WHICH ASSET AN AMOUNT IS IN DEPENDS ON THE BRANCH, and getting it wrong is a
 * decimals error rather than a labelling one. A transfer's `assets` is in the
 * LOAN asset; a collateral transfer's `assets` is in the COLLATERAL asset; in a
 * liquidation `repaidAssets` is the loan asset while `seizedAssets` is the
 * collateral asset. The market's two assets are therefore fetched on every row,
 * because a raw amount without the decimals to read it is the exact hazard
 * rules/90 names.
 *
 * There is NO USD field on any transaction row. `market.loanAsset.price.usd` is
 * today's mark, not the price at the block, so this lane reports amounts with
 * their decimals and leaves USD null rather than multiplying a historical amount
 * by a current price and presenting the product as what happened.
 */

export const MORPHO_MARKET_TRANSACTIONS_QUERY = `
query VexMorphoMarketTransactions($first: Int!, $skip: Int!, $orderBy: MarketTransactionOrderBy, $orderDirection: OrderDirection, $where: MarketTransactionFilters) {
  marketTransactions(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) {
    pageInfo { countTotal count limit skip }
    items {
      txHash
      timestamp
      blockNumber
      txIndex
      logIndex
      type
      chain { id network }
      user { address }
      market {
        marketId
        lltv
        listed
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
      }
      data {
        __typename
        ... on MarketTransactionTransferData { assets shares }
        ... on MarketTransactionCollateralTransferData { assets }
        ... on MarketTransactionLiquidationData {
          liquidator
          repaidAssets
          repaidShares
          seizedAssets
          badDebtAssets
          badDebtShares
        }
      }
    }
  }
}`;
