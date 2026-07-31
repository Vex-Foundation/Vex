/**
 * `trench.trade_execute` handler — curve BUY/SELL on Robinhood Chain (4663).
 *
 * Full money-path chain (recon §7): boundary validation (fee/limit/deadline/
 * recipient never from model input), address-only wallet resolve → signing
 * wallet → local EVM clients, a FRESH deterministic quote → Vex-derived minimum
 * output (never zero, absolute floor from our own quote) + LOCAL deadline, the
 * native-value gate on the payable buy, durable `agent_activity` intent BEFORE
 * any broadcast, then the staged sign→persist→broadcast loop with dependent-leg
 * anchoring on the sell's approve→sell ordering. Ambiguity never terminalizes
 * and is never re-broadcast; a reverted leg fails the row and aborts the rest;
 * a confirmed trade decodes POST-fee amounts, declining rather than guessing.
 */

import { parseUnits, formatUnits, formatEther, getAddress, type Address } from "viem";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalEvmClients } from "@tools/evm-chains/evm-client.js";
import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
  priorLegAnchorFrom,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { classifyPreSignRevert, preSignRefusalGuidance } from "@tools/evm-chains/pre-sign-revert-refusal.js";
import { readCurveQuote, readTokenDecimals, type TrenchTradeSide } from "@tools/trench-express/evm/curve-reader.js";
import { curveMinOut, curveTradeDeadline, TRENCH_MAX_SLIPPAGE_BPS } from "@tools/trench-express/evm/min-out.js";
import { decodeCurveBuy, decodeCurveSell } from "@tools/trench-express/evm/settlement.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "../../../internal/wallet/resolve.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  abortPlannedEvents,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import { VexError } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { ToolResult } from "../../../types.js";
import { fail } from "../../handler-helpers.js";
import { resolveTradeInputs } from "./trade/shared.js";
import { buildTradePlan, type TradeLegPlan } from "./trade/plan.js";
import { trenchFailureDetail } from "./failure.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;
const ETH_DECIMALS = 18;
const PROTOCOL = "trench";
const CHAIN_SLUG = "robinhood";
const TOOL_ID = "trench.trade_execute";

/** The ONE scrub boundary for provider/chain error text reaching a ToolResult. */
function safeDetail(err: unknown): string {
  return trenchFailureDetail(TOOL_ID, err);
}

async function abortRemaining(executionId: number, fromIndex: number, reason: string): Promise<void> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
  } catch (err) {
    logger.warn("trench.trade_execute.abort_failed", { executionId, fromIndex, error: safeDetail(err) });
  }
}

