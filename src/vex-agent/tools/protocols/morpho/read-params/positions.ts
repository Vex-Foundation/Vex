/**
 * Input contract for `morpho.positions.get`.
 *
 * ONE WALLET PER CALL, and that is a design decision rather than a limitation of
 * the API: Morpho's `userAddress_in` takes a list, and this tool refuses to use
 * it. A position read is the most identifying call in this namespace - it maps
 * an address to its debts - and a tool that can take several addresses at once
 * invites correlating wallets that have no reason to be correlated. The refusal
 * is by name so the caller learns the rule rather than wondering why a second
 * address vanished.
 *
 * The reject-by-name discipline behind every guard used here is documented in
 * `./_primitives.ts`.
 */

import {
  MORPHO_MAX_PAGE_LIMIT,
  MORPHO_POSITION_SCOPES,
  type MorphoPositionScope,
} from "@tools/morpho/request.js";
import {
  ADDRESS_PATTERN,
  readChains,
  readOptionalBool,
  readOptionalEnum,
  readOptionalNumber,
  readOptionalString,
  reject,
  type MorphoParams,
} from "./_primitives.js";

/**
 * How many of the wallet's V2 vault transactions the coverage scan reads before
 * it stops and says so.
 *
 * The scan exists because the schema has no per-user V2 position list. One page
 * is the whole budget for it: this is a composition already costing one request
 * per distinct vault found, and letting it walk an arbitrarily long history
 * would turn a position read into an unbounded crawl against a provider that
 * answers abuse with a seven-day ban.
 */
export const MORPHO_V2_SCAN_LIMIT = 100;

/** Distinct V2 vaults read per call. Above this the coverage block reports partial. */
export const MORPHO_V2_MAX_VAULTS = 10;

export interface MorphoPositionsQuery {
  walletAddress: string;
  chainIds: number[] | undefined;
  scope: MorphoPositionScope;
  /** Fraction bound sent to `healthFactor_lte`. Undefined means no HF filter at all. */
  maxHealthFactor: number | undefined;
  includeVaultV2: boolean;
  limit: number;
  offset: number;
  echo: Record<string, unknown>;
}

export function parseMorphoPositionsParams(p: Record<string, unknown>): MorphoParams<MorphoPositionsQuery> {
  const walletRaw = p["walletAddress"];
  if (Array.isArray(walletRaw)) {
    return reject(
      "walletAddress",
      "`walletAddress` takes ONE address. Reading several wallets' positions in a single call is refused by "
      + "design, because it correlates accounts that may have no relationship. Call the tool once per wallet.",
    );
  }
  const wallet = readOptionalString(walletRaw);
  if (wallet === undefined) {
    return reject("walletAddress", "`walletAddress` is required - a position read is always about one account.");
  }
  if (wallet.includes(",")) {
    return reject(
      "walletAddress",
      `\`walletAddress\` takes ONE address, and "${wallet}" is a list. Reading several wallets' positions in a `
      + "single call is refused by design; call the tool once per wallet.",
    );
  }
  if (!ADDRESS_PATTERN.test(wallet)) {
    return reject("walletAddress", `\`walletAddress\` "${wallet}" is not a 0x-prefixed 40-hex EVM address.`);
  }

  const chainIds = readChains(p["chainIds"], "chainIds");
  if (!chainIds.ok) return chainIds;
  const scope = readOptionalEnum(p["scope"], "scope", MORPHO_POSITION_SCOPES);
  if (!scope.ok) return scope;
  const maxHealthFactor = readOptionalNumber(p["maxHealthFactor"], "maxHealthFactor", { min: 0 });
  if (!maxHealthFactor.ok) return maxHealthFactor;
  const includeVaultV2 = readOptionalBool(p["includeVaultV2"], "includeVaultV2");
  if (!includeVaultV2.ok) return includeVaultV2;
  const limit = readOptionalNumber(p["limit"], "limit", { min: 1, max: MORPHO_MAX_PAGE_LIMIT, integer: true });
  if (!limit.ok) return limit;
  const offset = readOptionalNumber(p["offset"], "offset", { min: 0, integer: true });
  if (!offset.ok) return offset;

  const scopeValue = scope.value ?? "all";
  const limitValue = limit.value ?? 20;
  const offsetValue = offset.value ?? 0;

  // The market half at no HF filter is a UNION of three server-side reads, and a
  // union can only be paged exactly inside one window - the same bound, for the
  // same reason, as the vaults lane's cross-generation merge.
  if (
    scopeValue !== "vaults"
    && maxHealthFactor.value === undefined
    && offsetValue + limitValue > MORPHO_MAX_PAGE_LIMIT
  ) {
    return reject(
      "offset",
      `\`offset\` (${offsetValue}) plus \`limit\` (${limitValue}) must stay within ${MORPHO_MAX_PAGE_LIMIT} rows. `
      + "Market positions are assembled by merging three separate reads (rows with collateral, with supply, with "
      + "debt), and that merge is only provably complete inside one window. Narrow the window, or set "
      + "`maxHealthFactor`, which pages server-side over borrowing positions alone.",
    );
  }

  if (maxHealthFactor.value !== undefined && scopeValue === "vaults") {
    return reject(
      "maxHealthFactor",
      "`maxHealthFactor` filters LENDING-MARKET positions by liquidation risk, and `scope: vaults` reads none of "
      + "them. A vault deposit cannot be liquidated and has no health factor at all. Use scope markets or all.",
    );
  }

  return {
    ok: true,
    value: {
      walletAddress: wallet.toLowerCase(),
      chainIds: chainIds.value,
      scope: scopeValue,
      maxHealthFactor: maxHealthFactor.value,
      includeVaultV2: includeVaultV2.value ?? true,
      limit: limitValue,
      offset: offsetValue,
      echo: {
        walletAddress: wallet.toLowerCase(),
        scope: scopeValue,
        ...(chainIds.value ? { chainIds: chainIds.value } : {}),
        ...(maxHealthFactor.value !== undefined ? { maxHealthFactor: maxHealthFactor.value } : {}),
        includeVaultV2: includeVaultV2.value ?? true,
        limit: limitValue,
        offset: offsetValue,
      },
    },
  };
}
