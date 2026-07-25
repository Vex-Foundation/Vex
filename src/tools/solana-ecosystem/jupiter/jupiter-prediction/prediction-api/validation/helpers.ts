/**
 * Validation constants and private helper functions for Jupiter Prediction.
 */

import { VexError, ErrorCodes } from "../../../../../../errors.js";
import { validateSolanaAddress } from "../../../../shared/solana-validation.js";
import type {
  JupiterPredictionCategory,
  JupiterPredictionFilter,
  JupiterPredictionLeaderboardMetric,
  JupiterPredictionLeaderboardPeriod,
  JupiterPredictionPnlInterval,
  JupiterPredictionProvider,
  JupiterPredictionSortBy,
  JupiterPredictionSortDirection,
} from "../types.js";

export const PREDICTION_PROVIDERS: JupiterPredictionProvider[] = ["kalshi", "polymarket", "bisonfi"];
export const PREDICTION_CATEGORIES: JupiterPredictionCategory[] = [
  "all",
  "crypto",
  "sports",
  "politics",
  "esports",
  "culture",
  "economics",
  "tech",
];
export const PREDICTION_FILTERS: JupiterPredictionFilter[] = ["new", "live", "trending", "upcoming"];
export const PREDICTION_SORT_BY: JupiterPredictionSortBy[] = ["volume", "beginAt"];
export const PREDICTION_SORT_DIRECTIONS: JupiterPredictionSortDirection[] = ["asc", "desc"];
export const PREDICTION_PNL_INTERVALS: JupiterPredictionPnlInterval[] = ["24h", "1w", "1m"];
export const PREDICTION_LEADERBOARD_PERIODS: JupiterPredictionLeaderboardPeriod[] = [
  "all_time",
  "weekly",
  "monthly",
];
export const PREDICTION_LEADERBOARD_METRICS: JupiterPredictionLeaderboardMetric[] = [
  "pnl",
  "volume",
  "win_rate",
];

export function assertNonEmptyString(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${name} is required.`,
    );
  }
  return trimmed;
}

export function assertIntegerInRange(
  name: string,
  value: number,
  min: number,
  max?: number,
): void {
  if (!Number.isInteger(value) || value < min || (max != null && value > max)) {
    const range = max != null ? `between ${min} and ${max}` : `at least ${min}`;
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${value}`,
      `${name} must be an integer ${range}.`,
    );
  }
}

export function assertEnumValue<T extends string>(
  name: string,
  value: T,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value)) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `Invalid ${name}: ${value}`,
      `${name} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function normalizePositiveIntegerString(
  name: string,
  value: string | number,
): string {
  const normalized = typeof value === "number" ? String(value) : value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${String(value)}`,
      `${name} must be a base-10 integer string in smallest units.`,
    );
  }
  if (BigInt(normalized) <= 0n) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${normalized}`,
      `${name} must be greater than 0.`,
    );
  }
  return normalized;
}

export function normalizeOptionalCsv(
  value?: string | string[],
): string | undefined {
  if (value == null) return undefined;
  const parts = Array.isArray(value) ? value : value.split(",");
  const normalized = parts.map((part) => part.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      "subcategory must include at least one non-empty value.",
    );
  }
  return normalized.join(",");
}

export function normalizePaginationRange(start?: number, end?: number): void {
  if (start != null) assertIntegerInRange("start", start, 0);
  if (end != null) assertIntegerInRange("end", end, 0);
}

export function normalizeOwnerPubkey(ownerPubkey: string): string {
  return validateSolanaAddress(ownerPubkey);
}

export function normalizeOptionalPubkey(value?: string): string | undefined {
  return value != null ? validateSolanaAddress(value) : undefined;
}

export function normalizeOptionalNonEmptyString(value?: string): string | undefined {
  return value != null ? assertNonEmptyString("value", value) : undefined;
}
