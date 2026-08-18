/**
 * Input contract for the two Morpho MARKET reads.
 *
 * Percent-in / fraction-out is done in this file and its vault sibling and
 * nowhere else. Morpho speaks fractions (0.0412 = 4.12%) and the agent speaks
 * percent, so every `*Percent` param is divided by 100 exactly once, on the way
 * into a filter. The reject-by-name discipline behind every guard used here is
 * documented in `./_primitives.ts`.
 */

import {
  MORPHO_LOOKBACK_KEYS,
  MORPHO_MARKET_SORT_KEYS,
  MORPHO_MAX_PAGE_LIMIT,
  MORPHO_ORDERS,
  lltvPercentToWad,
  type MorphoLookback,
  type MorphoMarketFilters,
  type MorphoMarketSort,
  type MorphoOrder,
} from "@tools/morpho/request.js";
import { MORPHO_SUPPORTED_CHAIN_SLUGS, resolveMorphoChainId, describeUnsupportedChain } from "@tools/morpho/chains.js";
import {
  ADDRESS_PATTERN,
  MARKET_ID_PATTERN,
  checkRange,
  readAddressCsv,
  readCsvOrArray,
  readChains,
  readOptionalBool,
  readOptionalEnum,
  readOptionalNumber,
  readOptionalString,
  reject,
  type MorphoParams,
} from "./_primitives.js";
import { readAddressList, readAssetTagList, readMarketIdList } from "./list-values.js";

// -- morpho.markets.discover -----------------------------------------

/** Row field groups a caller may keep. `all` (the default) keeps everything. */
export const MORPHO_MARKET_FIELD_GROUPS = ["identity", "assets", "apy", "size", "risk"] as const;
export type MorphoMarketFieldGroup = (typeof MORPHO_MARKET_FIELD_GROUPS)[number];

export interface MorphoMarketsDiscoverQuery {
  filters: MorphoMarketFilters;
  sort: MorphoMarketSort;
  order: MorphoOrder;
  limit: number;
  offset: number;
  listedOnly: boolean;
  fields: MorphoMarketFieldGroup[] | undefined;
  /** Exactly what was applied, echoed to the agent so it can widen deliberately. */
  echo: Record<string, unknown>;
}

