/**
 * The post-intent staged broadcast loop: one Vex-signed leg at a time, each
 * one's hash persisted BEFORE the payload reaches the network.
 *
 * Three outcomes, three different truths, and the differences are the whole
 * safety of the loop:
 *   - `ambiguous`  — the transaction may still settle. The row stays PENDING
 *                    with its staged hash, every leg behind it is aborted, and
 *                    it is NEVER re-broadcast: a blind retry could spend twice.
 *   - `reverted`   — definitively failed. The row fails with `mined_revert` and
 *                    nothing further is attempted.
 *   - `confirmed`  — its block anchors the NEXT leg's gas estimate
 *                    (`priorLegAnchorFrom`), because the estimating node does
 *                    not always see the allowance this loop just confirmed.
 *
 * A CAS miss on staging THROWS: a transaction the database is not tracking must
 * never reach the network.
 */

import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import { priorLegAnchorFrom, type ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";

import type { Address } from "viem";
import type { ToolResult } from "../../../../types.js";
import type { TrenchTradeSide } from "@tools/trench-express/evm/curve-reader.js";
import type { TradeLegPlan } from "./plan.js";
import { TOOL_ID, abortRemaining, safeDetail } from "./execute-identity.js";
import { finalizeConfirmedSwap, type FinalizeConfirmedSwapOutcome } from "./finalize.js";
import { handlePostIntentFailure } from "./failure-results.js";
import { planSellFeeLeg, tradeFeeSkipped, tradeFeeUnprovenBase, type TradeFeeIdentity } from "./fee.js";
import {
  runTrenchFeeLeg,
  trenchFeeNotAttempted,
  trenchFeeNotCharged,
  type TrenchFeeCollection,
  type TrenchFeeLegPlan,
} from "../../fee/index.js";
import type { TrenchFeeDisclosure } from "@tools/trench-express/fee/index.js";

export interface StagedLoopInput {
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
  readonly fee: StagedLoopFee;
}

/**
 * The fee leg's pre-created row and its planned shape. `plan === null` means no
 * fee applies at this size, and then `rowId` is null too — there is no row.
 */
export interface StagedLoopFee {
  readonly plan: TrenchFeeLegPlan | null;
  readonly rowId: number | null;
  /** The base the plan was built from — the disclosure's base when it is skipped. */
  readonly baseWei: bigint;
  readonly identity: TradeFeeIdentity;
}

export async function runStagedLoop(x: StagedLoopInput): Promise<ToolResult> {
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
        // Migration 067: name WHICH ambiguity. "The submit itself never came
        // back" and "we submitted but never saw the receipt" are different jobs
        // for the fallback and produced an identical row before 067.
        await noteHandlerPendingReason(
          TOOL_ID, eventRow.id,
          outcome.stage === "send" ? "broadcast_ambiguous_send" : "broadcast_ambiguous_confirm",
        );
        // Aborts the fee row too (it sits at index `plans.length`): a trade whose
        // outcome is unknown must never be charged for.
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

      const finalized = await finalizeConfirmedSwap({
        side: x.side,
        token: x.token,
        walletAddress: x.walletAddress,
        chainId: x.chainId,
        tokenDecimals: x.tokenDecimals,
        amountInHuman: x.amountInHuman,
        amountInRaw: x.amountInRaw,
        executionId,
        eventId: eventRow.id,
        txHash: outcome.txHash,
        logs: outcome.receipt.logs.map((l) => ({ address: l.address, topics: l.topics as string[], data: l.data })),
      });

      // ── The fee leg, LAST, and only now that the trade is CONFIRMED ──
      return await attachVexFee(x, finalized, priorLeg);
    }
    throw new Error(`${TOOL_ID}: staged broadcast loop exited without a result`);
  } catch (err) {
    return await handlePostIntentFailure({
      executionId,
      events,
      plans,
      slippageBps: x.slippageBps,
      currentIndex,
      legBroadcastAttempted,
      error: err,
    });
  }
}

/**
 * Run the Vex fee leg after a CONFIRMED trade and attach its disclosure to the
 * result. Nothing here can change whether the trade succeeded.
 *
 * On a SELL the leg is RE-PLANNED from the decoded proceeds, because the row was
 * planned from the quote and the fee must be 25 bps of what actually arrived.
 * When the decode declined (`ethOutRaw === null`) there is no provable base, so
 * no fee is taken at all — never 25 bps of an estimate.
 */
async function attachVexFee(
  x: StagedLoopInput,
  finalized: FinalizeConfirmedSwapOutcome,
  priorLeg: ConfirmedPriorLeg | undefined,
): Promise<ToolResult> {
  const { fee, executionId } = x;
  const feeRowIndex = x.plans.length;

  const skip = async (
    collection: TrenchFeeCollection,
    disclosure: TrenchFeeDisclosure,
  ): Promise<ToolResult> => {
    if (fee.rowId !== null) await abortRemaining(executionId, feeRowIndex, collection.collectionNote);
    return withFeeDisclosure(finalized.result, collection, disclosure);
  };

  // FIRST, and before anything else can publish a number: a SELL whose proceeds
  // did not decode has NO base Vex can prove. The row was planned from the
  // quote, and the quote must not survive into the record of a settled trade —
  // not as a fee, and not even as the fee's stated base.
  const sellProceedsWei = x.side === "sell" ? finalized.ethOutRaw : null;
  if (x.side === "sell" && sellProceedsWei === null) {
    return skip(
      trenchFeeNotAttempted("the ETH proceeds could not be decoded, so Vex cannot prove what a fee would be 25 bps of"),
      tradeFeeUnprovenBase(),
    );
  }

  // NO fee applied at all — the 25 bps floored to zero when the row was planned.
  if (fee.plan === null) return skip(trenchFeeNotCharged(), tradeFeeSkipped(x.side, fee.baseWei));
  // A fee DID apply but has no row to record it under. A different truth from
  // the line above, and the audit surface must be able to tell them apart.
  if (fee.rowId === null) {
    return skip(
      trenchFeeNotAttempted("the fee leg had no recorded row, so nothing was signed"),
      tradeFeeSkipped(x.side, fee.baseWei),
    );
  }

  // The SELL's real base is executed truth, not the quote the row was planned
  // from, so the leg that is actually signed is re-planned from the proceeds.
  let plan = fee.plan;
  if (sellProceedsWei !== null) {
    const replanned = planSellFeeLeg(fee.identity, sellProceedsWei);
    if (replanned === null) return skip(trenchFeeNotCharged(), tradeFeeSkipped(x.side, sellProceedsWei));
    plan = replanned;
  }

  const collection = await runTrenchFeeLeg({
    plan,
    feeRowId: fee.rowId,
    chainId: x.chainId,
    publicClient: x.publicClient,
    walletClient: x.walletClient,
    priorLeg,
  });
  return withFeeDisclosure(finalized.result, collection, plan.disclosure);
}

/**
 * Merge the fee report into the trade's result. `success` is NEVER touched: the
 * trade already happened, and a fee that did not land is missed Vex revenue and
 * nothing more.
 */
function withFeeDisclosure(
  result: ToolResult,
  collection: TrenchFeeCollection,
  disclosure: TrenchFeeDisclosure,
): ToolResult {
  const vexFee = { ...collection, disclosure };
  const data = { ...(result.data ?? {}), vexFee };
  return {
    ...result,
    output: result.data === undefined ? result.output : JSON.stringify(data),
    data,
  };
}
