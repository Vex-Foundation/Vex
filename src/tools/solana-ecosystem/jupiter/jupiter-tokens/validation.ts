/**
 * Validation helpers for Jupiter Tokens API V2.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import { getJupiterHeaders, requireJupiterApiKey, type JupiterApiKeyOptions } from "../../shared/jupiter-auth.js";
import { validateSolanaAddress } from "../../shared/solana-validation.js";
import type {
  JupiterTokenCategory,
  JupiterTokenCategoryParams,
  JupiterTokenInterval,
  JupiterTokenSearchParams,
  JupiterTokenTag,
} from "./types.js";

const JUPITER_TOKEN_TAGS = new Set<JupiterTokenTag>(["lst", "verified", "stocks"]);
const JUPITER_TOKEN_CATEGORIES = new Set<JupiterTokenCategory>([
  "toporganicscore",
  "toptraded",
  "toptrending",
]);
const JUPITER_TOKEN_INTERVALS = new Set<JupiterTokenInterval>(["5m", "1h", "6h", "24h"]);

function assertNonEmptyString(name: string, value: string): void {
  if (!value.trim()) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${name} is required.`,
    );
  }
}

export function requireJupiterTokensApiKey(options: JupiterApiKeyOptions = {}): string {
  return requireJupiterApiKey({
    feature: "Jupiter Tokens API V2",
    ...options,
  });
}

export function getJupiterTokensHeaders(
  extraHeaders: Record<string, string> = {},
  options: JupiterApiKeyOptions = {},
): Record<string, string> {
  return getJupiterHeaders(extraHeaders, {
    feature: "Jupiter Tokens API V2",
    ...options,
  });
}

export function validateJupiterTokenSearchParams(params: JupiterTokenSearchParams): void {
  assertNonEmptyString("query", params.query);
}

export function validateJupiterTokenTag(tag: string): JupiterTokenTag {
  if (!JUPITER_TOKEN_TAGS.has(tag as JupiterTokenTag)) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `Unsupported Jupiter token tag: ${tag}`,
      "Supported tags: verified, lst, stocks.",
    );
  }

  return tag as JupiterTokenTag;
}

export function validateJupiterTokenCategoryParams(
  params: JupiterTokenCategoryParams,
): JupiterTokenCategoryParams {
  if (!JUPITER_TOKEN_CATEGORIES.has(params.category)) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `Unsupported Jupiter token category: ${params.category}`,
      "Supported categories: toporganicscore, toptraded, toptrending.",
    );
  }

  if (!JUPITER_TOKEN_INTERVALS.has(params.interval)) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `Unsupported Jupiter token interval: ${params.interval}`,
      "Supported intervals: 5m, 1h, 6h, 24h.",
    );
  }

  if (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `Invalid Jupiter token limit: ${params.limit}`,
      "limit must be an integer between 1 and 100.",
    );
  }

  return params;
}

export function validateJupiterMintList(mints: string[], maxItems: number, fieldName = "mints"): string[] {
  if (mints.length === 0) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${fieldName} must contain at least one mint address.`,
    );
  }

  if (mints.length > maxItems) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${fieldName} supports at most ${maxItems} mint addresses.`,
    );
  }

  return mints.map((mint) => validateSolanaAddress(mint));
}

export function normalizeMintList(mints: string[]): string {
  return mints.join(",");
}

export function looksLikeMintQuery(query: string): boolean {
  return query.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(query);
}
