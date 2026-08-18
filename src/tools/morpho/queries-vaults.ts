/**
 * The GraphQL documents the VAULTS lane sends, and nothing else.
 *
 * Kept in their own module rather than appended to `./queries.ts` because the
 * two lanes have genuinely different reasons to change: Morpho's `Vault` (V1 /
 * MetaMorpho) and `VaultV2` are SEPARATE types with separate filter inputs,
 * separate order-by enums, and a different internal shape entirely. Nothing
 * below can be shared with a market document.
 *
 * The V1-versus-V2 differences that shape every query here, all read off the
 * live schema by introspection on 2026-08-14:
 *
 *   - V1 nests its numbers under `state { ... }`. V2 is FLAT: `totalAssets`,
 *     `netApy` and `sharePrice` hang directly off `VaultV2`. A single document
 *     covering both is therefore impossible.
 *   - `VaultFilters` has `search` and `assetSymbol_in`; `VaultV2sFilters` has
 *     NEITHER. It also spells its where-input `VaultV2sFilters`, with the `s`,
 *     while the order-by is `VaultV2OrderBy` without one.
 *   - `VaultOrderBy` has `Name`, `Fee` and `Curator`; `VaultV2OrderBy` has none
 *     of the three. A sort a version cannot serve is refused by name upstream
 *     rather than silently swapped for another key.
 *   - V1 has ONE `state.timelock`. V2 has a per-function `timelocks[]` table,
 *     so there is no single V2 timelock number to report on a screening row.
 *   - V1 fee filters are Float FRACTIONS (`fee_lte: 0.05`); V2 fee filters are
 *     BigInt WAD (`performanceFee_gte: "150000000000000000"` = 15%). Both were
 *     verified against live counts on 2026-08-14, not inferred from the type.
 *
 * `VaultV2CapData` is a UNION (`AdapterCapData | CollateralCapData |
 * MarketV1CapData`), so the per-market allocation view on a V2 vault only exists
 * behind an inline fragment. Querying `market` on the union directly is a hard
 * `GRAPHQL_VALIDATION_FAILED`, which is how the shape below was found.
 *
 * Every field was verified present by the same 2026-08-14 introspection, on the
 * post-deprecation names only: `listed` (not `whitelisted`), `price.usd` (not
 * `priceUsd`), `netApyExcludingRewards`, and `allRewards` (not `rewards`) on V1.
 * V2's incentive list genuinely IS called `rewards`; that is a different type,
 * not the deprecated V1 spelling.
 */

/** Identity and asset fields shared by the V1 list and V1 detail reads. */
const VAULT_V1_CORE_FIELDS = `
  address
  name
  symbol
  listed
  creationTimestamp
  chain { id network }
  asset { address symbol decimals price { usd } }
  warnings { type level }
`;

/** V1 numbers and roles. Everything here lives under `state`. */
const VAULT_V1_STATE_FIELDS = `
  totalAssets
  totalAssetsUsd
  totalSupply
  apy
  netApy
  netApyExcludingRewards
  fee
  timelock
  curator
  owner
  guardian
  sharePriceNumber
  sharePriceUsd
  allRewards { supplyApr asset { address symbol decimals } }
  curators { id name verified }
`;

/** Identity, asset and headline numbers for V2. Flat by construction. */
const VAULT_V2_CORE_FIELDS = `
  address
  name
  symbol
  listed
  type
  creationTimestamp
  chain { id network }
  asset { address symbol decimals price { usd } }
  warnings { type level }
  totalAssets
  totalAssetsUsd
  totalSupply
  idleAssets
  idleAssetsUsd
  liquidity
  liquidityUsd
  sharePrice
  apy
  netApy
  netApyExcludingRewards
  maxApy
  performanceFee
  managementFee
  curator { address }
  owner { address }
  curators { items { id name verified } }
  rewards { supplyApr asset { address symbol decimals } }
  gatesConfig {
    sendSharesGate { address abdicated }
    receiveSharesGate { address abdicated }
    receiveAssetsGate { address abdicated }
    sendAssetsGate { address abdicated }
  }
`;

export const MORPHO_VAULTS_V1_QUERY = `
query VexMorphoVaultsV1($first: Int!, $skip: Int!, $orderBy: VaultOrderBy, $orderDirection: OrderDirection, $where: VaultFilters) {
  vaults(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) {
    pageInfo { countTotal count limit skip }
    items {
      ${VAULT_V1_CORE_FIELDS}
      state { ${VAULT_V1_STATE_FIELDS} }
    }
  }
}`;

