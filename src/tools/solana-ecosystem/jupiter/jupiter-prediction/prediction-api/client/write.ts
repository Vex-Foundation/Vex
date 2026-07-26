/**
 * Jupiter Prediction API — POST/DELETE endpoints (write operations).
 */

import { fetchJson } from "../../../../../../utils/http.js";
import { JUPITER_PREDICTION_API_BASE_URL } from "../../constants.js";
import type {
  JupiterPredictionCreateOrderRequest,
  JupiterPredictionCreateOrderResponse,
  JupiterPredictionClosePositionRequest,
  JupiterPredictionCloseAllPositionsRequest,
  JupiterPredictionCloseAllPositionsResponse,
  JupiterPredictionClaimPositionRequest,
  JupiterPredictionClaimPositionResponse,
  JupiterPredictionExecuteRequest,
  JupiterPredictionExecuteResponse,
} from "../types.js";
import {
  getJupiterPredictionHeaders,
  requireJupiterPredictionApiKey,
  validateJupiterPredictionCreateOrderRequest,
  validateJupiterPredictionClosePositionRequest,
  validateJupiterPredictionCloseAllPositionsRequest,
  validateJupiterPredictionClaimPositionRequest,
  validateJupiterPredictionExecuteRequest,
  validateJupiterPredictionPositionParams,
} from "../validation.js";
import {
  jupiterPredictionCreateOrderResponseSchema,
  jupiterPredictionCloseAllPositionsResponseSchema,
  jupiterPredictionClaimPositionResponseSchema,
  jupiterPredictionExecuteResponseSchema,
} from "../schemas.js";

export async function jupiterPredictionCreateOrder(
  request: JupiterPredictionCreateOrderRequest,
): Promise<JupiterPredictionCreateOrderResponse> {
  requireJupiterPredictionApiKey();

  return fetchJson<JupiterPredictionCreateOrderResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/orders`,
    {
      method: "POST",
      headers: getJupiterPredictionHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(validateJupiterPredictionCreateOrderRequest(request)),
    },
    jupiterPredictionCreateOrderResponseSchema,
  );
}

export async function jupiterPredictionClosePosition(
  positionPubkey: string,
  request: JupiterPredictionClosePositionRequest,
): Promise<JupiterPredictionCreateOrderResponse> {
  requireJupiterPredictionApiKey();
  const validatedPosition = validateJupiterPredictionPositionParams({ positionPubkey });

  return fetchJson<JupiterPredictionCreateOrderResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/positions/${validatedPosition.positionPubkey}`,
    {
      method: "DELETE",
      headers: getJupiterPredictionHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(validateJupiterPredictionClosePositionRequest(request)),
    },
    jupiterPredictionCreateOrderResponseSchema,
  );
}

export async function jupiterPredictionCloseAllPositions(
  request: JupiterPredictionCloseAllPositionsRequest,
): Promise<JupiterPredictionCloseAllPositionsResponse> {
  requireJupiterPredictionApiKey();

  return fetchJson<JupiterPredictionCloseAllPositionsResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/positions`,
    {
      method: "DELETE",
      headers: getJupiterPredictionHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(validateJupiterPredictionCloseAllPositionsRequest(request)),
    },
    jupiterPredictionCloseAllPositionsResponseSchema,
  );
}

/**
 * `POST /execute` — managed execution for a Jupiter Prediction order
 * (keeper-filled AND Forecast; see `managed-execution.ts`). The ONLY intended caller is
 * `prediction-api/submit-managed-execute.ts` (staged-seam submit step,
 * mirroring `jupiter-swaps/submit-prepared-tx.ts`'s `/tx/v1/submit` role).
 */
export async function jupiterPredictionExecute(
  request: JupiterPredictionExecuteRequest,
): Promise<JupiterPredictionExecuteResponse> {
  requireJupiterPredictionApiKey();

  return fetchJson<JupiterPredictionExecuteResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/execute`,
    {
      method: "POST",
      headers: getJupiterPredictionHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(validateJupiterPredictionExecuteRequest(request)),
    },
    jupiterPredictionExecuteResponseSchema,
  );
}

export async function jupiterPredictionClaimPosition(
  positionPubkey: string,
  request: JupiterPredictionClaimPositionRequest,
): Promise<JupiterPredictionClaimPositionResponse> {
  requireJupiterPredictionApiKey();
  const validatedPosition = validateJupiterPredictionPositionParams({ positionPubkey });

  return fetchJson<JupiterPredictionClaimPositionResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/positions/${validatedPosition.positionPubkey}/claim`,
    {
      method: "POST",
      headers: getJupiterPredictionHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(validateJupiterPredictionClaimPositionRequest(request)),
    },
    jupiterPredictionClaimPositionResponseSchema,
  );
}
