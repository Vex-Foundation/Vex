/**
 * Validated Morpho read shapes - what survives `./validation/*` and is safe for
 * the agent layer to project.
 *
 * Two conventions are load-bearing throughout:
 *
 * 1. Every RAW amount is a decimal string of base units and never travels alone.
 *    The asset that owns it carries `decimals`, so a reader can render it. A
 *    bare `"1047061"` next to a mint is 1.05 at six decimals and 0.00105 at
 *    nine (rules/90), and Morpho's GraphQL serialises the same `BigInt` scalar
 *    as a JSON number below 2^53 and a JSON string above it - so the string form
 *    here is normalised, not passed through.
 *
 * 2. Every APY is a FRACTION as Morpho returns it (0.0412 = 4.12%), and its
 *    BASIS is in the field name. `supplyApy` excludes rewards, `netSupplyApy`
 *    includes them, and a reward APR is a third basis again, denominated in a
 *    different token. The agent layer converts to percent and labels; nothing
 *    here silently mixes the three.
 */

export interface MorphoAsset {
  address: string;
  symbol: string | null;
  /** Strict: an amount in this asset cannot be read without it, so a row with no decimals is dropped. */
  decimals: number;
  /** Display-only oracle mark. Null when Morpho prices nothing for the asset. */
  priceUsd: number | null;
}

/** One incentive stream on a market, denominated in its own token. */
export interface MorphoMarketReward {
  asset: MorphoAsset;
  /** Fraction, additive on top of the BASE supply APY. Null when not applicable. */
  supplyApr: number | null;
  borrowApr: number | null;
}

export interface MorphoMarketWarning {
  type: string;
  /** Morpho's own `WarningLevel`: `YELLOW` or `RED`, passed through verbatim. */
  level: string;
}

export interface MorphoOracleInfo {
  address: string;
  /** `ChainlinkOracle`, `ChainlinkOracleV2`, `CustomOracle` or `Unknown`. */
  type: string | null;
}

/** A raw base-unit amount travelling with everything needed to read it. */
export interface MorphoRawAmount {
  raw: string;
  decimals: number;
  /** Display USD from Morpho's oracle mark. Null when unpriced. */
  usd: number | null;
}

export interface MorphoMarketApy {
  /** Rewards EXCLUDED. */
  supplyApy: number | null;
  /** Rewards INCLUDED. */
  netSupplyApy: number | null;
  /** Rewards EXCLUDED. */
  borrowApy: number | null;
  /** Rewards INCLUDED. */
  netBorrowApy: number | null;
  /** The adaptive-curve IRM's target-utilization borrow APY. */
  apyAtTarget: number | null;
  rewards: MorphoMarketReward[];
}

/** One averaging window, all four series on the same window. */
export interface MorphoApyWindow {
  supplyApy: number | null;
  netSupplyApy: number | null;
  borrowApy: number | null;
  netBorrowApy: number | null;
}

export interface MorphoMarketState {
  timestamp: number | null;
  blockNumber: string | null;
  supply: MorphoRawAmount;
  borrow: MorphoRawAmount;
  collateral: MorphoRawAmount | null;
  /** Loan-asset liquidity sitting in the market right now. */
  liquidity: MorphoRawAmount;
  /** Fraction, 0-1. */
  utilization: number | null;
  /** Protocol fee as a fraction of interest. */
  fee: number | null;
  apy: MorphoMarketApy;
}

export interface MorphoMarket {
  marketId: string;
  chainId: number;
  /** WAD fraction as an integer string, e.g. `"860000000000000000"` = 86%. */
  lltv: string;
  listed: boolean;
  irmAddress: string;
  creationTimestamp: number | null;
  loanAsset: MorphoAsset;
  /** Null on an idle market, which has no collateral leg at all. */
  collateralAsset: MorphoAsset | null;
  oracle: MorphoOracleInfo | null;
  warnings: MorphoMarketWarning[];
  /** Loan-asset units a Public Allocator reallocation could add to liquidity. */
  reallocatableLiquidityRaw: string | null;
  state: MorphoMarketState | null;
}

export interface MorphoMarketPage {
  markets: MorphoMarket[];
  /** Morpho's own `pageInfo.countTotal` - rows MATCHING the filter, not rows returned. */
  countTotal: number;
  count: number;
  limit: number;
  skip: number;
  /** Rows the validator refused. Reported, never hidden. */
  droppedRows: number;
}

/** One vault's reallocatable contribution, aggregated per vault by the validator. */
export interface MorphoSharedLiquidity {
  vaultAddress: string;
  vaultName: string | null;
  /** Loan-asset base units, summed across the vault's withdraw-market pairs. */
  assetsRaw: string;
}

export interface MorphoSupplyingVault {
  address: string;
  name: string | null;
  /**
   * Which generation this supplier is.
   *
   * Carried per row rather than implied by the list it came from, because the
   * two generations are read from two different GraphQL fields and merged into
   * one list here. A V1 and a V2 vault can share a name (`Gauntlet USDC Prime`
   * exists as both on Base), so without this tag two different contracts are
   * indistinguishable in the reply.
   */
  version: MorphoVaultVersion;
  /** Vault APY is NET of the vault fee - not the same basis as a market APY. */
  netApy: number | null;
}

