/**
 * Auth helpers and request body validators for Jupiter Prediction API.
 */

import { VexError, ErrorCodes } from "../../../../../../errors.js";
import {
  requireJupiterApiKey as requireSharedJupiterApiKey,
  resolveJupiterApiKey as resolveSharedJupiterApiKey,
} from "../../../../shared/jupiter-auth.js";
import { validateSolanaAddress } from "../../../../shared/solana-validation.js";
import type {
  JupiterPredictionCreateOrderRequest,
  JupiterPredictionClosePositionRequest,
  JupiterPredictionCloseAllPositionsRequest,
  JupiterPredictionClaimPositionRequest,
  JupiterPredictionExecuteRequest,
} from "../types.js";
import {
  assertIntegerInRange,
  assertNonEmptyString,
  normalizePositiveIntegerString,
  normalizeOwnerPubkey,
} from "./helpers.js";

/**
 * Owner-wide bps bound (0-10,000 = 0-100%). NOT documented by the provider
 * for `minSellPriceSlippageBps` itself — the OpenAPI spec only marks it
 * `required`/`type: number` with no min/max (DOCS-GAP, see `predict-execute.ts`'s
 * `executePredictCloseAll` doc comment). Mirrors this domain's own
 * order-level `slippageBps`/`maxSlippageBps` fields (both `minimum: 0`,
 * described as "0 = none, 250 = 2.5%") and the Swap module's documented
 * `slippageBps` range (0-10000).
 */
const MIN_SELL_PRICE_SLIPPAGE_BPS_MAX = 10_000;

// ── Auth ───────────────────────────────────────────────────────────

export function resolveJupiterPredictionApiKey(): string {
  return resolveSharedJupiterApiKey();
}

export function requireJupiterPredictionApiKey(): string {
  return requireSharedJupiterApiKey({
    feature: "Jupiter Prediction API",
    errorCode: ErrorCodes.HTTP_REQUEST_FAILED,
  });
}

export function getJupiterPredictionHeaders(
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  return {
    "x-api-key": requireJupiterPredictionApiKey(),
    ...extraHeaders,
  };
}

// ── Body validators ────────────────────────────────────────────────

export function validateJupiterPredictionCreateOrderRequest(
  request: JupiterPredictionCreateOrderRequest,
): JupiterPredictionCreateOrderRequest {
  const ownerPubkey = normalizeOwnerPubkey(request.ownerPubkey);

  if (typeof request.isBuy !== "boolean") {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      "isBuy is required.",
    );
  }

  if (request.isBuy) {
    if (typeof request.isYes !== "boolean") {
      throw new VexError(
        ErrorCodes.HTTP_REQUEST_FAILED,
        "isYes is required for buy orders.",
      );
    }

    if (request.depositAmount == null) {
      throw new VexError(
        ErrorCodes.HTTP_REQUEST_FAILED,
        "depositAmount is required for buy orders.",
      );
    }

    if (!request.depositMint) {
      throw new VexError(
        ErrorCodes.HTTP_REQUEST_FAILED,
        "depositMint is required for buy orders.",
      );
    }

    return {
      ownerPubkey,
      marketId: assertNonEmptyString("marketId", request.marketId ?? ""),
      positionPubkey: request.positionPubkey
        ? validateSolanaAddress(request.positionPubkey)
        : undefined,
      isYes: request.isYes,
      isBuy: true,
      depositAmount: normalizePositiveIntegerString("depositAmount", request.depositAmount),
      depositMint: validateSolanaAddress(request.depositMint),
    };
  }

  if (request.positionPubkey == null) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      "positionPubkey is required for sell orders.",
    );
  }

  if (request.contracts == null) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      "contracts is required for sell orders.",
    );
  }

  if (request.depositAmount != null || request.depositMint != null) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      "depositAmount and depositMint are not supported for sell orders.",
    );
  }

  return {
    ownerPubkey,
    marketId: request.marketId ? assertNonEmptyString("marketId", request.marketId) : undefined,
    positionPubkey: validateSolanaAddress(request.positionPubkey),
    isYes: request.isYes,
    isBuy: false,
    contracts: normalizePositiveIntegerString("contracts", request.contracts),
  };
}

export function validateJupiterPredictionClosePositionRequest(
  request: JupiterPredictionClosePositionRequest,
): JupiterPredictionClosePositionRequest {
  return { ownerPubkey: normalizeOwnerPubkey(request.ownerPubkey) };
}

export function validateJupiterPredictionCloseAllPositionsRequest(
  request: JupiterPredictionCloseAllPositionsRequest,
): JupiterPredictionCloseAllPositionsRequest {
  assertIntegerInRange(
    "minSellPriceSlippageBps",
    request.minSellPriceSlippageBps,
    0,
    MIN_SELL_PRICE_SLIPPAGE_BPS_MAX,
  );
  return {
    ownerPubkey: normalizeOwnerPubkey(request.ownerPubkey),
    minSellPriceSlippageBps: request.minSellPriceSlippageBps,
  };
}

export function validateJupiterPredictionClaimPositionRequest(
  request: JupiterPredictionClaimPositionRequest,
): JupiterPredictionClaimPositionRequest {
  return { ownerPubkey: normalizeOwnerPubkey(request.ownerPubkey) };
}

export function validateJupiterPredictionExecuteRequest(
  request: JupiterPredictionExecuteRequest,
): JupiterPredictionExecuteRequest {
  if (!request.signedTransaction.trim()) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      "signedTransaction is required for /execute.",
    );
  }
  return request;
}
