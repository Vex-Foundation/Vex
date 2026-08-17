/**
 * The BLUE MARKET operation leg: re-prove the position is still safe, rebuild
 * against state as it now is, send, and turn the receipt into recorded truth.
 *
 * The sibling of `./operation-leg.ts`, and it exists rather than a shared
 * parameterised version because the two answer different questions after the
 * receipt lands. A vault operation compares SHARES against an approved bound. A
 * market operation has no shares the user holds, and instead must prove which of
 * four Blue events fired and which way the wallet's own leg pointed. Collapsing
 * those into one function would mean a branch on the lane in every paragraph.
 *
 * ── THE PRE-SEND HEALTH-FACTOR GATE, WHICH IS THE WHOLE REASON FOR PHASE 2 ──
 *
 * `assertMorphoBorrowStillSafe` runs immediately before the signature, not at
 * plan time. Between the plan and this moment the market accrues interest and
 * the oracle moves, and a borrow that cleared the 1.25 floor when it was planned
 * can breach it by the time it would be signed. Morpho has NO close factor, so a
 * liquidation takes the whole position: the floor is policy, not advice, and the
 * only check that means anything is the last one before sending.
 *
 * A REFUSAL HERE COSTS NOTHING. It happens before a signature exists, so the
 * only thing lost is an approval that may already stand, which the residual
 * sentence names.
 *
 * A CONFIRMED OPERATION IS NEVER UNDONE BY BOOKKEEPING. Once the receipt is
 * successful the funds have moved; from that line on every write is fail-soft.
 */

import { formatUnits } from "viem";
import type { Address, Hex } from "viem";