// eslint-disable-next-line complexity -- one flat parse per param; splitting it would hide the 1:1 mapping.
export function parseMorphoMarketsParams(p: Record<string, unknown>): MorphoParams<MorphoMarketsDiscoverQuery> {
  const chainIds = readChains(p["chainIds"], "chainIds");
  if (!chainIds.ok) return chainIds;
  const search = readOptionalString(p["search"]);
  const loanTokens = readAddressCsv(p["loanTokenAddress"], "loanTokenAddress");
  if (!loanTokens.ok) return loanTokens;
  const collateralTokens = readAddressCsv(p["collateralTokenAddress"], "collateralTokenAddress");
  if (!collateralTokens.ok) return collateralTokens;
  const marketIds = readMarketIdList(p["marketIds"], "marketIds");
  if (!marketIds.ok) return marketIds;
  const oracleAddresses = readAddressList(p["oracleAddress"], "oracleAddress");
  if (!oracleAddresses.ok) return oracleAddresses;
  const irmAddresses = readAddressList(p["irmAddress"], "irmAddress");
  if (!irmAddresses.ok) return irmAddresses;
  const loanTags = readAssetTagList(p["loanAssetTags"], "loanAssetTags");
  if (!loanTags.ok) return loanTags;
  const collateralTags = readAssetTagList(p["collateralAssetTags"], "collateralAssetTags");
  if (!collateralTags.ok) return collateralTags;
  const isIdle = readOptionalBool(p["isIdle"], "isIdle");
  if (!isIdle.ok) return isIdle;

  const minSupplyUsd = readOptionalNumber(p["minSupplyUsd"], "minSupplyUsd", { min: 0 });
  if (!minSupplyUsd.ok) return minSupplyUsd;
  const maxSupplyUsd = readOptionalNumber(p["maxSupplyUsd"], "maxSupplyUsd", { min: 0 });
  if (!maxSupplyUsd.ok) return maxSupplyUsd;
  const minBorrowUsd = readOptionalNumber(p["minBorrowUsd"], "minBorrowUsd", { min: 0 });
  if (!minBorrowUsd.ok) return minBorrowUsd;
  const maxBorrowUsd = readOptionalNumber(p["maxBorrowUsd"], "maxBorrowUsd", { min: 0 });
  if (!maxBorrowUsd.ok) return maxBorrowUsd;

  const minUtil = readOptionalNumber(p["minUtilizationPercent"], "minUtilizationPercent", { min: 0, max: 100 });
  if (!minUtil.ok) return minUtil;
  const maxUtil = readOptionalNumber(p["maxUtilizationPercent"], "maxUtilizationPercent", { min: 0, max: 100 });
  if (!maxUtil.ok) return maxUtil;

  const minNetSupplyApy = readOptionalNumber(p["minNetSupplyApyPercent"], "minNetSupplyApyPercent");
  if (!minNetSupplyApy.ok) return minNetSupplyApy;
  const maxNetBorrowApy = readOptionalNumber(p["maxNetBorrowApyPercent"], "maxNetBorrowApyPercent");
  if (!maxNetBorrowApy.ok) return maxNetBorrowApy;

  const minLltv = readOptionalNumber(p["minLltvPercent"], "minLltvPercent", { min: 0, max: 100 });
  if (!minLltv.ok) return minLltv;
  const maxLltv = readOptionalNumber(p["maxLltvPercent"], "maxLltvPercent", { min: 0, max: 100 });
  if (!maxLltv.ok) return maxLltv;

  const listedOnly = readOptionalBool(p["listedOnly"], "listedOnly");
  if (!listedOnly.ok) return listedOnly;
  const sort = readOptionalEnum(p["sort"], "sort", MORPHO_MARKET_SORT_KEYS);
  if (!sort.ok) return sort;
  const order = readOptionalEnum(p["order"], "order", MORPHO_ORDERS);
  if (!order.ok) return order;
  const limit = readOptionalNumber(p["limit"], "limit", { min: 1, max: MORPHO_MAX_PAGE_LIMIT, integer: true });
  if (!limit.ok) return limit;
  const offset = readOptionalNumber(p["offset"], "offset", { min: 0, integer: true });
  if (!offset.ok) return offset;
  const fields = readFieldGroups(p["fields"]);
  if (!fields.ok) return fields;

  for (const rejection of [
    checkRange("minSupplyUsd", minSupplyUsd.value, "maxSupplyUsd", maxSupplyUsd.value),
    checkRange("minBorrowUsd", minBorrowUsd.value, "maxBorrowUsd", maxBorrowUsd.value),
    checkRange("minUtilizationPercent", minUtil.value, "maxUtilizationPercent", maxUtil.value),
    checkRange("minLltvPercent", minLltv.value, "maxLltvPercent", maxLltv.value),
  ]) {
    if (rejection !== null) return { ok: false, rejection };
  }

  const listed = listedOnly.value ?? true;
  const filters: MorphoMarketFilters = {
    listed,
    ...(chainIds.value ? { chainId_in: chainIds.value } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(loanTokens.value ? { loanAssetAddress_in: loanTokens.value } : {}),
    ...(collateralTokens.value ? { collateralAssetAddress_in: collateralTokens.value } : {}),
    ...(marketIds.value ? { uniqueKey_in: marketIds.value } : {}),
    ...(oracleAddresses.value ? { oracleAddress_in: oracleAddresses.value } : {}),
    ...(irmAddresses.value ? { irmAddress_in: irmAddresses.value } : {}),
    ...(loanTags.value ? { loanAssetTags_in: loanTags.value } : {}),
    ...(collateralTags.value ? { collateralAssetTags_in: collateralTags.value } : {}),
    ...(isIdle.value !== undefined ? { isIdle: isIdle.value } : {}),
    ...(minSupplyUsd.value !== undefined ? { supplyAssetsUsd_gte: minSupplyUsd.value } : {}),
    ...(maxSupplyUsd.value !== undefined ? { supplyAssetsUsd_lte: maxSupplyUsd.value } : {}),
    ...(minBorrowUsd.value !== undefined ? { borrowAssetsUsd_gte: minBorrowUsd.value } : {}),
    ...(maxBorrowUsd.value !== undefined ? { borrowAssetsUsd_lte: maxBorrowUsd.value } : {}),
    // Percent -> fraction, exactly once, here.
    ...(minUtil.value !== undefined ? { utilization_gte: minUtil.value / 100 } : {}),
    ...(maxUtil.value !== undefined ? { utilization_lte: maxUtil.value / 100 } : {}),
    ...(minNetSupplyApy.value !== undefined ? { netSupplyApy_gte: minNetSupplyApy.value / 100 } : {}),
    ...(maxNetBorrowApy.value !== undefined ? { netBorrowApy_lte: maxNetBorrowApy.value / 100 } : {}),
    ...(minLltv.value !== undefined ? { lltv_gte: lltvPercentToWad(minLltv.value) } : {}),
    ...(maxLltv.value !== undefined ? { lltv_lte: lltvPercentToWad(maxLltv.value) } : {}),
  };

  const echo: Record<string, unknown> = {
    listedOnly: listed,
    sort: sort.value ?? "supplyUsd",
    order: order.value ?? "desc",
  };
  const optional: Array<[string, unknown]> = [
    ["chainIds", chainIds.value?.map((id) => String(id))],
    ["search", search],
    ["loanTokenAddress", loanTokens.value],
    ["collateralTokenAddress", collateralTokens.value],
    ["marketIds", marketIds.value],
    ["oracleAddress", oracleAddresses.value],
    ["irmAddress", irmAddresses.value],
    ["loanAssetTags", loanTags.value],
    ["collateralAssetTags", collateralTags.value],
    ["isIdle", isIdle.value],
    ["minSupplyUsd", minSupplyUsd.value],
    ["maxSupplyUsd", maxSupplyUsd.value],
    ["minBorrowUsd", minBorrowUsd.value],
    ["maxBorrowUsd", maxBorrowUsd.value],
    ["minUtilizationPercent", minUtil.value],
    ["maxUtilizationPercent", maxUtil.value],
    ["minNetSupplyApyPercent", minNetSupplyApy.value],
    ["maxNetBorrowApyPercent", maxNetBorrowApy.value],
    ["minLltvPercent", minLltv.value],
    ["maxLltvPercent", maxLltv.value],
    ["fields", fields.value],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) echo[key] = value;
  }

  return {
    ok: true,
    value: {
      filters,
      sort: sort.value ?? "supplyUsd",
      order: order.value ?? "desc",
      limit: limit.value ?? 20,
      offset: offset.value ?? 0,
      listedOnly: listed,
      fields: fields.value,
      echo,
    },
  };
}

