/**
 * Input contract for the two Morpho VAULT reads.
 *
 * One rule governs the whole file and it is stronger here than on the markets
 * lane: a predicate one vault generation cannot serve is REFUSED BY NAME, never
 * applied to the half that can serve it and silently skipped on the other half.
 *
 * That is not a stylistic preference. `VaultFilters` (V1) declares `search` and
 * `assetSymbol_in`; `VaultV2sFilters` declares NEITHER. `VaultOrderBy` declares
 * `Name`; `VaultV2OrderBy` does not. Both differences were read off the live
 * schema on 2026-08-14. If a `search` at the default `version: both` were quietly
 * applied to V1 only, the reply would mix filtered V1 rows with UNFILTERED V2
 * rows under one heading, and the agent would have no way to tell. The refusal
 * names the predicate, names the generation that cannot serve it, and names the
 * `version` value that makes it work.
 *
 * Percent-in / fraction-out happens here exactly once per param. The two
 * generations then need DIFFERENT wire scales for the same agent-facing number:
 * V1's `fee_lte` is a fraction, V2's `performanceFee_lte` is a WAD string. Both
 * were measured against live counts, not inferred.
 */

import {
  MORPHO_MAX_PAGE_LIMIT,
  MORPHO_ORDERS,
  MORPHO_VAULT_MERGEABLE_SORT_KEYS,
  MORPHO_VAULT_SORT_KEYS,
  MORPHO_VAULT_VERSIONS,
  feePercentToWad,
  vaultSortSupported,
  type MorphoOrder,
  type MorphoVaultSort,
  type MorphoVaultV1Filters,
  type MorphoVaultV2Filters,
  type MorphoVaultVersionSelector,
} from "@tools/morpho/request.js";
import { MORPHO_SUPPORTED_CHAIN_SLUGS, describeUnsupportedChain, resolveMorphoChainId } from "@tools/morpho/chains.js";
import {
  ADDRESS_PATTERN,
  MARKET_ID_PATTERN,
  MAX_CSV_ENTRIES,
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

/** Row field groups a caller may keep. `all` (the default) keeps everything. */
export const MORPHO_VAULT_FIELD_GROUPS = [
  "identity",
  "asset",
  "apy",
  "size",
  "fees",
  "governance",
  "gating",
] as const;
export type MorphoVaultFieldGroup = (typeof MORPHO_VAULT_FIELD_GROUPS)[number];

/**
 * Which OPTION SETS a screening call returns.
 *
 * `curated` is the default and is exactly what this tool returned before the
 * route existed, so no caller that never learned the key changed behaviour.
 */
export const MORPHO_VAULT_ROUTES = ["curated", "direct", "both"] as const;
export type MorphoVaultRoute = (typeof MORPHO_VAULT_ROUTES)[number];

/** Which generations a screening call will actually query. */
export interface MorphoVaultsDiscoverQuery {
  versions: readonly ("v1" | "v2")[];
  versionSelector: MorphoVaultVersionSelector;
  v1Filters: MorphoVaultV1Filters;
  v2Filters: MorphoVaultV2Filters;
  sort: MorphoVaultSort;
  order: MorphoOrder;
  limit: number;
  offset: number;
  listedOnly: boolean;
  fields: MorphoVaultFieldGroup[] | undefined;
  route: MorphoVaultRoute;
  /**
   * The ONE asset the direct-supply comparison is for, and the chains to look
   * for its markets on. Null at `route: "curated"`, where no market is queried.
   */
  direct: { assetAddress: string; chainIds: readonly number[] | undefined } | null;
  echo: Record<string, unknown>;
}

const DEFAULT_SORT: MorphoVaultSort = "tvlUsd";

/** Comma-separated asset symbols, upper-cased to match Morpho's own spelling. */
function readSymbolCsv(raw: unknown, param: string): MorphoParams<string[] | undefined> {
  const value = readOptionalString(raw);
  if (value === undefined) return { ok: true, value: undefined };
  const items = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length > MAX_CSV_ENTRIES) {
    return reject(
      param,
      `\`${param}\` accepts at most ${MAX_CSV_ENTRIES} comma-separated symbols; ${items.length} were supplied. `
      + "Narrow the list and retry - Vex will not silently drop the extras.",
    );
  }
  const out: string[] = [];
  for (const item of items) {
    const upper = item.toUpperCase();
    if (!out.includes(upper)) out.push(upper);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

/**
 * `fields` accepts a comma string, a string array, or `"all"` - all three of the
 * forms the manifest documents. The manifest declares no `enum` on it precisely
 * so those forms reach here; the by-name rejection below is what replaces the
 * runtime's whole-string check and it must stay at least as informative.
 */
function readFieldGroups(raw: unknown): MorphoParams<MorphoVaultFieldGroup[] | undefined> {
  const parsed = readCsvOrArray(raw, "fields");
  if (!parsed.ok) return parsed;
  if (parsed.value.kind !== "tokens") return { ok: true, value: undefined };
  const out: MorphoVaultFieldGroup[] = [];
  for (const entry of parsed.value.tokens) {
    const token = entry.toLowerCase();
    const match = MORPHO_VAULT_FIELD_GROUPS.find((g) => g === token);
    if (match === undefined) {
      return reject(
        "fields",
        `\`fields\` contains "${token}", which is not a field group. `
        + `Accepted: ${MORPHO_VAULT_FIELD_GROUPS.join(", ")}, or "all".`,
      );
    }
    if (!out.includes(match)) out.push(match);
  }
  return { ok: true, value: out.length > 0 ? out : undefined };
}

/** The refusal a V1-only predicate gets when V2 is in scope. */
function v1OnlyRejection<T>(param: string, what: string): MorphoParams<T> {
  return reject(
    param,
    `\`${param}\` is a V1-only predicate: Morpho's V2 vault filter input declares no ${what}, so at the current `
    + "`version` this filter could only have been applied to half the results. Set `version` to \"v1\" to use it, or "
    + "drop it. Vex refuses rather than returning a page where some rows were filtered and some were not.",
  );
}

/**
 * The direct-supply comparison is PER ASSET, so it needs exactly one asset.
 *
 * `assetTokenAddress` is required rather than inferred from the vault rows that
 * came back, and the reason is the same reject-by-name discipline the rest of
 * this file runs on: inferring it would silently decide which asset the agent
 * was comparing, and a multi-asset call would produce one ranked list mixing
 * USDC markets with WETH markets under a single "best direct option".
 */
function readDirectScope(
  route: MorphoVaultRoute,
  assetAddresses: readonly string[] | undefined,
  chainIds: readonly number[] | undefined,
): MorphoParams<MorphoVaultsDiscoverQuery["direct"]> {
  if (route === "curated") return { ok: true, value: null };
  const assetAddress = assetAddresses?.length === 1 ? assetAddresses[0] : undefined;
  if (assetAddress === undefined) {
    return reject(
      "assetTokenAddress",
      `\`route: "${route}"\` compares supplying ONE asset directly against the curated vaults that hold it, so `
      + "`assetTokenAddress` must name EXACTLY ONE asset contract address"
      + (assetAddresses === undefined ? ", and none was supplied." : ` - ${assetAddresses.length} were supplied.`)
      + " A comparison across several assets would rank a USDC market against a WETH vault, which is not a choice "
      + "anyone can make. Send one address, or use `route: \"curated\"` to screen vaults without the comparison.",
    );
  }
  return { ok: true, value: { assetAddress, chainIds } };
}

// eslint-disable-next-line complexity -- one flat parse per param; splitting it would hide the 1:1 mapping.
export function parseMorphoVaultsParams(p: Record<string, unknown>): MorphoParams<MorphoVaultsDiscoverQuery> {
  const version = readOptionalEnum(p["version"], "version", MORPHO_VAULT_VERSIONS);
  if (!version.ok) return version;
  const selector: MorphoVaultVersionSelector = version.value ?? "both";
  const versions: ("v1" | "v2")[] = selector === "both" ? ["v1", "v2"] : [selector];

  const chainIds = readChains(p["chainIds"], "chainIds");
  if (!chainIds.ok) return chainIds;
  const search = readOptionalString(p["search"]);
  const assetAddresses = readAddressCsv(p["assetTokenAddress"], "assetTokenAddress");
  if (!assetAddresses.ok) return assetAddresses;
  const assetSymbols = readSymbolCsv(p["assetSymbol"], "assetSymbol");
  if (!assetSymbols.ok) return assetSymbols;
  const curators = readAddressCsv(p["curatorAddress"], "curatorAddress");
  if (!curators.ok) return curators;

  const minTvlUsd = readOptionalNumber(p["minTvlUsd"], "minTvlUsd", { min: 0 });
  if (!minTvlUsd.ok) return minTvlUsd;
  const maxTvlUsd = readOptionalNumber(p["maxTvlUsd"], "maxTvlUsd", { min: 0 });
  if (!maxTvlUsd.ok) return maxTvlUsd;
  const minNetApy = readOptionalNumber(p["minNetApyPercent"], "minNetApyPercent");
  if (!minNetApy.ok) return minNetApy;
  const maxFee = readOptionalNumber(p["maxCuratorCutPercent"], "maxCuratorCutPercent", { min: 0, max: 100 });
  if (!maxFee.ok) return maxFee;

  const listedOnly = readOptionalBool(p["listedOnly"], "listedOnly");
  if (!listedOnly.ok) return listedOnly;
  const sort = readOptionalEnum(p["sort"], "sort", MORPHO_VAULT_SORT_KEYS);
  if (!sort.ok) return sort;
  const order = readOptionalEnum(p["order"], "order", MORPHO_ORDERS);
  if (!order.ok) return order;
  const limit = readOptionalNumber(p["limit"], "limit", { min: 1, max: MORPHO_MAX_PAGE_LIMIT, integer: true });
  if (!limit.ok) return limit;
  const offset = readOptionalNumber(p["offset"], "offset", { min: 0, integer: true });
  if (!offset.ok) return offset;
  const fields = readFieldGroups(p["fields"]);
  if (!fields.ok) return fields;
  const route = readOptionalEnum(p["route"], "route", MORPHO_VAULT_ROUTES);
  if (!route.ok) return route;

  const chosenRoute: MorphoVaultRoute = route.value ?? "curated";
  const directScope = readDirectScope(chosenRoute, assetAddresses.value, chainIds.value);
  if (!directScope.ok) return directScope;

  if (search !== undefined && versions.includes("v2")) {
    return v1OnlyRejection("search", "free-text search predicate");
  }
  if (assetSymbols.value !== undefined && versions.includes("v2")) {
    return v1OnlyRejection("assetSymbol", "asset-symbol predicate (use `assetTokenAddress`, which both generations serve)");
  }

  const chosenSort = sort.value ?? DEFAULT_SORT;
  for (const generation of versions) {
    if (vaultSortSupported(generation, chosenSort)) continue;
    return reject(
      "sort",
      `\`sort: "${chosenSort}"\` is not a ranking Morpho's ${generation} vault query can perform - its order-by enum `
      + "has no such member. Vex refuses rather than substituting another key and presenting the result as the "
      + `ranking you asked for. Either set \`version: "v1"\`, or sort by ${MORPHO_VAULT_MERGEABLE_SORT_KEYS.join(", ")}.`,
    );
  }

  const rangeRejection = checkRange("minTvlUsd", minTvlUsd.value, "maxTvlUsd", maxTvlUsd.value);
  if (rangeRejection !== null) return { ok: false, rejection: rangeRejection };

  const windowEnd = (offset.value ?? 0) + (limit.value ?? 20);
  if (versions.length > 1 && windowEnd > MORPHO_MAX_PAGE_LIMIT) {
    return reject(
      "offset",
      `At \`version: "both"\` the two generations are ranked together, which means fetching the top ${windowEnd} rows `
      + `from EACH and merging them - and ${windowEnd} is over the ${MORPHO_MAX_PAGE_LIMIT}-row page ceiling. Keep `
      + `\`offset\` + \`limit\` at or below ${MORPHO_MAX_PAGE_LIMIT}, or set \`version\` to one generation to page `
      + "further. Vex will not return a merged page it cannot prove is correctly ranked.",
    );
  }

  const listed = listedOnly.value ?? true;
  const shared = {
    listed,
    ...(chainIds.value ? { chainId_in: chainIds.value } : {}),
    ...(assetAddresses.value ? { assetAddress_in: assetAddresses.value } : {}),
    ...(curators.value ? { curatorAddress_in: curators.value } : {}),
    ...(minTvlUsd.value !== undefined ? { totalAssetsUsd_gte: minTvlUsd.value } : {}),
    ...(maxTvlUsd.value !== undefined ? { totalAssetsUsd_lte: maxTvlUsd.value } : {}),
    // Percent -> fraction, exactly once, here.
    ...(minNetApy.value !== undefined ? { netApy_gte: minNetApy.value / 100 } : {}),
  };

  const v1Filters: MorphoVaultV1Filters = {
    ...shared,
    ...(search !== undefined ? { search } : {}),
    ...(assetSymbols.value ? { assetSymbol_in: assetSymbols.value } : {}),
    ...(maxFee.value !== undefined ? { fee_lte: maxFee.value / 100 } : {}),
  };
  const v2Filters: MorphoVaultV2Filters = {
    ...shared,
    ...(maxFee.value !== undefined ? { performanceFee_lte: feePercentToWad(maxFee.value) } : {}),
  };

  const echo: Record<string, unknown> = {
    version: selector,
    listedOnly: listed,
    sort: chosenSort,
    order: order.value ?? "desc",
    route: chosenRoute,
  };
  const optional: Array<[string, unknown]> = [
    ["chainIds", chainIds.value?.map((id) => String(id))],
    ["search", search],
    ["assetTokenAddress", assetAddresses.value],
    ["assetSymbol", assetSymbols.value],
    ["curatorAddress", curators.value],
    ["minTvlUsd", minTvlUsd.value],
    ["maxTvlUsd", maxTvlUsd.value],
    ["minNetApyPercent", minNetApy.value],
    ["maxCuratorCutPercent", maxFee.value],
    ["fields", fields.value],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) echo[key] = value;
  }

  return {
    ok: true,
    value: {
      versions,
      versionSelector: selector,
      v1Filters,
      v2Filters,
      sort: chosenSort,
      order: order.value ?? "desc",
      limit: limit.value ?? 20,
      offset: offset.value ?? 0,
      listedOnly: listed,
      fields: fields.value,
      route: chosenRoute,
      direct: directScope.value,
      echo,
    },
  };
}

// -- morpho.vault.get ------------------------------------------------

export interface MorphoVaultGetQuery {
  vaultAddress: string;
  chainId: number;
  chainSlug: string;
  includeAllocations: boolean;
  includeHistory: boolean;
  echo: Record<string, unknown>;
}

export function parseMorphoVaultGetParams(p: Record<string, unknown>): MorphoParams<MorphoVaultGetQuery> {
  const vaultAddress = readOptionalString(p["vaultAddress"]);
  if (vaultAddress === undefined) {
    return reject("vaultAddress", "`vaultAddress` is required - the vault's 0x-prefixed 40-hex contract address.");
  }
  if (!ADDRESS_PATTERN.test(vaultAddress)) {
    const looksLikeMarketId = MARKET_ID_PATTERN.test(vaultAddress);
    return reject(
      "vaultAddress",
      `\`vaultAddress\` must be a 0x-prefixed 40-hex contract address. Received "${vaultAddress}"`
      + (looksLikeMarketId ? ", which is a 64-hex MARKET id - that belongs to morpho.market.get." : ".")
      + " Read one from morpho.vaults.discover.",
    );
  }

  const chainInput = readOptionalString(p["chain"]);
  if (chainInput === undefined) {
    return reject(
      "chain",
      `\`chain\` is required - a vault address is chain-scoped. Supported: ${MORPHO_SUPPORTED_CHAIN_SLUGS.join(", ")}.`,
    );
  }
  const chainId = resolveMorphoChainId(chainInput);
  if (chainId === undefined) return reject("chain", `\`chain\`: ${describeUnsupportedChain(chainInput)}`);

  const includeAllocations = readOptionalBool(p["includeAllocations"], "includeAllocations");
  if (!includeAllocations.ok) return includeAllocations;
  const includeHistory = readOptionalBool(p["includeHistory"], "includeHistory");
  if (!includeHistory.ok) return includeHistory;

  const allocations = includeAllocations.value ?? true;
  const history = includeHistory.value ?? false;

  return {
    ok: true,
    value: {
      vaultAddress: vaultAddress.toLowerCase(),
      chainId,
      chainSlug: chainInput.trim().toLowerCase(),
      includeAllocations: allocations,
      includeHistory: history,
      echo: {
        vaultAddress: vaultAddress.toLowerCase(),
        chain: chainInput.trim().toLowerCase(),
        includeAllocations: allocations,
        includeHistory: history,
      },
    },
  };
}
