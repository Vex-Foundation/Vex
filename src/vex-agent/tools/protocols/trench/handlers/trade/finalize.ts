/**
 * Finalizing a CONFIRMED Trench curve swap: decode what the transaction really
 * moved, write the executed amounts onto the `swap` row, and build the agent's
 * result.
 *
 * The decode DECLINES rather than guesses (rule 90). A confirmed buy whose
 * `Bought` log cannot be read, and a confirmed sell whose ETH proceeds the
 * `Sold` cross-check could not prove, both return `confirmed_pending_amounts`
 * and leave the row for the repair sweep — the quote estimate is NEVER
 * presented as a settlement.
 */

import { formatUnits, formatEther, type Address } from "viem";

import { decodeCurveBuy, decodeCurveSell } from "@tools/trench-express/evm/settlement.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import { confirmActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../../types.js";
import type { TrenchTradeSide } from "@tools/trench-express/evm/curve-reader.js";
import { CHAIN_SLUG, DIAMOND, TOOL_ID, safeDetail } from "./execute-identity.js";

export interface FinalizeConfirmedSwapInput {
  readonly side: TrenchTradeSide;
  readonly token: Address;
  readonly walletAddress: Address;
  readonly chainId: number;
  readonly tokenDecimals: number;
  readonly amountInHuman: string;
  readonly amountInRaw: bigint;
  readonly executionId: number;
  readonly eventId: number;
  readonly txHash: string;
  readonly logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>;
}

/**
 * The result, plus the ETH the sell actually produced.
 *
 * `ethOutRaw` is the Vex fee's charge base on a SELL and is EXECUTED TRUTH: it
 * is non-null only when the `Sold` cross-check proved the positional mapping.
 * `null` (a buy, or a declined decode) means the fee has no base it can prove,
 * and the caller must skip the fee rather than charge 25 bps of a quote.
 */
export interface FinalizeConfirmedSwapOutcome {
  readonly result: ToolResult;
  readonly ethOutRaw: bigint | null;
}

export async function finalizeConfirmedSwap(x: FinalizeConfirmedSwapInput): Promise<FinalizeConfirmedSwapOutcome> {
  const { side, token, walletAddress, chainId, tokenDecimals, amountInHuman, amountInRaw, executionId, txHash } = x;

  // Auto-pin the ACQUIRED token (buy only) — fail-soft, BEFORE decode, so a
  // confirmed-but-undecodable buy still gets tracked.
  if (side === "buy") {
    try {
      await pinTrackedToken({ walletAddress, chainId, tokenAddress: token, source: "swap" });
    } catch (err) {
      logger.warn("trench.trade_execute.auto_pin_failed", { error: err instanceof Error ? err.name : "unknown" });
    }
  }

  let outRaw: bigint;
  let inputTokenLabel: string;
  let outputTokenLabel: string;
  if (side === "buy") {
    const decoded = decodeCurveBuy({ logs: x.logs, diamond: DIAMOND, wallet: walletAddress, token });
    if (!decoded) {
      // Confirmed on-chain but the acquired amount is undecodable now — leave
      // the row pending for the repair sweep; NEVER assert an amount.
      return { result: confirmedPendingAmounts(executionId, txHash, "the acquired token amount could not be decoded yet"), ethOutRaw: null };
    }
    outRaw = decoded.tokensOutRaw;
    inputTokenLabel = "ETH";
    outputTokenLabel = token;
  } else {
    const decoded = decodeCurveSell({ logs: x.logs, diamond: DIAMOND, wallet: walletAddress, token, amountInRaw });
    // FIX 1 (rule 90): the ETH proceeds are executed truth ONLY when the Sold
    // token-leg cross-check proved the positional mapping. When it declines, the
    // input (tokens) is executed but the OUTPUT (ETH) is UNKNOWN — surface it as
    // pending, NEVER the quote estimate, and leave the row for the repair sweep.
    if (!decoded || decoded.ethOutRaw === null) {
      logger.info("trench.trade_execute.sell_eth_out_pending", { executionId, txHash });
      return { result: confirmedPendingAmounts(executionId, txHash, "the ETH proceeds could not be decoded yet"), ethOutRaw: null };
    }
    outRaw = decoded.ethOutRaw;
    inputTokenLabel = token;
    outputTokenLabel = "ETH";
  }

  const outputHuman = side === "buy" ? formatUnits(outRaw, tokenDecimals) : formatEther(outRaw);
  // FIX 4: a non-applied CAS confirm (the reconciler already finalized this row)
  // must not read as a clean "confirmed".
  const confirmWriteFailed = await confirmSwapRow(x.eventId, {
    inRaw: amountInRaw.toString(),
    inHuman: amountInHuman,
    outRaw: outRaw.toString(),
    outHuman: outputHuman,
  });

  const status = confirmWriteFailed ? "confirmed_unrecorded" : "confirmed";
  const tradeCapture = {
    type: side,
    chain: CHAIN_SLUG,
    signature: txHash,
    status: "executed",
    inputToken: inputTokenLabel,
    inputAmount: amountInHuman,
    outputToken: outputTokenLabel,
    outputAmount: outputHuman,
    walletAddress,
  };
  const summary = `${side === "buy" ? "Bought" : "Sold"} on Robinhood Chain: ${amountInHuman} ${inputTokenLabel} → ${outputHuman} ${outputTokenLabel}. Tx: ${txHash}`;
  const successData = {
    summary,
    chain: CHAIN_SLUG,
    chainId,
    txHash,
    side,
    inputToken: inputTokenLabel,
    outputToken: outputTokenLabel,
    inputAmount: amountInHuman,
    outputAmount: outputHuman,
    status,
    _executionId: executionId,
    _tradeCapture: tradeCapture,
  };
  return {
    result: { success: true, output: JSON.stringify(successData), data: successData },
    ethOutRaw: side === "sell" ? outRaw : null,
  };
}

/**
 * Confirm the swap row's executed amounts. Returns `true` when the write did NOT
 * land as a fresh CAS-applied confirmation — a throw, or a CAS miss that is not a
 * benign already-confirmed-with-the-same-amounts race — so the caller can report
 * `confirmed_unrecorded` instead of a clean confirm (mirrors the swap venues).
 */
async function confirmSwapRow(
  eventId: number,
  amounts: { inRaw: string; inHuman: string; outRaw: string; outHuman: string },
): Promise<boolean> {
  try {
    const result = await confirmActivityEvent(eventId, {
      executedAmountInHuman: amounts.inHuman,
      executedAmountInRaw: amounts.inRaw,
      executedAmountOutHuman: amounts.outHuman,
      executedAmountOutRaw: amounts.outRaw,
    });
    if (result.applied) return false;
    const alreadyMatches =
      result.row.status === "confirmed"
      && result.row.executedAmountInRaw === amounts.inRaw
      && result.row.executedAmountOutRaw === amounts.outRaw;
    if (!alreadyMatches) {
      logger.warn("trench.trade_execute.confirm_cas_miss", { id: eventId, rowStatus: result.row.status });
      return true;
    }
    return false;
  } catch (err) {
    logger.warn("trench.trade_execute.confirm_swap_failed", { id: eventId, error: safeDetail(err) });
    return true;
  }
}

export function confirmedPendingAmounts(executionId: number, txHash: string, why: string): ToolResult {
  return {
    success: true,
    output: `${TOOL_ID}: trade confirmed on-chain (tx ${txHash}) but ${why} — check the transaction hash for the exact amounts.`,
    data: { _executionId: executionId, txHash, status: "confirmed_pending_amounts" },
  };
}