import { assertMorphoBorrowStillSafe } from "@tools/morpho/mutations.js";
import { confirmActivityEvent, failActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import {
  decodeMorphoBorrowSettlement,
  type MorphoBorrowDecodeProvenance,
} from "@vex-agent/sync/morpho-settlement-decoder.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

import { morphoFailureDetail } from "../shared.js";
import { broadcastMorphoLeg, finalizeMorphoFailSoft, noteMorphoSettledBlockTime } from "./leg-broadcast.js";
import { MORPHO_BORROW_OPERATE_ROLE } from "./protocol.js";
import {
  MORPHO_AMBIGUOUS_BROADCAST_MESSAGE,
  morphoUndecodableMessage,
  withResidual,
  type MorphoExecutionOutcome,
} from "./outcome.js";
import type { MorphoMarketExecutionContext } from "./market-context.js";

const ROLE = MORPHO_BORROW_OPERATE_ROLE;

/** Rebuild the operation against current state, or refuse by name. */
async function rebuild(context: MorphoMarketExecutionContext): Promise<{ to: Address; data: Hex; value: bigint }> {
  const rebuilt = await context.rebuild();
  if (rebuilt.to.toLowerCase() !== context.verifiedTarget.toLowerCase()) {
    throw new Error(
      `the rebuilt ${context.operationLabel} targets ${rebuilt.to.toLowerCase()}, not the `
      + `${context.verifiedTarget.toLowerCase()} this execution was planned and recorded against`,
    );
  }
  // THE REBUILD IS BOUND BY THE APPROVAL THAT ALREADY LANDED, found on the fork
  // 2026-08-17. A repayment denominated in SHARES sizes its pull from accrued
  // state, so the rebuild asks for slightly MORE than phase 1 approved and the
  // transaction would revert on the allowance. Refusing here costs a
  // pre-signature stop; signing it would cost gas to discover the same thing.
  if (rebuilt.pullAmountRaw !== null && rebuilt.pullAmountRaw > context.approvalAmountRaw) {
    throw new Error(
      `the rebuilt ${context.operationLabel} would pull ${rebuilt.pullAmountRaw} raw units, more than the `
      + `${context.approvalAmountRaw} this execution approved. Interest accrued between the approval and now, so `
      + "the standing allowance no longer covers the operation. Re-run it to approve the current amount",
    );
  }
  return rebuilt;
}

export async function runMarketOperationLeg(
  context: MorphoMarketExecutionContext,
): Promise<MorphoExecutionOutcome> {
  const { toolId } = context.request;
  const row = context.events[context.operationLegIndex]!;

  // PHASE 2. The floor is re-checked against freshly accrued state, then the
  // transaction is rebuilt and re-asserted against the recorded target. Every
  // throw below is PRE-SIGNATURE.
  let txParams: { to: Address; data: Hex; value: bigint };
  try {
    await assertMorphoBorrowStillSafe(context.clients.actionClient, context.market, context.intent);
    txParams = await rebuild(context);
  } catch (err) {
    await finalizeMorphoFailSoft(toolId, () =>
      failActivityEvent(row.id, {
        failureCode: "unknown",
        failureReason: `${toolId}: refused before signing - ${morphoFailureDetail(err)}`,
      }),
    );
    return {
      kind: "refused",
      executionId: context.executionId,
      role: ROLE,
      message: withResidual(
        `${toolId}: the ${context.operationLabel} was refused before anything was signed - `
        + `${morphoFailureDetail(err)}. No transaction was sent and no gas was spent on it.`,
        context.residual,
      ),
    };
  }

  let outcome;
  try {
    outcome = await broadcastMorphoLeg({
      toolId,
      publicClient: context.clients.publicClient,
      walletClient: context.clients.walletClient,
      eventId: row.id,
      txParams,
      ...(context.priorLeg === undefined ? {} : { priorLeg: context.priorLeg }),
    });
  } catch (err) {
    await finalizeMorphoFailSoft(toolId, () =>
      failActivityEvent(row.id, {
        failureCode: "unknown",
        failureReason: `${toolId}: refused before signing - ${morphoFailureDetail(err)}`,
      }),
    );
    return {
      kind: "refused",
      executionId: context.executionId,
      role: ROLE,
      message: withResidual(
        `${toolId}: the ${context.operationLabel} was refused before anything was signed - `
        + `${morphoFailureDetail(err)}. No transaction was sent and no gas was spent on it.`,
        context.residual,
      ),
    };
  }

  if (outcome.kind === "ambiguous") {
    logger.info("morpho.activity.ambiguous", { id: row.id, toolId, stage: outcome.stage });
    await noteHandlerPendingReason(
      toolId, row.id,
      outcome.stage === "send" ? "broadcast_ambiguous_send" : "broadcast_ambiguous_confirm",
    );
    return {
      kind: "unproven",
      executionId: context.executionId,
      role: ROLE,
      reason: "ambiguous",
      txHash: outcome.txHash,
      message: withResidual(
        `${toolId}: the ${context.operationLabel} broadcast (${outcome.txHash}) could not be confirmed. `
        + MORPHO_AMBIGUOUS_BROADCAST_MESSAGE,
        context.residual,
      ),
    };
  }

  if (outcome.kind === "reverted") {
    await finalizeMorphoFailSoft(toolId, () =>
      failActivityEvent(row.id, {
        failureCode: "mined_revert",
        failureReason: `${toolId}: the ${context.operationLabel} reverted on-chain.`,
      }),
    );
    return {
      kind: "reverted",
      executionId: context.executionId,
      role: ROLE,
      txHash: outcome.txHash,
      message: withResidual(
        `${toolId}: the ${context.operationLabel} (${outcome.txHash}) reverted on-chain. No funds moved beyond the `
        + "gas spent.",
        context.residual,
      ),
    };
  }

  // Mined successfully. The funds HAVE moved; a bookkeeping throw from here on
  // must never be reported to the agent as the operation having failed.
  const provenance: MorphoBorrowDecodeProvenance = {
    operation: context.intent.operation,
    marketId: context.intent.market.marketId,
    blueAddress: context.blueAddress,
  };
  const decoded = decodeMorphoBorrowSettlement({
    logs: outcome.receipt.logs.map((log) => ({ address: log.address, topics: [...log.topics], data: log.data })),
    walletAddress: context.request.walletAddress.toLowerCase(),
    provenance,
    amountInRaw: context.leg.direction === "in" ? context.leg.amountRaw : null,
    amountOutRaw: context.leg.direction === "out" ? context.leg.amountRaw : null,
  });

  await noteMorphoSettledBlockTime(context.clients.publicClient, row.id, outcome.receipt);

  if (decoded.kind === "declined") {
    // THE RECEIPT LANDED AND COULD NOT BE READ. The row stays pending and the
    // repair sweep owns it. The agent is told the REAL reason, not a shrug.
    logger.info("morpho.activity.undecodable", { id: row.id, toolId, reason: decoded.reason });
    await noteHandlerPendingReason(toolId, row.id, "settlement_undecodable");
    return {
      kind: "unproven",
      executionId: context.executionId,
      role: ROLE,
      reason: "undecodable",
      txHash: outcome.txHash,
      message: withResidual(
        `${morphoUndecodableMessage(outcome.txHash)} The decoder declined because ${decoded.reason}.`,
        context.residual,
      ),
    };
  }

  const { decimals, tokenSymbol } = context.leg;
  const executedRaw = decoded.executedAmountRaw;
  const executedHuman = formatUnits(BigInt(executedRaw), decimals);
  const zero = { raw: "0", human: formatUnits(0n, decimals) };
  const movedIn = decoded.direction === "in";

  await finalizeMorphoFailSoft(toolId, () =>
    confirmActivityEvent(row.id, {
      ...(movedIn
        ? { executedAmountInRaw: executedRaw, executedAmountInHuman: executedHuman }
        : { executedAmountOutRaw: executedRaw, executedAmountOutHuman: executedHuman }),
    }),
  );

  return {
    kind: "confirmed",
    executionId: context.executionId,
    txHash: outcome.txHash,
    executed: {
      amountInRaw: movedIn ? executedRaw : zero.raw,
      amountInHuman: movedIn ? executedHuman : zero.human,
      amountOutRaw: movedIn ? zero.raw : executedRaw,
      amountOutHuman: movedIn ? zero.human : executedHuman,
    },
    // ONE token, one direction. The absent side stays null rather than being
    // mirrored: a second leg here would claim a movement that never happened.
    tokens: movedIn
      ? {
        inSymbol: tokenSymbol,
        inAddress: context.leg.tokenAddress.toLowerCase(),
        inDecimals: decimals,
        outSymbol: null,
        outAddress: null,
        outDecimals: null,
      }
      : {
        inSymbol: null,
        inAddress: null,
        inDecimals: null,
        outSymbol: tokenSymbol,
        outAddress: context.leg.tokenAddress.toLowerCase(),
        outDecimals: decimals,
      },
    // A Blue market operation mints and burns no shares the user holds, so there
    // is no shares comparison to report rather than a fabricated one.
    shares: null,
    message:
      `${toolId}: the ${context.operationLabel} settled. The receipt proves ${executedHuman} `
      + `${tokenSymbol ?? "raw units"} ${movedIn ? "left" : "reached"} the wallet (tx ${outcome.txHash}).`,
  };
}
