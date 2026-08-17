/**
 * The APPROVAL legs of a Morpho deposit: send each one, await a DEFINITIVE
 * receipt, and stop the whole execution the moment one does not land.
 *
 * WHY A FAILING APPROVAL ABORTS EVERYTHING AFTER IT. The deposit exists to spend
 * that allowance; without it the bundle has nothing to pull and would revert
 * after costing gas. So every remaining planned row is finalized as
 * "not attempted" (`abortPlannedEvents`) rather than left `pending`, which is a
 * different and honest state: nothing was ever signed for those legs, so there
 * is nothing for the repair sweep to resolve about them.
 *
 * WHY AMBIGUITY STOPS US TOO, WITHOUT TERMINALIZING. An approval whose fate is
 * unknown may or may not exist on chain. Proceeding would either send a deposit
 * that reverts, or send one against an allowance nobody recorded. Neither is
 * acceptable, and re-broadcasting the approval is worse than both. The row keeps
 * its staged hash and stays `pending` forever if need be.
 *
 * WHAT THE AMBIGUOUS ENDING MUST SAY OUT LOUD (funded live probe, 2026-08-17).
 * `context.residual` is set only after a leg CONFIRMS, so an approval that LANDS
 * and then goes ambiguous at the confirm stage used to end with the user told
 * that the vault operation was not attempted and NOT told that real spending
 * authority might now be standing. That is what happened on mainnet: 0.2 USDC of
 * allowance to GeneralAdapter1, unmentioned. A staged hash exists in exactly
 * that case, which is precisely the evidence that the allowance MAY exist, so
 * the ambiguous branch below states the possibility rather than staying silent.
 * A pre-signature refusal has no hash, nothing was ever sent, and it says
 * nothing of the kind.
 *
 * A WITHDRAWAL NEVER REACHES THIS FILE with work to do: it pulls nothing, so its
 * plan has no approval legs and the loop below runs zero times.
 */

import { formatUnits } from "viem";

import { describePossibleResidualAllowance, describeResidualAllowance } from "@tools/morpho/mutations.js";
import { priorLegAnchorFrom } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { abortPlannedEvents, confirmActivityEvent, failActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

import { morphoFailureDetail } from "../shared.js";
import { broadcastMorphoLeg, finalizeMorphoFailSoft, noteMorphoSettledBlockTime } from "./leg-broadcast.js";
import { MORPHO_AMBIGUOUS_BROADCAST_MESSAGE, withResidual, type MorphoExecutionOutcome } from "./outcome.js";
import type { MorphoActivityRole } from "./protocol.js";
import type { MorphoExecutionContext } from "./run.js";

/**
 * The hedged residual sentence an AMBIGUOUS approval owes, or `null` when there
 * is nothing that could be standing.
 *
 * Only the `allowance` role grants spending authority. An ambiguous
 * `allowance_reset` is an approve of ZERO whose fate is unknown, which can leave
 * the previous allowance in place but cannot create one, so claiming a residual
 * for it would name a grant this execution never made.
 */
function possibleResidualFor(context: MorphoExecutionContext, role: MorphoActivityRole): string | null {
  if (role !== "allowance") return null;
  return describePossibleResidualAllowance(
    formatUnits(context.request.amountRaw, context.state.assetDecimals),
    context.state.assetSymbol,
    context.allowancePlan?.spender.toLowerCase() ?? "the Morpho adapter",
  );
}

/**
 * Send every approval leg, in order, awaiting a definitive receipt for each.
 * Returns a terminal outcome when one of them did not land, `null` when they all
 * did (or when there were none).
 */
export async function runAllowanceLegs(context: MorphoExecutionContext): Promise<MorphoExecutionOutcome | null> {
  const { toolId } = context.request;
  const lastIndex = context.legs.length - 1;

  for (let index = 0; index < lastIndex; index += 1) {
    const leg = context.legs[index]!;
    const row = context.events[index]!;
    const txParams = leg.txParams;
    if (txParams === null) {
      // Unreachable: only the operation leg is built later, and it is last.
      throw new Error(`morpho: leg ${index} (${leg.eventRole}) has no transaction to send`);
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
      // Pre-signature for THIS leg: a refused estimate or a refused stage, with
      // nothing broadcast. Everything after it is abandoned, never attempted.
      await abortPlannedEvents(context.executionId, index, `${leg.eventRole} refused before signing`);
      return {
        kind: "refused",
        executionId: context.executionId,
        role: leg.eventRole,
        message: withResidual(
          `${toolId}: the ${leg.eventRole} step was refused before anything was signed - `
          + `${morphoFailureDetail(err)}. No transaction was sent and no gas was spent.`,
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
      await abortPlannedEvents(context.executionId, index + 1, `earlier ${leg.eventRole} ambiguous`);
      return {
        kind: "unproven",
        executionId: context.executionId,
        role: leg.eventRole,
        reason: "ambiguous",
        txHash: outcome.txHash,
        message: withResidual(
          `${toolId}: the ${leg.eventRole} step's broadcast could not be confirmed. `
          + MORPHO_AMBIGUOUS_BROADCAST_MESSAGE
          + " The vault operation itself was NOT attempted.",
          context.residual ?? possibleResidualFor(context, leg.eventRole),
        ),
      };
    }

    if (outcome.kind === "reverted") {
      await finalizeMorphoFailSoft(toolId, () =>
        failActivityEvent(row.id, {
          failureCode: "mined_revert",
          failureReason: `${toolId}: the ${leg.eventRole} transaction reverted on-chain.`,
        }),
      );
      await abortPlannedEvents(context.executionId, index + 1, `earlier ${leg.eventRole} reverted`);
      return {
        kind: "reverted",
        executionId: context.executionId,
        role: leg.eventRole,
        txHash: outcome.txHash,
        message: withResidual(
          `${toolId}: the ${leg.eventRole} transaction (${outcome.txHash}) reverted on-chain, so the vault operation `
          + "was not attempted. No funds moved beyond the gas spent.",
          context.residual,
        ),
      };
    }

    // Confirmed. The next leg's pre-sign estimate depends on this block having
    // been applied by the estimating node.
    context.priorLeg = priorLegAnchorFrom(outcome.receipt.blockNumber);
    await finalizeMorphoFailSoft(toolId, () => confirmActivityEvent(row.id, {}));
    await noteMorphoSettledBlockTime(context.clients.publicClient, row.id, outcome.receipt.blockNumber);

    if (leg.eventRole === "allowance") {
      // From here on, every non-confirmed ending owes the user this sentence.
      context.residual = describeResidualAllowance(
        formatUnits(context.request.amountRaw, context.state.assetDecimals),
        context.state.assetSymbol,
        context.allowancePlan?.spender.toLowerCase() ?? "the Morpho adapter",
      );
    }
  }

  return null;
}
