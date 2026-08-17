/**
 * The VAULT OPERATION leg: build it against state as it now is, PROVE it would
 * land, send it, and turn the receipt into recorded truth.
 *
 * PHASE 2 REBUILDS, AND THAT IS THE POINT. Between the plan and this moment an
 * approval of ours has landed and the vault has accrued, so the transaction that
 * gets signed is built from the state it will actually meet rather than from the
 * state that was current when the plan was drawn. Its price guard, its decode
 * and its gas bound are all recomputed on that fresh build.
 *
 * THE SIMULATION IS A GATE, NOT A NOTE. A proven revert and an unanswered node
 * both abort before a signature exists, with different codes and different words
 * (`@tools/morpho/mutations.js` owns that distinction). A deposit that would
 * revert must never cost the user gas to discover.
 *
 * THE TARGET IS RE-ASSERTED. The durable row already NAMES the contract this
 * transaction may go to, and the settlement hint persisted at intent time names
 * the same one. A rebuild pointing somewhere else is a change of target between
 * the plan that was recorded and the payload about to be signed, so it is
 * refused rather than reconciled.
 *
 * A CONFIRMED OPERATION IS NEVER UNDONE BY BOOKKEEPING. Once the receipt is
 * successful the funds have moved; from that line on, every write is fail-soft
 * and no failure to record may be reported to the agent as the operation having
 * failed.
 */

import { formatUnits, getAddress } from "viem";

import { compareMorphoShares, prepareMorphoOperationLeg } from "@tools/morpho/mutations.js";
import { confirmActivityEvent, failActivityEvent, type AgentActivityFailureCode } from "@vex-agent/db/repos/agent-activity.js";
import { decodeMorphoSettlement } from "@vex-agent/sync/morpho-settlement-decoder.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";
import { VexError } from "../../../../../../errors.js";

import { morphoFailureDetail } from "../shared.js";
import { broadcastMorphoLeg, finalizeMorphoFailSoft, noteMorphoSettledBlockTime } from "./leg-broadcast.js";
import { morphoOperationRole } from "./intent.js";
import {
  MORPHO_AMBIGUOUS_BROADCAST_MESSAGE,
  morphoUndecodableMessage,
  withResidual,
  type MorphoExecutionOutcome,
} from "./outcome.js";
import type { MorphoExecutionContext } from "./run.js";

