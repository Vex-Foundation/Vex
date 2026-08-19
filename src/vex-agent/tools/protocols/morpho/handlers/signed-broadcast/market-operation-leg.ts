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

import { assertMorphoBorrowStillSafe, assertMorphoMarketExecutable } from "@tools/morpho/mutations.js";
import { confirmActivityEvent, failActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import {
  decodeMorphoBorrowSettlement,
  type MorphoBorrowDecodeProvenance,
} from "@vex-agent/sync/morpho-settlement-decoder.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

import { morphoFailureDetail } from "../shared.js";
import { broadcastMorphoLeg, finalizeMorphoFailSoft, noteMorphoSettledBlockTime } from "./leg-broadcast.js";
import { morphoMarketOperationRole } from "./protocol.js";
import { morphoPreSignDetail } from "./post-approval-preflight.js";
import {
  MORPHO_AMBIGUOUS_BROADCAST_MESSAGE,
  morphoUndecodableMessage,
  withResidual,
  type MorphoExecutionOutcome,
} from "./outcome.js";
import type { MorphoMarketExecutionContext } from "./market-context.js";

/**
 * The role THIS row was actually written under, which is not constant: the
 * lender's supply and withdraw file under `lend_deposit` / `lend_withdraw` while
 * the borrower's four file under `lend_borrow_operate`. It is reported back to
 * the agent, so a hard-coded value would put a wrong label on a money-path
 * result. `./protocol.ts` owns the mapping and `./borrow-intent.ts` writes the
 * row from the same function.
 */
function roleOf(context: MorphoMarketExecutionContext) {
  return morphoMarketOperationRole(context.intent.operation);
}

/**
 * RE-RUN THE WHOLE MARKET GATE, immediately before the signature.
 *
 * Phase 1 gated the market before the approval was sent. On an
 * approve-then-operate path that is one transaction and a confirmation earlier
 * than this moment, and the gate's own claim is that curation and feed liveness
 * are read AT EXECUTION TIME. Without this the claim was true of the approval
 * and merely inherited by the operation: a market delisted, or a price feed gone
 * silent, in the seconds between them would have been signed against on the
 * strength of a check that had already expired.
 *
 * It re-reads the market's parameters from `context.market`, which phase 1 read
 * off Blue and proved hash to the requested id, so what is re-asked here is the
 * part that can change: does Morpho still curate it, is the oracle still one Vex
 * accepts for THIS market, and is every price leg still answering.
 */
async function assertMorphoMarketStillExecutable(context: MorphoMarketExecutionContext): Promise<void> {
  const { marketParams, identity } = context.market;
  await assertMorphoMarketExecutable(context.clients.actionClient, identity.chainId, identity.marketId, {
    loanToken: marketParams.loanToken,
    collateralToken: marketParams.collateralToken,
    oracle: marketParams.oracle,
    irm: marketParams.irm,
    lltv: marketParams.lltv,
  });
}

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
    await assertMorphoMarketStillExecutable(context);
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
      role: roleOf(context),
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
    // THE PRE-SIGN GAS ESTIMATE IS THIS LANE'S STALE-NODE EXPOSURE. It has no
    // simulation of its own, so the read-after-write lag that made the vault
    // deposit refuse on its own landed approval (audit 2026-08-18, D1) arrives
    // here through `estimateGasForPlanLeg` instead. That check already retries
    // against the approval's block; `morphoPreSignDetail` is what stops its
    // "one more try is reasonable" verdict being overwritten with the generic
    // do-not-retry sentence on the way out.
    const detail = morphoPreSignDetail(err);
    await finalizeMorphoFailSoft(toolId, () =>
      failActivityEvent(row.id, {
        failureCode: "unknown",
        failureReason: `${toolId}: refused before signing - ${detail}`,
      }),
    );
    return {
      kind: "refused",
      executionId: context.executionId,
      role: roleOf(context),
      message: withResidual(
        `${toolId}: the ${context.operationLabel} was refused before anything was signed - `
        + `${detail}. No transaction was sent and no gas was spent on it.`,
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
      role: roleOf(context),
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
      role: roleOf(context),
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
      role: roleOf(context),
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