/**
 * `fields` accepts a comma string, a string array, or `"all"` - all three of the
 * forms the manifest documents. The manifest declares no `enum` on it precisely
 * so those forms reach here; the by-name rejection below is what replaces the
 * runtime's whole-string check and it must stay at least as informative.
 */
function readFieldGroups(raw: unknown): MorphoParams<MorphoMarketFieldGroup[] | undefined> {
  const parsed = readCsvOrArray(raw, "fields");
  if (!parsed.ok) return parsed;
  if (parsed.value.kind !== "tokens") return { ok: true, value: undefined };
  const out: MorphoMarketFieldGroup[] = [];
  for (const entry of parsed.value.tokens) {
    const token = entry.toLowerCase();
    const match = MORPHO_MARKET_FIELD_GROUPS.find((g) => g === token);
    if (match === undefined) {
      return reject(
        "fields",
        `\`fields\` contains "${token}", which is not a field group. `
        + `Accepted: ${MORPHO_MARKET_FIELD_GROUPS.join(", ")}, or "all".`,
      );
    }
    if (!out.includes(match)) out.push(match);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

// -- morpho.market.get -----------------------------------------------

export interface MorphoMarketGetQuery {
  marketId: string;
  chainId: number;
  chainSlug: string;
  includeHistory: boolean;
  lookback: MorphoLookback;
  includeSupplyingVaults: boolean;
  echo: Record<string, unknown>;
}

export function parseMorphoMarketGetParams(p: Record<string, unknown>): MorphoParams<MorphoMarketGetQuery> {
  const marketId = readOptionalString(p["marketId"]);
  if (marketId === undefined) {
    return reject("marketId", "`marketId` is required - a 0x-prefixed 64-hex Morpho Blue market id.");
  }
  if (!MARKET_ID_PATTERN.test(marketId)) {
    const looksLikeAddress = ADDRESS_PATTERN.test(marketId);
    return reject(
      "marketId",
      `\`marketId\` must be a 0x-prefixed 64-hex market id. Received "${marketId}"`
      + (looksLikeAddress ? ", which is a 20-byte contract ADDRESS." : ".")
      + " Read one from morpho.markets.discover.",
    );
  }

  const chainInput = readOptionalString(p["chain"]);
  if (chainInput === undefined) {
    return reject(
      "chain",
      `\`chain\` is required - a Morpho market id is chain-scoped. Supported: ${MORPHO_SUPPORTED_CHAIN_SLUGS.join(", ")}.`,
    );
  }
  const chainId = resolveMorphoChainId(chainInput);
  if (chainId === undefined) return reject("chain", `\`chain\`: ${describeUnsupportedChain(chainInput)}`);

  const includeHistory = readOptionalBool(p["includeHistory"], "includeHistory");
  if (!includeHistory.ok) return includeHistory;
  const lookback = readOptionalEnum(p["lookback"], "lookback", MORPHO_LOOKBACK_KEYS);
  if (!lookback.ok) return lookback;
  const includeSupplyingVaults = readOptionalBool(p["includeSupplyingVaults"], "includeSupplyingVaults");
  if (!includeSupplyingVaults.ok) return includeSupplyingVaults;

  const history = includeHistory.value ?? false;
  const window = lookback.value ?? "seven_days";
  const vaults = includeSupplyingVaults.value ?? false;

  return {
    ok: true,
    value: {
      marketId: marketId.toLowerCase(),
      chainId,
      chainSlug: chainInput.trim().toLowerCase(),
      includeHistory: history,
      lookback: window,
      includeSupplyingVaults: vaults,
      echo: {
        marketId: marketId.toLowerCase(),
        chain: chainInput.trim().toLowerCase(),
        includeHistory: history,
        includeSupplyingVaults: vaults,
        ...(history ? { lookback: window } : {}),
      },
    },
  };
}
