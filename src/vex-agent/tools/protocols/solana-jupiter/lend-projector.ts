/**
 * Jupiter Lend Earn "rates" concise projector (W1-I).
 *
 * `GET /earn/tokens` (surfaced as `solana.lend.rates`) returns ~15 top-level
 * fields per token plus a nested 8-field `asset` object and a nested 9-field
 * `liquiditySupplyData` object — internal liquidity-management plumbing an
 * agent never acts on, alongside the three fields it actually cares about:
 * `rewardsRate` / `supplyRate` / `totalRate`. Those three are also raw
 * 1e4-scaled basis-point integers (per `earn-api/JupiterLendEarnApi.md` +
 * https://developers.jup.ag/docs/lend — confirmed live in
 * agents_dm/agentscan-phase3/fixtures/lend-earn-tokens.json, e.g. raw "365"
 * is a 3.65% APY) with no unit label — provider jargon, not an agent-legible
 * number.
 *
 * This pure projector trims the raw shape to identity + rate fields, and
 * turns each raw basis-point integer into BOTH an exact percent string
 * (`"3.65%"`, decimal-point shift only — no `parseFloat`/`parseInt` division,
 * so no precision can be invented or lost) and a labeled raw `*Bps` sibling
 * carrying the untouched upstream value, per the OWNER RULE (agent-visible
 * scaled fields must expose their own raw form, not just a derived one).
 *
 * NO field is ever dropped by count/window here — this is pure per-token
 * projection (identity + rates + TVL context), with the only trimming being
 * the well-known liquidity-management plumbing (`liquiditySupplyData`,
 * `rebalanceDifference`, `convertToShares`/`convertToAssets`) that carries no
 * agent-facing rate signal. Any narrowing of *which tokens* appear is via the
 * caller-supplied `assets` id-list / rate-threshold filters below — always
 * agent-controlled, never a silent default cap.
 */

import type { JupiterLendEarnTokenInfo } from "@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/types.js";

// ── Concise output shape ─────────────────────────────────────────

export interface ConciseJupiterLendRate {
  /** Provider's own per-market lending id (e.g. "9") — one valid `assets` filter value. */
  id: string;
  /** Underlying asset mint — matches `solana.lend.deposit`/`withdraw`'s `asset` param. */
  assetAddress: string;
  /** Underlying asset symbol, e.g. "USDC", "WSOL". */
  assetSymbol: string;
  /** Underlying asset's exact decimal USD price quote from upstream, unit-labeled. */
  assetPriceUsd: string;
  /** Jupiter Lend Earn share-token ("jlToken") mint for this market. */
  earnTokenAddress: string;
  /** Earn share-token symbol, e.g. "jlUSDC". */
  earnTokenSymbol: string;
  /** Base supply APY as an exact percent string (e.g. "3.65%"); `null` if upstream sent an unparseable rate. */
  supplyRate: string | null;
  /** Raw supply rate exactly as given by the provider (1e4-scaled basis points; divide by 10000 for the fraction). */
  supplyRateBps: string;
  /** Incentive/rewards APY as an exact percent string; `null` if unparseable. */
  rewardsRate: string | null;
  /** Raw rewards rate exactly as given by the provider (1e4-scaled basis points). */
  rewardsRateBps: string;
  /** Combined (supply + rewards) APY as an exact percent string — the headline rate; `null` if unparseable. */
  totalRate: string | null;
  /** Raw combined rate exactly as given by the provider (1e4-scaled basis points). */
  totalRateBps: string;
  /** Total value locked, exact base-unit string of the underlying asset (see `assetDecimals` to convert to human units). */
  totalAssetsRaw: string;
  /** Total Earn share-token ("jlToken") supply, exact base-unit string. */
  totalSupplyRaw: string;
  /** Underlying asset decimals — needed to interpret `totalAssetsRaw` in human units. */
  assetDecimals: number;
}

/** Optional Vex-side filters applied by {@link projectJupiterLendRates} before projection. */
export interface JupiterLendRateFilters {
  /**
   * Case-sensitive-for-addresses / case-insensitive-for-symbols id list to
   * filter to. Each entry matches if it equals the token's provider id,
   * underlying asset mint, Earn share-token mint, Earn-token symbol, or
   * underlying-asset symbol. Omit (or leave both `undefined`/empty) for all
   * markets — this is a filter, never a default cap.
   */
  assets?: readonly string[];
  /** Only keep markets whose base supply APY percent is at or above this value (e.g. 3 for 3%). */
  minSupplyRate?: number;
  /** Only keep markets whose combined (supply + rewards) APY percent is at or above this value. */
  minTotalRate?: number;
}

// ── Basis-point formatting (string math only — see file header) ──

/** 1e4-scaled rate: raw / 10000 = fraction, i.e. raw / 100 = percent (2 implied decimals). */
const RATE_PERCENT_DECIMALS = 2;

