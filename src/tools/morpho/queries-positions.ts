/**
 * The GraphQL documents the POSITIONS lane sends.
 *
 * Every field below was verified present by live introspection on 2026-08-14.
 * Three properties of this surface are worth stating next to the text, because
 * each one shaped a tool contract rather than only a query.
 *
 * A POSITION ROW IS NOT PROOF OF A POSITION. Morpho keeps a `MarketPosition` for
 * every market an address has ever touched, so an unfiltered read of a busy
 * address returns thousands of closed rows. The caller therefore always sends
 * one of the `*_gte` bounds; the union of the three is the wallet's real
 * footprint.
 *
 * HEALTH FACTOR IS NULL WHENEVER THERE IS NO DEBT. Measured on the same day: a
 * supply-only row returns `healthFactor: null` and
 * `priceVariationToLiquidationPrice: null`. That absence means "nothing to
 * liquidate", not "unknown", and the two must never be rendered the same way.
 *
 * VAULT V2 POSITIONS CANNOT BE LISTED PER USER. `vaultPositions` resolves
 * `vault` to the V1 `Vault` type, and the only V2 position read the schema
 * declares is `vaultV2PositionByAddress(userAddress, vaultAddress, chainId)` -
 * one address AND one vault at a time. `VaultV2sFilters` has no user predicate
 * either. The honest composition is {@link MORPHO_VAULT_V2_USER_VAULTS_QUERY}:
 * ask which V2 vaults this wallet has transacted with, then read each position
 * by address. Its coverage is reported rather than assumed.
 *
 * Signed integers appear here for the first time in this lane: `margin`,
 * `borrowPnl` and `pnl` are `BigInt` scalars that arrive NEGATIVE on a losing
 * position (a live row on 2026-08-14 carried `margin: -23633633`). They are read
 * by the signed reader, never by the unsigned money reader.
 */

/** The market a position points at. Enough to act on, without a second read. */
const POSITION_MARKET_FIELDS = `
  marketId
  lltv
  listed
  chain { id network }
  loanAsset { address symbol decimals price { usd } }
  collateralAsset { address symbol decimals price { usd } }
  warnings { type level }
`;

const MARKET_POSITION_STATE_FIELDS = `
  timestamp
  collateral
  collateralUsd
  supplyAssets
  supplyAssetsUsd
  supplyShares
  borrowAssets
  borrowAssetsUsd
  borrowShares
  margin
  marginUsd
  borrowPnl
  borrowPnlUsd
  borrowRoe
`;

export const MORPHO_MARKET_POSITIONS_QUERY = `
query VexMorphoMarketPositions($first: Int!, $skip: Int!, $orderBy: MarketPositionOrderBy, $orderDirection: OrderDirection, $where: MarketPositionFilters) {
  marketPositions(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) {
    pageInfo { countTotal count limit skip }
    items {
      id
      healthFactor
      listed
      priceVariationToLiquidationPrice
      user { address }
      market { ${POSITION_MARKET_FIELDS} }
      state { ${MARKET_POSITION_STATE_FIELDS} }
    }
  }
}`;

/** V1 (MetaMorpho) vault positions. `VaultPositionOrderBy` declares only `Shares`. */
export const MORPHO_VAULT_POSITIONS_QUERY = `
query VexMorphoVaultPositions($first: Int!, $skip: Int!, $orderDirection: OrderDirection, $where: VaultPositionFilters) {
  vaultPositions(first: $first, skip: $skip, orderBy: Shares, orderDirection: $orderDirection, where: $where) {
    pageInfo { countTotal count limit skip }
    items {
      id
      listed
      user { address }
      vault {
        address name symbol listed
        chain { id network }
        asset { address symbol decimals price { usd } }
        state { apy netApy }
      }
      state { timestamp assets assetsUsd shares pnl pnlUsd roe }
    }
  }
}`;

/**
 * One VaultV2 position. The ONLY V2 position read in the schema, and it needs
 * the vault address, which is why the lane discovers those addresses first.
 */
export const MORPHO_VAULT_V2_POSITION_QUERY = `
query VexMorphoVaultV2Position($userAddress: String!, $vaultAddress: String!, $chainId: Int!) {
  vaultV2PositionByAddress(userAddress: $userAddress, vaultAddress: $vaultAddress, chainId: $chainId) {
    id shares assets assetsUsd pnl pnlUsd roe
    chain { id network }
    user { address }
    vault {
      address name symbol listed
      asset { address symbol decimals price { usd } }
      apy netApy
    }
  }
}`;

/**
 * Which V2 vaults a wallet has ever transacted with, newest first.
 *
 * A discovery step, not a balance read: a wallet that deposited and fully exited
 * still appears here, and the position read that follows is what decides whether
 * anything is left. `VaultV2TransactionOrderBy` spells the time member `Time`,
 * not `Timestamp` - the obvious guess is a hard validation error.
 */
export const MORPHO_VAULT_V2_USER_VAULTS_QUERY = `
query VexMorphoVaultV2UserVaults($first: Int!, $where: VaultV2TransactionFilters, $orderDirection: OrderDirection) {
  vaultV2transactions(first: $first, orderBy: Time, orderDirection: $orderDirection, where: $where) {
    pageInfo { countTotal count limit skip }
    items { timestamp vault { address chain { id network } } }
  }
}`;
