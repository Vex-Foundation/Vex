/**
 * Pendle late-fill adapter — the venue decoder owns the per-role rules
 * (including second legs and router-fallback SY matching). This file only
 * wraps logs as a receipt and forwards the row's own columns.
 */
import { decodePendleSettlement } from "../pendle-settlement-decoder.js";

import type { VenueDecodeInput, VenueDecodeResult } from "./venue-dispatch.js";

export function decodePendleRow(input: VenueDecodeInput): VenueDecodeResult {
  const { row } = input;
  if (!row.walletAddress) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: "the row carries no wallet address",
    };
  }

  const decoded = decodePendleSettlement({
    receipt: { logs: input.logs },
    protocolExecutionId: row.protocolExecutionId,
    chainId: row.chainId,
    walletAddress: row.walletAddress,
    tokenInAddress: row.tokenInAddress,
    tokenOutAddress: row.tokenOutAddress,
    eventRole: row.eventRole,
    tokenIn2Address: row.tokenIn2Address,
    tokenOut2Address: row.tokenOut2Address,
    amountInRaw: row.amountInRaw,
    routeProvenance: row.routeProvenance,
  });

  if (decoded === null) {
    return {
      kind: "declined",
      reason: "amounts_undecodable",
      detail: `the pendle decoder could not prove the executed legs for role ${row.eventRole}`,
    };
  }

  const amounts = {
    ...(decoded.executedAmountInRaw !== undefined ? { executedAmountInRaw: decoded.executedAmountInRaw } : {}),
    ...(decoded.executedAmountOutRaw !== undefined ? { executedAmountOutRaw: decoded.executedAmountOutRaw } : {}),
    ...(decoded.executedAmountIn2Raw !== undefined ? { executedAmountIn2Raw: decoded.executedAmountIn2Raw } : {}),
    ...(decoded.executedAmountOut2Raw !== undefined ? { executedAmountOut2Raw: decoded.executedAmountOut2Raw } : {}),
  };
  return { kind: "decoded", amounts };
}
