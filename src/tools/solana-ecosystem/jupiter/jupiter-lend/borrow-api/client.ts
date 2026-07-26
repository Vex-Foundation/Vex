/**
 * Low-level Jupiter Lend Borrow REST client.
 * Source-of-truth for `/lend/v1/borrow/{vaults,positions,operate}` only.
 * `/operate-instructions` is deliberately excluded (owner decision, B1 card).
 */

import { fetchJson } from "../../../../../utils/http.js";
import {
  JUPITER_LEND_BORROW_API_BASE_URL,
  type JupiterLendBorrowOperateRequest,
  type JupiterLendBorrowOperateResponse,
  type JupiterLendBorrowPositionsParams,
  type JupiterLendBorrowPositionsResponse,
  type JupiterLendBorrowVaultsParams,
  type JupiterLendBorrowVaultsResponse,
} from "./types.js";
import {
  getJupiterLendBorrowHeaders,
  normalizeJupiterLendBorrowUsersQuery,
  validateJupiterLendBorrowMarket,
  validateJupiterLendBorrowOperateRequest,
} from "./validation.js";
import {
  jupiterLendBorrowOperateResponseSchema,
  jupiterLendBorrowPositionsResponseSchema,
  jupiterLendBorrowVaultsResponseSchema,
} from "./schemas.js";

function toQueryString(query: Record<string, string>): string {
  return new URLSearchParams(query).toString();
}

export async function jupiterLendBorrowVaults(
  params: JupiterLendBorrowVaultsParams = {},
): Promise<JupiterLendBorrowVaultsResponse> {
  const market = validateJupiterLendBorrowMarket(params.market);
  return fetchJson<JupiterLendBorrowVaultsResponse>(
    `${JUPITER_LEND_BORROW_API_BASE_URL}/vaults?${toQueryString({ market })}`,
    { headers: getJupiterLendBorrowHeaders() },
    jupiterLendBorrowVaultsResponseSchema,
  );
}

export async function jupiterLendBorrowPositions(
  params: JupiterLendBorrowPositionsParams,
): Promise<JupiterLendBorrowPositionsResponse> {
  const market = validateJupiterLendBorrowMarket(params.market);
  return fetchJson<JupiterLendBorrowPositionsResponse>(
    `${JUPITER_LEND_BORROW_API_BASE_URL}/positions?${toQueryString({
      users: normalizeJupiterLendBorrowUsersQuery(params.users),
      market,
    })}`,
    { headers: getJupiterLendBorrowHeaders() },
    jupiterLendBorrowPositionsResponseSchema,
  );
}

export async function jupiterLendBorrowOperateTransaction(
  request: JupiterLendBorrowOperateRequest,
  market?: string,
): Promise<JupiterLendBorrowOperateResponse> {
  const resolvedMarket = validateJupiterLendBorrowMarket(market);
  return fetchJson<JupiterLendBorrowOperateResponse>(
    `${JUPITER_LEND_BORROW_API_BASE_URL}/operate?${toQueryString({ market: resolvedMarket })}`,
    {
      method: "POST",
      headers: getJupiterLendBorrowHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(validateJupiterLendBorrowOperateRequest(request)),
    },
    jupiterLendBorrowOperateResponseSchema,
  );
}
