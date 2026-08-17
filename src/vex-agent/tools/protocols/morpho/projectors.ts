/**
 * Projection of validated Morpho reads into agent-facing rows - public entry.
 *
 * The implementation lives in the sibling `./projectors/` folder: the money and
 * percent primitives every lane shares, then one module per lane. This name and
 * these exports are unchanged, so nothing that imports them moved.
 */

export {
  MORPHO_USD_DISCLAIMER,
  formatRawAmount,
  projectAmount,
  projectAsset,
  projectStandalone,
  toPercent,
  type ProjectedAmount,
  type ProjectedAsset,
} from "./projectors/_shared.js";

export {
  MORPHO_APY_DISCLAIMER,
  projectApyWindow,
  projectMarketDetail,
  projectMarketRow,
  selectMarketFields,
  type ProjectedApy,
  type ProjectedMarketRow,
} from "./projectors/markets.js";

export {
  MORPHO_VAULT_APY_DISCLAIMER,
  MORPHO_VAULT_GATING_NOTE,
  MORPHO_VAULT_CURATOR_NOTE,
  projectVaultRow,
  projectVaultDetail,
  selectVaultFields,
  type ProjectedVaultRow,
} from "./projectors/vaults.js";

export {
  MORPHO_HEALTH_FACTOR_NOTE,
  MORPHO_POSITION_USD_NOTE,
  healthFactorBand,
  projectMarketPosition,
  projectPortfolioTotals,
  projectVaultPosition,
  type ProjectedMarketPositionRow,
  type ProjectedVaultPositionRow,
  type ProjectedPortfolioTotals,
} from "./projectors/positions.js";

export {
  MORPHO_REWARDS_CLAIM_NOTE,
  MORPHO_REWARDS_USD_NOTE,
  projectReward,
  summariseClaimableUsd,
  type ProjectedReward,
  type ProjectedRewardChain,
} from "./projectors/rewards.js";

export {
  MORPHO_ALLOWANCE_NOTE,
  MORPHO_BALANCE_FRESHNESS_NOTE,
  countUnlimitedApprovals,
  projectWalletSnapshot,
  type ProjectedWalletBalance,
} from "./projectors/wallet.js";

export {
  MORPHO_ACTIVITY_HISTORY_NOTE,
  MORPHO_ACTIVITY_USD_NOTE,
  projectActivityRow,
  summariseActivity,
  type ProjectedActivityRow,
} from "./projectors/activity.js";

export {
  MORPHO_QUOTE_GAS_NOTE,
  MORPHO_QUOTE_DEPOSIT_GATING_WARNING,
  MORPHO_QUOTE_GATING_WARNING,
  MORPHO_QUOTE_GOVERNANCE_UNKNOWN_NOTE,
  MORPHO_QUOTE_PREVIEW_NOTE,
  projectQuoteGovernance,
  summariseQuote,
  type MorphoQuoteGovernance,
  type ProjectedQuoteGovernance,
} from "./projectors/quote.js";