/** Strip a leading run of zeros that isn't the whole (single-digit) string. */
function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Normalise a `string | number` wire value to its exact digit-string form.
 * `String(150)` round-trips exactly for the small non-fractional integers
 * this API returns for rate fields, so this never invents precision.
 */
function toRawString(value: string | number): string {
  return typeof value === "number" ? String(value) : value;
}

/**
 * Format a 1e4-scaled basis-point rate as an exact percent string via pure
 * decimal-point shifting (no `parseFloat`/division), e.g. raw "365" → "3.65%".
 * Returns `null` when the raw value isn't a clean base-10 integer — read
 * endpoints are validated permissively (`earn-api/schemas.ts`), so a
 * malformed rate must degrade to "unknown", never a fabricated percent.
 */
function formatBasisPointsAsPercent(raw: string): string | null {
  const match = /^(-?)(\d+)$/.exec(raw);
  if (!match) return null;
  const sign = match[1] ?? "";
  const digits = match[2];
  if (digits === undefined) return null;
  const padded = digits.padStart(RATE_PERCENT_DECIMALS + 1, "0");
  const wholePart = stripLeadingZeros(padded.slice(0, -RATE_PERCENT_DECIMALS));
  const fractionPart = padded.slice(-RATE_PERCENT_DECIMALS);
  return `${sign}${wholePart}.${fractionPart}%`;
}

/**
 * Parse a 1e4-scaled basis-point rate to a plain number FOR THRESHOLD
 * COMPARISON ONLY (never for the displayed value — that stays string-exact
 * via {@link formatBasisPointsAsPercent}). Safe here because rate magnitudes
 * are tiny (a handful of digits), unlike money amounts, which can exceed
 * `Number.MAX_SAFE_INTEGER` and must never go through this kind of parse.
 */
function parseBasisPointsForComparison(raw: string): number | null {
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

// ── Filtering ──────────────────────────────────────────────────────

function matchesAssetFilter(token: JupiterLendEarnTokenInfo, filters: readonly string[]): boolean {
  const idStr = toRawString(token.id);
  return filters.some((filter) => {
    if (filter === token.assetAddress || filter === token.address || filter === idStr) return true;
    const lower = filter.toLowerCase();
    return token.symbol.toLowerCase() === lower || token.asset.symbol.toLowerCase() === lower;
  });
}

/** `undefined` threshold always passes; an unparseable rate never meets a stated threshold. */
function meetsRateThreshold(rawRate: string | number, minPercent: number | undefined): boolean {
  if (minPercent === undefined) return true;
  const parsed = parseBasisPointsForComparison(toRawString(rawRate));
  if (parsed === null) return false;
  return parsed >= Math.round(minPercent * (10 ** RATE_PERCENT_DECIMALS));
}

// ── Projector ────────────────────────────────────────────────────

function projectToken(token: JupiterLendEarnTokenInfo): ConciseJupiterLendRate {
  const supplyRateBps = toRawString(token.supplyRate);
  const rewardsRateBps = toRawString(token.rewardsRate);
  const totalRateBps = toRawString(token.totalRate);
  return {
    id: toRawString(token.id),
    assetAddress: token.assetAddress,
    assetSymbol: token.asset.symbol,
    assetPriceUsd: toRawString(token.asset.price),
    earnTokenAddress: token.address,
    earnTokenSymbol: token.symbol,
    supplyRate: formatBasisPointsAsPercent(supplyRateBps),
    supplyRateBps,
    rewardsRate: formatBasisPointsAsPercent(rewardsRateBps),
    rewardsRateBps,
    totalRate: formatBasisPointsAsPercent(totalRateBps),
    totalRateBps,
    totalAssetsRaw: token.totalAssets,
    totalSupplyRaw: token.totalSupply,
    assetDecimals: token.asset.decimals,
  };
}

/**
 * Project raw `GET /earn/tokens` results to concise, agent-legible rate rows,
 * applying the caller's optional asset id-list / rate-threshold filters
 * first. Tolerates a non-array input defensively (external API response).
 */
export function projectJupiterLendRates(
  tokens: readonly JupiterLendEarnTokenInfo[] | null | undefined,
  filters: JupiterLendRateFilters = {},
): ConciseJupiterLendRate[] {
  const source = Array.isArray(tokens) ? tokens : [];
  const filtered = source.filter((token) => {
    if (filters.assets && filters.assets.length > 0 && !matchesAssetFilter(token, filters.assets)) {
      return false;
    }
    if (!meetsRateThreshold(token.supplyRate, filters.minSupplyRate)) return false;
    if (!meetsRateThreshold(token.totalRate, filters.minTotalRate)) return false;
    return true;
  });
  return filtered.map(projectToken);
}
