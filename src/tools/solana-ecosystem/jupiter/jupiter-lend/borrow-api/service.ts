/**
 * High-level Jupiter Lend Borrow REST service.
 * Thin wrappers over `./client.ts` — preserves full wire responses.
 */

import {
  jupiterLendBorrowOperateTransaction,
  jupiterLendBorrowPositions,
  jupiterLendBorrowVaults,
} from "./client.js";
import type {
  JupiterLendBorrowMarket,
  JupiterLendBorrowOperateRequest,
  JupiterLendBorrowOperateResponse,
  JupiterLendBorrowPositionsResponse,
  JupiterLendBorrowVaultsResponse,
} from "./types.js";

export async function getJupiterLendBorrowVaults(
  market?: JupiterLendBorrowMarket,
): Promise<JupiterLendBorrowVaultsResponse> {
  return jupiterLendBorrowVaults({ market });
}

export async function getJupiterLendBorrowPositions(
  users: string | string[],
  market?: JupiterLendBorrowMarket,
): Promise<JupiterLendBorrowPositionsResponse> {
  return jupiterLendBorrowPositions({ users: Array.isArray(users) ? users : [users], market });
}

/**
 * Request the unsigned `/operate` transaction only — never signs or sends.
 * The Vex-side agent-param → signed-delta translation lives in
 * `../../../../vex-agent/tools/protocols/solana-jupiter/borrow-operate-params.ts`;
 * this function is the thin transport for the already-resolved request.
 */
export async function requestJupiterLendBorrowOperateTransaction(
  request: JupiterLendBorrowOperateRequest,
  market?: JupiterLendBorrowMarket,
): Promise<JupiterLendBorrowOperateResponse> {
  return jupiterLendBorrowOperateTransaction(request, market);
}
