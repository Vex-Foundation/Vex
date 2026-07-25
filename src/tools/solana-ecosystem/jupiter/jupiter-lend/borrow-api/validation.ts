/**
 * Validation and auth helpers for Jupiter Lend Borrow REST endpoints.
 */

import { VexError, ErrorCodes } from "../../../../../errors.js";
import {
  requireJupiterApiKey,
  resolveJupiterApiKey,
} from "../../../shared/jupiter-auth.js";
import { validateSolanaAddress } from "../../../shared/solana-validation.js";
import {
  JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL,
  JUPITER_LEND_BORROW_DEFAULT_MARKET,
  JUPITER_LEND_BORROW_MARKETS,
  type JupiterLendBorrowMarket,
  type JupiterLendBorrowOperateRequest,
} from "./types.js";

export function resolveJupiterLendBorrowApiKey(): string {
  return resolveJupiterApiKey();
}

export function requireJupiterLendBorrowApiKey(): string {
  return requireJupiterApiKey({ feature: "Jupiter Lend Borrow API", errorCode: ErrorCodes.HTTP_REQUEST_FAILED });
}

export function getJupiterLendBorrowHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": requireJupiterLendBorrowApiKey(),
    ...extraHeaders,
  };
}

/** Reject-not-clamp: an unrecognized `market` value is a clear error, never silently coerced to `"main"`. */
export function validateJupiterLendBorrowMarket(market: string | undefined): JupiterLendBorrowMarket {
  if (market === undefined) return JUPITER_LEND_BORROW_DEFAULT_MARKET;
  if ((JUPITER_LEND_BORROW_MARKETS as readonly string[]).includes(market)) {
    return market as JupiterLendBorrowMarket;
  }
  throw new VexError(
    ErrorCodes.HTTP_REQUEST_FAILED,
    `Unknown Jupiter Lend Borrow market "${market}".`,
    `Valid markets: ${JUPITER_LEND_BORROW_MARKETS.join(", ")}.`,
  );
}

function validateNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${value}`,
      `${name} must be a non-negative integer.`,
    );
  }
  return value;
}

export function validateJupiterLendBorrowVaultId(vaultId: number): number {
  return validateNonNegativeInteger("vaultId", vaultId);
}

export function validateJupiterLendBorrowPositionId(positionId: number): number {
  return validateNonNegativeInteger("positionId", positionId);
}

function validateAddressList(values: string[], fieldName: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${fieldName} must include at least one Solana address.`,
    );
  }
  return values.map((value) => validateSolanaAddress(value));
}

export function normalizeJupiterLendBorrowUsersQuery(users: string[]): string {
  return validateAddressList(users, "users").join(",");
}

/**
 * A `colAmount`/`debtAmount` delta is EITHER `"0"` (untouched leg), the
 * MIN_I128 close-all sentinel, or a plain signed base-10 integer string. No
 * other shape reaches the provider — this is the one boundary between
 * Vex-side bigint arithmetic (`../../../../vex-agent/tools/protocols/
 * solana-jupiter/borrow-operate-params.ts`) and the wire request.
 */
export function assertJupiterLendBorrowDeltaString(name: string, value: string): string {
  if (value === JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL) return value;
  if (!/^-?\d+$/.test(value)) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${value}`,
      `${name} must be a signed base-10 integer string in smallest units.`,
    );
  }
  return value;
}

export function validateJupiterLendBorrowOperateRequest(
  request: JupiterLendBorrowOperateRequest,
): JupiterLendBorrowOperateRequest {
  return {
    vaultId: validateJupiterLendBorrowVaultId(request.vaultId),
    positionId: validateJupiterLendBorrowPositionId(request.positionId),
    ...(request.positionOwner !== undefined
      ? { positionOwner: validateSolanaAddress(request.positionOwner) }
      : {}),
    signer: validateSolanaAddress(request.signer),
    colAmount: assertJupiterLendBorrowDeltaString("colAmount", request.colAmount),
    debtAmount: assertJupiterLendBorrowDeltaString("debtAmount", request.debtAmount),
  };
}