export const MORPHO_VAULTS_V2_QUERY = `
query VexMorphoVaultsV2($first: Int!, $skip: Int!, $orderBy: VaultV2OrderBy, $orderDirection: OrderDirection, $where: VaultV2sFilters) {
  vaultV2s(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) {
    pageInfo { countTotal count limit skip }
    items { ${VAULT_V2_CORE_FIELDS} }
  }
}`;

/**
 * One V1 vault in full.
 *
 * `pendingConfigs` is read for its `pageInfo.countTotal` ONLY. The count answers
 * the agent's real question - "is this vault's configuration about to change" -
 * while the item list is a paginated governance log that would dominate the
 * response without changing the answer.
 */
export const MORPHO_VAULT_V1_QUERY = `
query VexMorphoVaultV1($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    ${VAULT_V1_CORE_FIELDS}
    liquidity { underlying usd }
    allocators { address }
    state {
      ${VAULT_V1_STATE_FIELDS}
      feeRecipient
      skimRecipient
      pendingOwner
      avgNetApy
      avgNetApyExcludingRewards
      pendingConfigs { pageInfo { countTotal } }
      allocation {
        supplyAssets
        supplyAssetsUsd
        supplyCap
        supplyCapUsd
        pendingSupplyCap
        pendingSupplyCapValidAt
        supplyQueueIndex
        withdrawQueueIndex
        removableAt
        market {
          marketId
          lltv
          listed
          loanAsset { address symbol decimals }
          collateralAsset { address symbol decimals }
          state { supplyApy netSupplyApy borrowApy utilization }
        }
      }
    }
  }
}`;

/** One V2 vault in full, including the cap table its allocations live in. */
export const MORPHO_VAULT_V2_QUERY = `
query VexMorphoVaultV2($address: String!, $chainId: Int!) {
  vaultV2ByAddress(address: $address, chainId: $chainId) {
    ${VAULT_V2_CORE_FIELDS}
    avgNetApy
    avgNetApyExcludingRewards
    maxRate
    forceDeallocatableLiquidity
    performanceFeeRecipient
    managementFeeRecipient
    timelocks { functionName duration abdicatedAt }
    sentinels { sentinel { address } }
    allocators { allocator { address } }
    pendingConfigs { pageInfo { countTotal } }
    adapters { pageInfo { countTotal } items { address type assets assetsUsd forceDeallocatePenalty } }
    caps {
      pageInfo { countTotal }
      items {
        id
        type
        absoluteCap
        relativeCap
        allocation
        data {
          __typename
          ... on MarketV1CapData {
            adapterAddress
            market {
              marketId
              lltv
              listed
              loanAsset { address symbol decimals }
              collateralAsset { address symbol decimals }
              state { supplyApy netSupplyApy borrowApy utilization }
            }
          }
          ... on AdapterCapData { adapterAddress }
        }
      }
    }
  }
}`;

/**
 * IS MORPHO CURATING THIS VAULT - the smallest document that answers it, and the
 * only vault read a signing decision consumes.
 *
 * SEPARATE FROM THE DETAIL DOCUMENTS ON PURPOSE, for three reasons that all
 * point the same way. It is served UNCACHED (`ttlMs: 0`), so it must not be
 * large; the detail reads are served through a 15-second cache, which is right
 * for a screen and wrong for the flag a deposit is gated on. It selects the
 * IDENTITY beside the flag - `address` and `chain { id }` - so the answer can be
 * proved to be about the vault that was asked about rather than another curated
 * one. And it reads `listed` STRICTLY where every detail read reads it
 * tolerantly, which is rules/90's split between a display field and a field a
 * signing decision consumes.
 *
 * Two documents rather than one because `Vault` and `VaultV2` are separate
 * GraphQL types reached through separate root fields; the client tries V2 then
 * V1 exactly as `getVault` does.
 */
export const MORPHO_VAULT_V2_CURATION_QUERY = `
query VexMorphoVaultV2Curation($address: String!, $chainId: Int!) {
  vaultV2ByAddress(address: $address, chainId: $chainId) {
    address
    listed
    chain { id }
  }
}`;

export const MORPHO_VAULT_V1_CURATION_QUERY = `
query VexMorphoVaultV1Curation($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    address
    listed
    chain { id }
  }
}`;