export interface MorphoMarketDetail extends MorphoMarket {
  badDebtRaw: string | null;
  badDebtUsd: number | null;
  realizedBadDebtRaw: string | null;
  realizedBadDebtUsd: number | null;
  /**
   * Morpho Blue's oracle price, scaled by `36 + loanDecimals - collateralDecimals`.
   * Verified numerically against the 2026-08-14 fixture: 6.2746442e38 at scale 34
   * is 62,746.44, matching the same response's cbBTC mark of 62,686 USD.
   */
  oraclePriceRaw: string | null;
  oraclePriceScaleDecimals: number | null;
  totalLiquidity: MorphoRawAmount | null;
  sharedLiquidity: MorphoSharedLiquidity[];
  supplyingVaults: MorphoSupplyingVault[] | null;
  /** Present only when a window was requested. */
  apyWindow: MorphoApyWindow | null;
}

// -- Vaults ---------------------------------------------------------

/**
 * Which Morpho vault generation a row came from.
 *
 * This is not cosmetic. A V1 (MetaMorpho) vault has one global timelock and no
 * gating; a V2 vault has a PER-FUNCTION timelock table and four transfer gates
 * that can block a deposit or a withdrawal outright. Erasing the distinction
 * would present two different risk shapes under one heading.
 */
export type MorphoVaultVersion = "v1" | "v2";

/** One incentive stream on a vault. Vault rewards are supply-side only. */
export interface MorphoVaultReward {
  asset: MorphoAsset;
  /** Fraction. Denominated in its OWN token, so never additive with a vault APY. */
  supplyApr: number | null;
}

/** A named curation entity Morpho recognises, as opposed to a bare address. */
/** One link a curator published about itself: a site, a forum thread, a social account. */
export interface MorphoCuratorLink {
  /** Morpho's own label. Observed live: `url`, `forum`, `twitter` (2026-08-18). */
  type: string;
  url: string;
}

/**
 * The party a depositor is actually trusting.
 *
 * Everything past `verified` is DISCLOSURE, and it is all display-only, so every
 * field is nullable and an absent one is read as "not published" rather than as
 * a malformed response (rules/90's tolerant-reader split). The deposit gate
 * rests on a curator vouching for the markets a vault lends into, so a reply
 * carrying only a name and a boolean gave the agent nothing to say about WHO
 * that is; `links` is where the curator's own site, forum presence and social
 * accounts are, and `aumUsd` is Morpho's estimate of everything they run.
 */
export interface MorphoVaultCurator {
  id: string | null;
  name: string | null;
  /** Morpho's own verification flag. `false` is not an accusation, only an absence. */
  verified: boolean;
  description: string | null;
  imageUrl: string | null;
  links: MorphoCuratorLink[];
  /** Total assets under this curator's management across Morpho, in USD. */
  aumUsd: number | null;
}

/**
 * One V2 transfer gate.
 *
 * A non-null `address` means a contract decides whether that transfer is allowed
 * at all. `abdicated` means the curator gave up the right to ever set this gate,
 * which is the strongest possible assurance it will stay open.
 */
export interface MorphoVaultGate {
  /** `sendShares`, `receiveShares`, `sendAssets` or `receiveAssets`. */
  name: string;
  address: string | null;
  abdicated: boolean;
}

/**
 * Gating summary for a V2 vault. Always absent on V1, which has no gates.
 *
 * ERC-4626 direction decides which half a gate blocks: a DEPOSIT sends assets in
 * and receives shares, a WITHDRAWAL sends shares back and receives assets out.
 */
export interface MorphoVaultGating {
  gated: boolean;
  depositGated: boolean;
  withdrawalGated: boolean;
  gates: MorphoVaultGate[];
}

/**
 * A vault APY block, every basis under its own key.
 *
 * `apy` is BEFORE the vault's fee; `netApy` is after it and includes reward
 * streams; `netApyExcludingRewards` is after it and excludes them. Verified
 * arithmetically on the 2026-08-14 capture: Steakhouse USDC reported
 * apy 0.041208 with fee 0.25 and netApy 0.030750, and Steakhouse USDT reported
 * apy 0.030737 with fee 0.05 and netApy 0.029178.
 */
export interface MorphoVaultApy {
  apy: number | null;
  netApy: number | null;
  netApyExcludingRewards: number | null;
  /** Morpho's own trailing average. The API does not name the window it covers. */
  avgNetApy: number | null;
  avgNetApyExcludingRewards: number | null;
  rewards: MorphoVaultReward[];
}

/** Vault fees as fractions. `management` exists only on V2. */
export interface MorphoVaultFees {
  performance: number | null;
  management: number | null;
  performanceRecipient: string | null;
  managementRecipient: string | null;
}