export async function trenchTradeExecuteHandler(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  if (params.dryRun === true) return fail(`${TOOL_ID} does not support dryRun — call trench.trade_quote instead.`);

  const resolved = resolveTradeInputs(params);
  if (!resolved.ok) return fail(resolved.reason);
  const { chainId, side, token, nativeAddress, amountInHuman, slippageBps } = resolved.value;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  // Address-only resolve FIRST (never decrypts) — so a later failure still
  // records the real wallet_address.
  let walletAddress: Address;
  try {
    walletAddress = getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"));
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const chainConfig = getLocalChain(chainId);
  if (!chainConfig) return fail(`Robinhood Chain (${chainId}) is not in the local chain registry.`);

  // Full signing wallet (decrypts) — only now that the call may broadcast.
  let signer;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
  const { publicClient, walletClient } = getLocalEvmClients(chainConfig, signer.privateKey);

  // ── Phase A (pre-intent): fresh quote → floor + plan + atomic intent ──
  let executionId: number;
  let events: readonly AgentActivityEvent[];
  let plans: TradeLegPlan[];
  let expectedOutRaw: bigint;
  let tokenDecimals: number;
  let amountInRaw: bigint;
  try {
    tokenDecimals = await readTokenDecimals(publicClient, token);
    amountInRaw = parseUnits(amountInHuman, side === "buy" ? ETH_DECIMALS : tokenDecimals);
    // FRESH, deterministic curve quote taken immediately before building the
    // floor — the ONLY input to `min`, never a caller number, never zero.
    expectedOutRaw = await readCurveQuote(publicClient, { token, side, amountInRaw });
    const minOut = curveMinOut(expectedOutRaw, slippageBps);
    const deadline = curveTradeDeadline();

    plans = buildTradePlan({
      side, chainId, token, nativeAddress, walletAddress, sessionId,
      amountInRaw, amountInHuman, tokenDecimals, expectedOutRaw, minOut, deadline,
    });

    const created = await createAgentActivityIntent({
      toolId: TOOL_ID,
      namespace: PROTOCOL,
      intentParams: params,
      events: plans.map((plan, i) => ({ ...plan.event, eventIndex: i })),
    });
    executionId = created.executionId;
    events = created.events;
  } catch (err) {
    return preBroadcastFailure(params, sessionId, walletAddress, chainId, side, token, nativeAddress, err);
  }

  // ── Phase B (post-intent): staged broadcast loop ──
  return runStagedLoop({ side, token, walletAddress, chainId, tokenDecimals, amountInHuman, amountInRaw, slippageBps, sessionId, executionId, events, plans, publicClient, walletClient });
}

interface StagedLoopInput {
  readonly side: TrenchTradeSide;
  readonly token: Address;
  readonly walletAddress: Address;
  readonly chainId: number;
  readonly tokenDecimals: number;
  readonly amountInHuman: string;
  readonly amountInRaw: bigint;
  readonly slippageBps: number;
  readonly sessionId: string;
  readonly executionId: number;
  readonly events: readonly AgentActivityEvent[];
  readonly plans: readonly TradeLegPlan[];
  // viem clients (typed loosely to avoid importing the full generic signature).
  readonly publicClient: Parameters<typeof signStageBroadcast>[0];
  readonly walletClient: Parameters<typeof signStageBroadcast>[1];
}

async function runStagedLoop(x: StagedLoopInput): Promise<ToolResult> {
  const { executionId, events, plans } = x;
  let currentIndex = 0;
  let priorLeg: ConfirmedPriorLeg | undefined;
  let legBroadcastAttempted = false;
  try {
    for (let i = 0; i < plans.length; i++) {
      currentIndex = i;
      legBroadcastAttempted = false;
      const plan = plans[i]!;
      const eventRow = events[i]!;
      const outcome: StagedBroadcastOutcome = await signStageBroadcast(
        x.publicClient, x.walletClient, plan.txParams,
        {
          onHashStaged: async (handles) => {
            legBroadcastAttempted = true;
            const res = await markActivityBroadcast(eventRow.id, handles);
            if (!res.applied) {
              throw new Error(`agent_activity: markActivityBroadcast CAS miss for event ${eventRow.id} — refusing to broadcast untracked`);
            }
          },
          onAccepted: async () => {
            const res = await markBroadcastAccepted(eventRow.id);
            if (!res.applied) logger.warn("trench.trade_execute.broadcast_accept_miss", { id: eventRow.id });
          },
        },
        priorLeg,
      );

      if (outcome.kind === "ambiguous") {
        logger.info("trench.trade_execute.ambiguous", { id: eventRow.id, stage: outcome.stage, txHash: outcome.txHash });
        await abortRemaining(executionId, i + 1, `earlier ${plan.eventRole} ambiguous`);
        return {
          success: false,
          output: `${TOOL_ID}: broadcast of the ${plan.eventRole} transaction (${outcome.txHash}) could not be confirmed yet — it may still settle. Do not retry; this attempt is recorded as pending and will resolve automatically. Verify with chain_read tx_receipt.`,
          data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
        };
      }

      if (outcome.kind === "reverted") {
        await failActivityEvent(eventRow.id, { failureCode: "mined_revert", failureReason: `the ${plan.eventRole} transaction reverted on-chain` });
        await abortRemaining(executionId, i + 1, `earlier ${plan.eventRole} reverted`);
        return {
          success: false,
          output: `${TOOL_ID}: the ${plan.eventRole} transaction (${outcome.txHash}) reverted on-chain. No further steps were attempted.`,
          data: { _executionId: executionId, txHash: outcome.txHash, status: "reverted" },
        };
      }

      // confirmed
      priorLeg = priorLegAnchorFrom(outcome.receipt.blockNumber);
      if (plan.eventRole !== "swap") {
        try {
          await confirmActivityEvent(eventRow.id, {});
        } catch (err) {
          logger.warn("trench.trade_execute.confirm_failed", { id: eventRow.id, role: plan.eventRole, error: safeDetail(err) });
        }
        continue;
      }

      return finalizeConfirmedSwap(x, eventRow.id, outcome.txHash, outcome.receipt.logs.map((l) => ({ address: l.address, topics: l.topics as string[], data: l.data })));
    }
    throw new Error(`${TOOL_ID}: staged broadcast loop exited without a result`);
  } catch (err) {
    return await handlePostIntentFailure(x, currentIndex, legBroadcastAttempted, err);
  }
}

async function finalizeConfirmedSwap(
  x: StagedLoopInput,
  eventId: number,
  txHash: string,
  logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>,
): Promise<ToolResult> {
  const { side, token, walletAddress, chainId, tokenDecimals, amountInHuman, amountInRaw, executionId } = x;

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
    const decoded = decodeCurveBuy({ logs, diamond: DIAMOND, wallet: walletAddress, token });
    if (!decoded) {
      // Confirmed on-chain but the acquired amount is undecodable now — leave
      // the row pending for the repair sweep; NEVER assert an amount.
      return confirmedPendingAmounts(executionId, txHash, "the acquired token amount could not be decoded yet");
    }
    outRaw = decoded.tokensOutRaw;
    inputTokenLabel = "ETH";
    outputTokenLabel = token;
  } else {
    const decoded = decodeCurveSell({ logs, diamond: DIAMOND, wallet: walletAddress, token, amountInRaw });
    // FIX 1 (rule 90): the ETH proceeds are executed truth ONLY when the Sold
    // token-leg cross-check proved the positional mapping. When it declines, the
    // input (tokens) is executed but the OUTPUT (ETH) is UNKNOWN — surface it as
    // pending, NEVER the quote estimate, and leave the row for the repair sweep.
    if (!decoded || decoded.ethOutRaw === null) {
      logger.info("trench.trade_execute.sell_eth_out_pending", { executionId, txHash });
      return confirmedPendingAmounts(executionId, txHash, "the ETH proceeds could not be decoded yet");
    }
    outRaw = decoded.ethOutRaw;
    inputTokenLabel = token;
    outputTokenLabel = "ETH";
  }

  const outputHuman = side === "buy" ? formatUnits(outRaw, tokenDecimals) : formatEther(outRaw);
  // FIX 4: a non-applied CAS confirm (the reconciler already finalized this row)
  // must not read as a clean "confirmed".
  const confirmWriteFailed = await confirmSwapRow(eventId, {
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
  return { success: true, output: JSON.stringify(successData), data: successData };
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

function confirmedPendingAmounts(executionId: number, txHash: string, why: string): ToolResult {
  return {
    success: true,
    output: `${TOOL_ID}: trade confirmed on-chain (tx ${txHash}) but ${why} — check the transaction hash for the exact amounts.`,
    data: { _executionId: executionId, txHash, status: "confirmed_pending_amounts" },
  };
}

async function handlePostIntentFailure(
  x: StagedLoopInput,
  currentIndex: number,
  legBroadcastAttempted: boolean,
  err: unknown,
): Promise<ToolResult> {
  const { executionId, events, plans } = x;
  const safeMessage = safeDetail(err);
  const refusedRole = plans[currentIndex]?.eventRole ?? "swap";
  // Finalize the refused leg with its real code (best-effort), then abort the
  // rest — before returning, so a failed row can never strand as pending.
  const preSignForRow = legBroadcastAttempted ? null : classifyPreSignRevert(err);
  if (preSignForRow && events[currentIndex]) {
    try {
      await failActivityEvent(events[currentIndex]!.id, { failureCode: preSignForRow.failureCode, failureReason: `refused before signing: ${safeDetail(preSignForRow.revertReason)}` });
    } catch { /* best-effort */ }
  }
  await abortRemaining(executionId, currentIndex, safeMessage);

  if (err instanceof DependentLegGasEstimateError) {
    return {
      success: false,
      output: `${TOOL_ID}: the ${refusedRole} step could not be gas-estimated, so it was refused before signing. ${dependentLegEstimateGuidance(err)} Recorded as execution ${executionId}; nothing was signed for it.`,
      data: { _executionId: executionId, status: "not_attempted", retryable: true },
    };
  }
  const preSign = legBroadcastAttempted ? null : classifyPreSignRevert(err);
  if (preSign) {
    return {
      success: false,
      output: `${TOOL_ID}: the ${refusedRole} step was refused before signing. ${preSignRefusalGuidance({ revertReason: safeDetail(preSign.revertReason), failureCode: preSign.failureCode, slippage: { appliedBps: x.slippageBps, maxBps: TRENCH_MAX_SLIPPAGE_BPS } })} Recorded as execution ${executionId}.`,
      data: { _executionId: executionId, status: "not_attempted", retryable: true, failureCode: preSign.failureCode },
    };
  }
  return {
    success: false,
    output: `${TOOL_ID}: an internal error interrupted the trade after it was recorded — ${safeMessage}. Check the record (execution ${executionId}) before any further action.`,
    data: { _executionId: executionId, status: "pending" },
  };
}

async function preBroadcastFailure(
  params: Record<string, unknown>,
  sessionId: string,
  walletAddress: Address,
  chainId: number,
  side: TrenchTradeSide,
  token: Address,
  nativeAddress: Address,
  err: unknown,
): Promise<ToolResult> {
  const failureReason = safeDetail(err);
  const failureCode = err instanceof VexError ? "simulation_reverted" : "unknown";
  const tokenIn = side === "buy" ? { tokenAddress: nativeAddress, tokenSymbol: "ETH" } : { tokenAddress: token };
  const tokenOut = side === "buy" ? { tokenAddress: token } : { tokenAddress: nativeAddress, tokenSymbol: "ETH" };
  try {
    const { executionId } = await createAgentActivityPreBroadcastFailure({
      toolId: TOOL_ID,
      namespace: PROTOCOL,
      intentParams: params,
      event: { eventIndex: 0, eventRole: "swap", kind: "swap", protocol: PROTOCOL, chainId, chainSlug: CHAIN_SLUG, walletAddress, sessionId, tokenIn, tokenOut, failureCode, failureReason },
    });
    return { success: false, output: `${TOOL_ID} failed: ${failureReason}.`, data: { _executionId: executionId } };
  } catch (writeErr) {
    logger.warn("trench.trade_execute.pre_broadcast_write_failed", { error: safeDetail(writeErr) });
    return fail(`${TOOL_ID} failed: ${failureReason}.`);
  }
}
