/**
 * The request vocabulary and guards EVERY Morpho lane shares.
 *
 * Ordering direction, the page ceiling, the WAD percent conversions and the
 * identity guards live here because all five lanes need them and none of them
 * owns them. Everything lane-specific - which filters exist, which sort keys a
 * lane's order-by enum declares - lives in that lane's own sibling module.
 *
 * These values arrive from tool params, i.e. ultimately from model output.
 * GraphQL variables are not a string sink the way a URL path is, but an address
 * or a market id that is not one is still fed to a filter that will silently
 * match nothing - so identity-shaped inputs are checked for SHAPE here and
 * refused by name, never coerced.
 */

import { VexError, ErrorCodes } from "../../../errors.js";

export type MorphoOrder = "asc" | "desc";
export const MORPHO_ORDERS: readonly MorphoOrder[] = ["asc", "desc"];

/** Provider page ceiling this client imposes. Morpho's own `first` accepts more. */
export const MORPHO_MAX_PAGE_LIMIT = 50;

/** WAD scale Morpho expresses `lltv` in (1e18 = 100%). */
export const MORPHO_WAD_DECIMALS = 18;

/** Guard a vault address before it becomes a `vaultByAddress` variable. */
export function requireVaultAddress(value: string): string {
  const trimmed = value.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) {
    const looksLikeMarketId = MARKET_ID_PATTERN.test(trimmed);
    throw new VexError(
      ErrorCodes.INVALID_ADDRESS,
      `Morpho: "${value}" is not a vault address.`
      + (looksLikeMarketId ? " That is a 32-byte MARKET id, not a vault contract address." : ""),
      "A Morpho vault address is a 0x-prefixed 40-hex contract address - read one from morpho__vaults_discover.",
    );
  }
  return trimmed.toLowerCase();
}

/**
 * Guard a wallet address before it becomes a position or activity filter.
 *
 * Morpho itself rejects a malformed address with a `BAD_USER_INPUT` body naming
 * `where.userAddress_in`, so this check is not the only line of defence - it is
 * the one that answers in OUR vocabulary and without spending a request against
 * the seven-day ban budget. Casing does not matter to the server (measured
 * 2026-08-14: the checksummed and lowercased forms of the same address both
 * returned 22 rows), and lowercasing here makes our own cache key stable.
 */
export function requireUserAddress(value: string): string {
  const trimmed = value.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) {
    throw new VexError(
      ErrorCodes.INVALID_ADDRESS,
      `Morpho: "${value}" is not a wallet address.`,
      "Pass one 0x-prefixed 40-hex account address - Morpho positions are read for a single wallet per call.",
    );
  }
  return trimmed.toLowerCase();
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MARKET_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Guard an address destined for an `*_in` filter, and lowercase it. */
export function requireFilterAddress(value: string, label: string): string {
  if (!ADDRESS_PATTERN.test(value.trim())) {
    throw new VexError(
      ErrorCodes.INVALID_ADDRESS,
      `Morpho: ${label} "${value}" is not a valid EVM address.`,
      "Pass a 0x-prefixed 40-hex contract address.",
    );
  }
  return value.trim().toLowerCase();
}

/**
 * Guard a Morpho Blue market id: a 32-byte hash, NOT an address.
 *
 * Worth the separate check because the two are easy to confuse and the failure
 * mode differs. An address passed as a market id does not error - `marketById`
 * simply finds nothing - so without this the agent would read "no such market"
 * when the real fault was a 40-hex value where a 64-hex one belonged.
 */
export function requireMarketId(value: string): string {
  const trimmed = value.trim();
  if (!MARKET_ID_PATTERN.test(trimmed)) {
    const looksLikeAddress = ADDRESS_PATTERN.test(trimmed);
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      `Morpho: "${value}" is not a market id.`
      + (looksLikeAddress ? " That is a 20-byte contract ADDRESS, not a market id." : ""),
      "A Morpho Blue market id is a 0x-prefixed 64-hex hash - read one from morpho__markets_discover.",
    );
  }
  return trimmed.toLowerCase();
}

/** Guard a chain id before it becomes a GraphQL variable. */
export function requireQueryChainId(chainId: number): number {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new VexError(
      ErrorCodes.CHAIN_MISMATCH,
      "Morpho: chain id must be a positive integer.",
      "Resolve the chain through the Morpho chain registry first.",
    );
  }
  return chainId;
}

/**
 * Clamp a page size to this client's ceiling.
 *
 * Clamping is safe HERE, and only here, because the agent-facing boundary
 * (`protocols/morpho/read-params.ts`) rejects an over-limit `limit` BY NAME
 * before it reaches this function. rules/90 forbids a silently clamped
 * parameter; this is the internal floor that keeps a programmatic caller from
 * asking for a page the budget cannot afford, not a place a caller's value is
 * quietly rewritten.
 */
export function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return MORPHO_MAX_PAGE_LIMIT;
  return Math.min(Math.floor(limit), MORPHO_MAX_PAGE_LIMIT);
}

/**
 * Percent -> a WAD integer string (1e18 = 100%).
 *
 * The conversion runs through a rounded integer rather than a float multiply so
 * an 86.5% bound cannot arrive as `865000000000000001`.
 */
export function percentToWadString(percent: number): string {
  const scaled = Math.round(percent * 1e16);
  return BigInt(scaled).toString();
}

/**
 * Percent -> the WAD integer string `lltv_gte` / `lltv_lte` expect.
 *
 * Morpho stores LLTV as a WAD fraction (`"860000000000000000"` = 86%).
 */
export function lltvPercentToWad(percent: number): string {
  return percentToWadString(percent);
}

/**
 * Percent -> the WAD integer string `VaultV2sFilters.performanceFee_*` expects.
 *
 * Separate from the LLTV helper only so the call site reads correctly; the scale
 * is the same. The V2 fee filters being WAD while the V2 fee OUTPUT is a plain
 * fraction (`performanceFee: 0.2`) is not an inference from the type - it was
 * measured on 2026-08-14: `performanceFee_gte: "150000000000000000"` returned
 * 474 vaults whose smallest reported `performanceFee` was exactly 0.15. Vault V1
 * is the opposite: its `fee_lte` takes the FRACTION directly.
 */
export function feePercentToWad(percent: number): string {
  return percentToWadString(percent);
}

/** WAD fraction -> percent, for display. Exact for every LLTV Morpho lists. */
export function wadToPercent(wad: string): number {
  return Number(wad) / 1e16;
}