export async function runOperationLeg(context: MorphoExecutionContext): Promise<MorphoExecutionOutcome> {
  const { toolId } = context.request;
  const index = context.legs.length - 1;
  const row = context.events[index]!;
  const role = morphoOperationRole(context.direction);

  // PHASE 2. Rebuild against state as it now is - the approval has landed and
  // the vault has accrued - then decode, bound the gas and SIMULATE. A revert
  // here aborts before the operation is ever signed.
  let leg;
  try {
    leg = await prepareMorphoOperationLeg(
      {
        chainId: context.request.chainId,
        vaultAddress: context.request.vaultAddress,
        direction: context.direction,
        amountRaw: context.request.amountRaw,
        slippageBps: context.request.slippageBps,
        walletAddress: context.request.walletAddress,
      },
      { client: context.clients.actionClient },
    );
  } catch (err) {
    await finalizeMorphoFailSoft(toolId, () =>
      failActivityEvent(row.id, {
        failureCode: preflightFailureCode(err),
        failureReason: `${toolId}: refused before signing - ${morphoFailureDetail(err)}`,
      }),
    );
    return {
      kind: "refused",
      executionId: context.executionId,
      role,
      message: withResidual(
        `${toolId} was refused before signing: ${morphoFailureDetail(err)}`,
        context.residual,
      ),
    };
  }

  // The row already NAMES the contract this transaction may go to, and the
  // settlement hint persisted at intent time names the same one. A rebuild that
  // came back pointing somewhere else is a change of target between the plan the
  // user consented to and the payload about to be signed, so it is refused
  // rather than reconciled.
  if (getAddress(leg.to) !== context.verifiedTarget) {
    const reason =
      `${toolId}: the rebuilt ${context.direction} targets ${leg.to.toLowerCase()}, not the `
      + `${context.verifiedTarget.toLowerCase()} this execution was planned and recorded against. Nothing was signed.`;
    await finalizeMorphoFailSoft(toolId, () =>
      failActivityEvent(row.id, { failureCode: "unknown", failureReason: reason }),
    );
    return { kind: "refused", executionId: context.executionId, role, message: withResidual(reason, context.residual) };
  }

  let outcome;
  try {
    outcome = await broadcastMorphoLeg({
      toolId,
      publicClient: context.clients.publicClient,
      walletClient: context.clients.walletClient,
      eventId: row.id,
      txParams: { to: leg.to, data: leg.data, value: leg.value },
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
      role,
      message: withResidual(
        `${toolId}: the ${context.direction} was refused before anything was signed - ${morphoFailureDetail(err)}. `
        + "No transaction was sent and no gas was spent on it.",
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
      role,
      reason: "ambiguous",
      txHash: outcome.txHash,
      message: withResidual(
        `${toolId}: the ${context.direction} broadcast (${outcome.txHash}) could not be confirmed. `
        + MORPHO_AMBIGUOUS_BROADCAST_MESSAGE,
        context.residual,
      ),
    };
  }

  if (outcome.kind === "reverted") {
    await finalizeMorphoFailSoft(toolId, () =>
      failActivityEvent(row.id, {
        failureCode: "mined_revert",
        failureReason: `${toolId}: the vault ${context.direction} reverted on-chain.`,
      }),
    );
    return {
      kind: "reverted",
      executionId: context.executionId,
      role,
      txHash: outcome.txHash,
      message: withResidual(
        `${toolId}: the vault ${context.direction} (${outcome.txHash}) reverted on-chain. No funds moved beyond the `
        + "gas spent.",
        context.residual,
      ),
    };
  }

  // Mined successfully. From here on the transaction HAS settled, so a
  // bookkeeping throw must never be reported as the operation failing.
  const decoded = decodeMorphoSettlement({
    logs: outcome.receipt.logs.map((log) => ({ address: log.address, topics: [...log.topics], data: log.data })),
    walletAddress: context.request.walletAddress,
    eventRole: role,
    tokenInAddress: row.tokenInAddress,
    tokenOutAddress: row.tokenOutAddress,
    amountInRaw: row.amountInRaw,
    amountOutRaw: row.amountOutRaw,
  });

  if (decoded === null) {
    logger.warn("morpho.activity.undecodable_receipt", { id: row.id, toolId, role });
    await noteHandlerPendingReason(toolId, row.id, "settlement_undecodable");
    return {
      kind: "unproven",
      executionId: context.executionId,
      role,
      reason: "undecodable",
      txHash: outcome.txHash,
      message: morphoUndecodableMessage(outcome.txHash),
    };
  }

  const inDecimals = context.direction === "deposit" ? context.state.assetDecimals : context.state.shareDecimals;
  const outDecimals = context.direction === "deposit" ? context.state.shareDecimals : context.state.assetDecimals;
  const executed = {
    amountInRaw: decoded.executedAmountInRaw,
    amountInHuman: formatUnits(BigInt(decoded.executedAmountInRaw), inDecimals),
    amountOutRaw: decoded.executedAmountOutRaw,
    amountOutHuman: formatUnits(BigInt(decoded.executedAmountOutRaw), outDecimals),
  };

  await finalizeMorphoFailSoft(toolId, () =>
    confirmActivityEvent(row.id, {
      executedAmountInRaw: executed.amountInRaw,
      executedAmountInHuman: executed.amountInHuman,
      executedAmountOutRaw: executed.amountOutRaw,
      executedAmountOutHuman: executed.amountOutHuman,
    }),
  );

  // AFTER the confirm, never before it. `noteSettledBlockTime` only writes a row
  // that is already `confirmed`, so calling it first was a silent no-op that left
  // `settled_block_time` NULL on every operation row while the approval rows
  // (which confirm first) carried one. Caught by the fork run's own row dump on
  // 2026-08-17, which is exactly the kind of ordering bug no mock notices.
  await noteMorphoSettledBlockTime(context.clients.publicClient, row.id, outcome.receipt.blockNumber);

  // The shares side of the settlement, held against the ABSOLUTE per-operation
  // bound the approved slippage allows - the same bound the on-chain
  // `maxSharePrice` guard enforces on a deposit (coordinator ruling
  // 2026-08-17). It REPORTS: the money has already moved, so a settlement
  // outside the bound is stated plainly rather than converted into a failure
  // that did not happen. The raw quoted-vs-settled difference rides along as
  // accrual drift, which is data and not a verdict.
  const provenSharesRaw = BigInt(
    context.direction === "deposit" ? decoded.executedAmountOutRaw : decoded.executedAmountInRaw,
  );
  const shares = compareMorphoShares(
    context.expectedSharesRaw,
    provenSharesRaw,
    context.state.shareDecimals,
    context.request.slippageBps,
    context.direction,
  );

  const assetSymbol = context.state.assetSymbol ?? "asset";
  const shareSymbol = context.state.shareSymbol ?? "shares";
  const summary = context.direction === "deposit"
    ? `Deposited ${executed.amountInHuman} ${assetSymbol} and received ${executed.amountOutHuman} ${shareSymbol}.`
    : `Redeemed ${executed.amountInHuman} ${shareSymbol} for ${executed.amountOutHuman} ${assetSymbol}.`;
  const drift = shares.withinApprovedBound
    ? ""
    : ` The settled share count ${shares.actualRaw} is outside the ${shares.approvedBoundRaw} raw shares the approved `
      + `${shares.slippageBps} bps allows for this operation (${shares.boundSide}); it moved ${shares.accrualDriftRaw} `
      + `raw units from the quoted ${shares.quotedRaw}. The figures above are what the receipt proved, and the `
      + "transaction's own on-chain price guard is what bounded the price.";

  return {
    kind: "confirmed",
    executionId: context.executionId,
    txHash: outcome.txHash,
    executed,
    shares,
    message: `${toolId}: ${summary} Tx: ${outcome.txHash}.${drift}`,
  };
}

/**
 * A pre-signature refusal's durable code. A PROVEN revert is
 * `simulation_reverted`; anything else is `unknown` with the real cause in the
 * reason text, because inventing a provider refusal that never happened is the
 * failure rules/90 names.
 */
function preflightFailureCode(err: unknown): AgentActivityFailureCode {
  return err instanceof VexError && err.code === "MORPHO_PREFLIGHT_REVERTED"
    ? "simulation_reverted"
    : "unknown";
}
