/**
 * What a caller may ASK the Pendle read surface for, and the guards that run
 * before any URL is built.
 *
 * Split from `./client.ts` on purpose: this module owns the request contract
 * (which filters exist, which sort keys actually work, what a legal value is),
 * while the client owns how the call is made. They change for different
 * reasons — the contract moves when Pendle's query surface moves, the client
 * moves when our transport, caching or CU accounting moves.
 *
 * Every guard here runs BEFORE the URL exists. These values reach the read lane
 * from tool params, i.e. ultimately from model output, and a URL path segment is
 * an unsafe sink: percent-encoding a non-address still leaves it addressing
 * something. The check is "is this an address", not "is this safe to encode".
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import type {
  PendleReadAssetPriceType,
  PendleReadHistoryField,
  PendleReadTimeFrame,
} from "./types.js";

/** Provider-enforced page ceiling (`limit must not be greater than 100`). */
export const PENDLE_READ_MAX_PAGE_LIMIT = 100;

/** Default page budget for a catalogue walk: 12 x 100 rows covers every chain today. */
export const PENDLE_READ_DEFAULT_MAX_PAGES = 12;

/** Provider-required rounding bound on the order book's implied-APY axis. */
export const PENDLE_READ_MAX_ORDERBOOK_PRECISION = 3;

/**
 * Sort keys `/v2/markets/all` actually honours, each verified live on
 * 2026-07-27 by comparing the returned order against the field itself.
 *
 * NESTED FIELDS NEED THE DOTTED PATH. `order_by=liquidity:-1` is ACCEPTED and
 * silently does not sort by liquidity — so is `order_by=nonsense:1`. Only
 * `details.liquidity:-1` orders by liquidity. Because the endpoint never rejects
 * an unknown key, an unverified sort key is a silent no-op that would make us
 * claim a ranking we did not get; hence a closed union rather than a
 * pass-through string.
 */
export const PENDLE_READ_MARKET_SORT_KEYS = [
  "details.liquidity",
  "details.totalTvl",
  "details.tradingVolume",
  "details.impliedApy",
  "details.underlyingApy",
  "details.aggregatedApy",
  "details.maxBoostedApy",
  "details.pendleApy",
  "expiry",
  "name",
] as const;

export type PendleReadMarketSortKey = (typeof PENDLE_READ_MARKET_SORT_KEYS)[number];

export interface PendleReadMarketQuery {
  /**
   * Provider-side chain filter. OMIT to receive EVERY chain in one walk — the
   * endpoint's cross-chain mode, and the reason it exists. Live on 2026-07-27:
   * one 2-CU call returned all 90 active markets across all 7 non-empty chains,
   * against 11 sequential per-chain calls and ~1,940 ms for the same view. The
   * parameter takes a SINGLE id; a comma-separated list is rejected with HTTP
   * 400, so a multi-chain subset is one cross-chain read filtered locally.
   */
  chainId?: number;
  /** Provider-side active filter. Omit to receive active AND matured markets. */
  isActive?: boolean;
  /** Exact `chainId-address` market ids. The cheapest way to reach one market. */
  ids?: readonly string[];
  sortBy?: PendleReadMarketSortKey;
  sortDirection?: "asc" | "desc";
  skip?: number;
  limit?: number;
}

export interface PendleReadHistoryQuery {
  timeFrame: PendleReadTimeFrame;
  fields: readonly PendleReadHistoryField[];
  /** ISO bounds. The provider's own parameter names are `timestamp_start`/`_end`. */
  timestampStart?: string;
  timestampEnd?: string;
}

export interface PendleReadCandleQuery {
  timeFrame: PendleReadTimeFrame;
  /**
   * ISO bounds, same as `historical-data`. Live-verified 2026-07-27: a unix-
   * seconds bound is a 400 ("timestamp_start must be a Date instance") even
   * though the RESPONSE rows carry unix-second timestamps — the asymmetry that
   * let the original seconds claim slip in.
   */
  timestampStart?: string;
  timestampEnd?: string;
}

export interface PendleReadAssetPriceQuery {
  chainId?: number;
  ids?: readonly string[];
  types?: readonly PendleReadAssetPriceType[];
  skip?: number;
  limit?: number;
}

/**
 * `minUsd` maps to the endpoint's own `filterUsd` — a SERVER-side threshold that
 * REMOVES rows (live-verified: a wallet's four sub-$10 positions become zero at
 * `filterUsd=10`). It is therefore an agent-controlled narrowing, never a
 * default: the owner rule is that outputs are not silently truncated, and a
 * silent dust floor is exactly that.
 */
export interface PendleReadPositionsQuery {
  minUsd?: number;
}

export interface PendleReadOrderbookQuery {
  /** Provider-required rounding of the implied-APY axis, 0-3. */
  precisionDecimal: number;
  /** Merge AMM depth into the book (adds `ammSize` to every level). */
  includeAmm?: boolean;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Guard a value that becomes part of a URL PATH, and lowercase it. */
export function requirePathAddress(value: string, label: string): string {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new VexError(
      ErrorCodes.INVALID_ADDRESS,
      `Pendle read: ${label} is not a valid EVM address.`,
      "Pass a 0x-prefixed 40-hex contract address.",
    );
  }
  return value.toLowerCase();
}

/** Guard a chain id that becomes part of a URL path or query. */
export function requirePathChainId(chainId: number): string {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new VexError(
      ErrorCodes.CHAIN_MISMATCH,
      "Pendle read: chain id must be a positive integer.",
      "Resolve the chain through the Pendle chain registry first.",
    );
  }
  return String(chainId);
}

/** Clamp a requested page size to the provider's ceiling; default to the maximum. */
export function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return PENDLE_READ_MAX_PAGE_LIMIT;
  return Math.min(Math.floor(limit), PENDLE_READ_MAX_PAGE_LIMIT);
}

/**
 * A history read with no field list would fall back to the provider's default
 * set, which costs 4x the compute units of a narrow window and returns fields
 * nobody asked for. Naming the fields is the contract.
 */
export function requireHistoryFields(
  fields: readonly PendleReadHistoryField[],
): PendleReadHistoryField[] {
  if (fields.length === 0) {
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      "Pendle read: at least one history field must be requested.",
      "Name the series fields explicitly (for example impliedApy, tvl).",
    );
  }
  return [...fields];
}

/** Guard the order book's provider-required precision bound. */
export function requireOrderbookPrecision(precision: number): string {
  if (!Number.isInteger(precision) || precision < 0 || precision > PENDLE_READ_MAX_ORDERBOOK_PRECISION) {
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      "Pendle read: order-book precision must be an integer between 0 and 3.",
      "Pass precisionDecimal as 0, 1, 2 or 3.",
    );
  }
  return String(precision);
}
