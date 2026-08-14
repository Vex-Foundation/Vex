/**
 * Input contract for the Morpho read tools - public entry point.
 *
 * The implementation lives in the sibling `./read-params/` folder, one module
 * per lane plus the shared primitives, because the file crossed the size at
 * which one flat parser per tool stopped being readable. This name and these
 * exports are unchanged, so nothing that imports them moved.
 */

export {
  type MorphoParamRejection,
  type MorphoParams,
} from "./read-params/_primitives.js";

export {
  MORPHO_MARKET_FIELD_GROUPS,
  type MorphoMarketFieldGroup,
  type MorphoMarketsDiscoverQuery,
  type MorphoMarketGetQuery,
  parseMorphoMarketsParams,
  parseMorphoMarketGetParams,
} from "./read-params/markets.js";

export {
  MORPHO_VAULT_FIELD_GROUPS,
  type MorphoVaultFieldGroup,
  type MorphoVaultsDiscoverQuery,
  type MorphoVaultGetQuery,
  parseMorphoVaultsParams,
  parseMorphoVaultGetParams,
} from "./read-params/vaults.js";

export {
  MORPHO_V2_MAX_VAULTS,
  MORPHO_V2_SCAN_LIMIT,
  type MorphoPositionsQuery,
  parseMorphoPositionsParams,
} from "./read-params/positions.js";

export {
  type MorphoActivityQueryParams,
  parseMorphoActivityParams,
} from "./read-params/activity.js";