/** One screening row, unified across both generations. */
export interface MorphoVault {
  address: string;
  version: MorphoVaultVersion;
  chainId: number;
  name: string | null;
  symbol: string | null;
  listed: boolean;
  creationTimestamp: number | null;
  asset: MorphoAsset;
  /** Denominated in `asset`. USD is Morpho's oracle mark. */
  totalAssets: MorphoRawAmount;
  /** Share supply, in SHARE units - not the vault's asset. */
  totalSupplyRaw: string | null;
  /** Assets redeemable right now. V2 reports it directly; V1 does not carry it on a list row. */
  liquidity: MorphoRawAmount | null;
  /** Assets per share, as Morpho's own float. Display only. */
  sharePrice: number | null;
  apy: MorphoVaultApy;
  fees: MorphoVaultFees;
  /** Curating address, plus any named entity Morpho attributes it to. */
  curatorAddress: string | null;
  curators: MorphoVaultCurator[];
  ownerAddress: string | null;
  /** V1's single global timelock, in seconds. Null on V2, which has one per function. */
  timelockSeconds: number | null;
  /** V2 only. Null on V1, which has no gating mechanism at all. */
  gating: MorphoVaultGating | null;
  /** V2's `VaultV2Type`, e.g. `MorphoVault` or `FeeWrapper`. Null on V1. */
  vaultType: string | null;
  warnings: MorphoMarketWarning[];
}

export interface MorphoVaultPage {
  vaults: MorphoVault[];
  countTotal: number;
  droppedRows: number;
}

/** One market a vault allocates to, with the cap governing that allocation. */
export interface MorphoVaultAllocation {
  marketId: string;
  lltv: string;
  marketListed: boolean;
  loanAsset: MorphoAsset | null;
  collateralAsset: MorphoAsset | null;
  /** Supplied into the market, in the LOAN asset's units. */
  suppliedRaw: string | null;
  suppliedUsd: number | null;
  /** Cap in the same units as `suppliedRaw`. V2 caps are absolute-cap values. */
  capRaw: string | null;
  capUsd: number | null;
  pendingCapRaw: string | null;
  pendingCapValidAt: number | null;
  /** Fraction of vault assets this cap allows, WAD. V2 only. */
  relativeCapWad: string | null;
  supplyQueueIndex: number | null;
  withdrawQueueIndex: number | null;
  removableAt: number | null;
  /** The market's OWN supply APY, gross of any vault fee. */
  marketSupplyApy: number | null;
  marketNetSupplyApy: number | null;
  marketUtilization: number | null;
}

/** One V2 adapter, i.e. a venue the vault can route assets into. */
export interface MorphoVaultAdapter {
  address: string;
  type: string | null;
  assetsRaw: string | null;
  assetsUsd: number | null;
  /** WAD fraction charged for a forced deallocation out of this adapter. */
  forceDeallocatePenaltyWad: string | null;
}

/** One V2 timelock entry. `abdicatedAt` set means the function can never be used. */
export interface MorphoVaultTimelock {
  functionName: string;
  durationSeconds: number | null;
  abdicatedAt: number | null;
}

export interface MorphoVaultDetail extends MorphoVault {
  /** Owner/curator/allocator/guardian/sentinel, whichever the generation has. */
  guardianAddress: string | null;
  pendingOwnerAddress: string | null;
  allocatorAddresses: string[];
  sentinelAddresses: string[];
  skimRecipient: string | null;
  /** V2 per-function timelocks. Empty on V1, whose single value is `timelockSeconds`. */
  timelocks: MorphoVaultTimelock[];
  /** COUNT of queued governance changes, not the log itself. */
  pendingConfigCount: number;
  /** Null when `includeAllocations` was false. */
  allocations: MorphoVaultAllocation[] | null;
  adapters: MorphoVaultAdapter[];
  /** V2 idle assets sitting in the vault rather than in an adapter. */
  idleAssets: MorphoRawAmount | null;
  /** V2 liquidity obtainable only by forcing a deallocation, at a penalty. */
  forceDeallocatableLiquidityRaw: string | null;
  /** V2's `maxApy`: the ceiling the vault's rate is capped at. */
  maxApy: number | null;
  /** The curator's own published description of the vault's strategy. Display-only. */
  description: string | null;
  imageUrl: string | null;
  /**
   * What KIND of account holds the curator role, as Morpho classifies it.
   *
   * Observed members: `safe` (a Safe multisig) and `aragon`. An empty list means
   * Morpho published no classification, which is NOT evidence the role is held
   * by a single private key - it is an absence, and must be reported as one.
   * V1 only; the V2 read exposes no equivalent (introspection, 2026-08-18).
   */
  curatorAccountTypes: string[];
}

/**
 * Positions and activity types live in a sibling module and are re-exported
 * here, so `@tools/morpho/types.js` stays the one import path for this client's
 * shapes while each lane's types move for their own reasons.
 */
export type {
  MorphoSignedAmount,
  MorphoPositionMarketRef,
  MorphoMarketPosition,
  MorphoMarketPositionPage,
  MorphoVaultPosition,
  MorphoVaultPositionPage,
  MorphoVaultV2Coverage,
  MorphoActivityAmount,
  MorphoMarketTransaction,
  MorphoActivityPage,
} from "./types-positions.js";
