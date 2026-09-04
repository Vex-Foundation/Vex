/**
 * `khalani.bridge` staged broadcast loop (step 13 of the staged-execute
 * contract and its five post-intent failure branches, split out in 0R.4,
 * refactor-only): one Vex-signed BRIDGE leg at a time, each staged before it
 * reaches the network, each failure finalized against the SAME execution.
 */

import {
  signStageKhalaniLeg,
  type KhalaniStagedLeg,
  type KhalaniStagedOutcome,
} from "@tools/khalani/bridge-executor.js";
import type { KhalaniChain } from "@tools/khalani/types.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
  priorLegAnchorFrom,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  confirmActivityEvent,
  provenLegAmounts,
  failActivityEvent,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  authorizedDepositRecipients,
  confirmDepositWithProvenAmounts,
  proveErc20DepositAmount,
  receiptDepositSettlement,
  type DepositSettlement,
} from "@vex-agent/tools/protocols/bridge-deposit-evidence.js";
import logger from "@utils/logger.js";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import type { ToolResult } from "../../../../types.js";
import { venueFallbackNoteOnKhalaniFailure } from "../fallback.js";
import {
  abortRemaining,
  bridgeResult,
  khalaniFailureMessage,
  type RecordedLeg,
  txExplorerUrl,
} from "../bridge-support.js";
import { khalaniStageHooksFor } from "./staging.js";
import type { KhalaniBridgePendingBase } from "./types.js";

export interface KhalaniLegLoopInput {
  readonly executionId: number;
  readonly stagedLegs: readonly KhalaniStagedLeg[];
  /** Legs strictly below this index are the bridge's own; the fee leg is driven separately (13b). */
  readonly bridgeLegCount: number;
  readonly intentLegs: readonly AgentActivityEvent[];
  readonly sourceChain: KhalaniChain;
  /** The source-chain input token of the bridge - the token a deposit transfer must move. */
  readonly fromToken: string;
  /** What the venue was quoted for: the ABSOLUTE upper bound on the deposit's declared amount. */
  readonly quotedAmountRaw: string;
  readonly chains: KhalaniChain[];
  readonly signer: ChainWallet;
  readonly fromChainId: number;
  readonly fromChainName: string;
  readonly sessionId: string;
  readonly params: Record<string, unknown>;
  readonly pendingBase: KhalaniBridgePendingBase;
  /** Appended in place - the handler renders the same array in its result. */
  readonly recordedLegs: RecordedLeg[];
}

export type KhalaniLegLoopOutcome =
  /** Every bridge leg confirmed on-chain; `depositTxHash` is `undefined` only in the unreachable no-deposit case. */
  | { readonly outcome: "confirmed"; readonly depositTxHash: string | undefined; readonly currentIndex: number }
  /** The loop stopped and the handler must return this result verbatim. */
  | { readonly outcome: "halted"; readonly result: ToolResult; readonly currentIndex: number };

/**
 * What the confirmed DEPOSIT leg may declare it moved.
 *
 * A Vex-built NATIVE transfer is proven by the transaction Vex itself signed:
 * its whole value is the principal, and no log exists for a plain native
 * transfer. Everything else is an ERC-20 question the RECEIPT answers - Vex-built
 * calldata narrows which log is ours, but it cannot promise that a token emitted
 * the standard `Transfer` the amount must be read from, and AgentScan's
 * verification scans exactly those logs. A leg the plan never stamped (a Solana
 * deposit, which has no EVM receipt) declines.
 */
function khalaniDepositSettlement(
  stagedLeg: KhalaniStagedLeg,
  outcome: Extract<KhalaniStagedOutcome, { kind: "confirmed" }>,
  input: KhalaniLegLoopInput,
): DepositSettlement {
  const evidence = stagedLeg.kind === "evm" ? stagedLeg.depositEvidence : undefined;
  if (evidence === undefined || outcome.receiptLogs === null) {
    return { kind: "declined", reason: "unusable_evidence_request", candidateCount: 0 };
  }
  if (evidence.kind === "vex_built_native_transfer") {
    return {
      kind: "proven",
      evidence: { kind: "vex_built_exact", amountRaw: evidence.valueWei.toString() },
    };
  }
  // A spender is an authorized destination only for the token its OWN approval
  // named, and only up to the allowance that approval leaves in force once the
  // execution's approvals are replayed in order.
  const recipients = evidence.kind === "vex_built_erc20_transfer"
    ? [{ address: evidence.recipient, maxAmountRaw: null }]
    : authorizedDepositRecipients({
      inputToken: input.fromToken,
      callTarget: evidence.callTarget,
      approvals: evidence.approvedSpenders,
    });
  return receiptDepositSettlement(proveErc20DepositAmount({
    logs: outcome.receiptLogs,
    tokenAddress: evidence.kind === "vex_built_erc20_transfer" ? evidence.token : input.fromToken,
    senderAddress: input.signer.address,
    recipients,
    quotedAmountInRaw: input.quotedAmountRaw,
    ...(evidence.kind === "vex_built_erc20_transfer"
      ? { expectedAmountRaw: evidence.amountRaw.toString() }
      : {}),
  }));
}

export async function runKhalaniBridgeLegs(input: KhalaniLegLoopInput): Promise<KhalaniLegLoopOutcome> {
  const {
    executionId, stagedLegs, bridgeLegCount, intentLegs, chains,
    fromChainId, fromChainName, pendingBase, recordedLegs, sessionId, params,
  } = input;

  let depositTxHash: string | undefined;
  let currentIndex = 0;
  // Read-after-write anchor for the NEXT leg: the allowance this loop just
  // confirmed is exactly the state the deposit leg's pre-sign estimate depends
  // on, and the estimating node does not always have it yet (live 2026-07-24,
  // allowance `0x2445ce73…` confirmed, deposit refused with "ERC20: transfer
  // amount exceeds allowance", immediate retry succeeded - see
  // `dependent-leg-gas-estimate.ts`). `null` for Solana legs: no EVM anchor.
  let priorLeg: ConfirmedPriorLeg | undefined;
  try {
    for (let i = 0; i < bridgeLegCount; i++) {
      currentIndex = i;
      const stagedLeg = stagedLegs[i]!;
      const legRow = intentLegs[i]!;
      const outcome = await signStageKhalaniLeg(
        stagedLeg, input.sourceChain, chains, input.signer, khalaniStageHooksFor(legRow.id), priorLeg,
      );

      if (outcome.kind === "ambiguous") {
        logger.info("khalani.bridge.leg_ambiguous", { id: legRow.id, role: stagedLeg.role, stage: outcome.stage });
        recordedLegs.push({ role: stagedLeg.role, chain: fromChainName, txHash: outcome.txHash, explorerUrl: txExplorerUrl(fromChainId, chains, outcome.txHash), status: "broadcast_unconfirmed" });
        // Do NOT submit to Khalani - the deposit hash is staged.
        if (stagedLeg.isDeposit) {
          // Blocker 1: an ambiguous DEPOSIT hash MAY have landed on-chain. The
          // logical `bridge_fill_expected` row + the in-flight guard MUST stay
          // pending so W4's null-order-id recovery reconciles the deposit hash
          // against the provider - terminalizing it here would release the guard
          // mid-flight and permit a duplicate bridge. Abort ONLY the never-signed
          // sibling legs strictly BELOW the expected-fill event index (normally
          // none, since the deposit is the last broadcast leg); the exclusive
          // bound (= stagedLegs.length, the expected-fill index) leaves the
          // logical row untouched.
          await abortRemaining(executionId, i + 1, `earlier ${stagedLeg.role} ambiguous`, stagedLegs.length);
        } else {
          // An upstream allowance ended ambiguously and NO deposit was broadcast,
          // so nothing is in flight; abort the whole remaining plan (including the
          // logical row) to release the guard - W4 cannot recover a row that has
          // no staged deposit hash.
          await abortRemaining(executionId, i + 1, `earlier ${stagedLeg.role} ambiguous`);
        }
        return {
          outcome: "halted", currentIndex,
          result: bridgeResult({
            ...pendingBase, success: false, status: "pending",
            message: `The ${stagedLeg.role} transaction (${outcome.txHash}) could not be confirmed yet - it may still settle on-chain. Do not re-bridge; this attempt is recorded and tracked automatically.`,
            legs: recordedLegs, depositTxHash: stagedLeg.isDeposit ? outcome.txHash : undefined,
          }),
        };
      }
      if (outcome.kind === "reverted") {
        await failActivityEvent(legRow.id, { failureCode: "mined_revert", failureReason: `${stagedLeg.role} transaction ${outcome.txHash} reverted on-chain.` });
        recordedLegs.push({ role: stagedLeg.role, chain: fromChainName, txHash: outcome.txHash, explorerUrl: txExplorerUrl(fromChainId, chains, outcome.txHash), status: "reverted" });
        await abortRemaining(executionId, i + 1, `earlier ${stagedLeg.role} reverted`);
        // REVISION 1 R1: note the fallback ONLY for the bridge_deposit leg (never allowance).
        const fallbackNote = stagedLeg.role === "bridge_deposit"
          ? venueFallbackNoteOnKhalaniFailure({ kind: "deposit_mined_revert" }, sessionId, params)
          : "";
        return {
          outcome: "halted", currentIndex,
          result: bridgeResult({
            ...pendingBase, success: false, status: "reverted",
            message: `The ${stagedLeg.role} transaction (${outcome.txHash}) reverted on-chain. No further steps were attempted and no bridge was initiated.${fallbackNote}`,
            legs: recordedLegs,
          }),
        };
      }

      // Confirmed on-chain - record the leg from its own receipt, but RESPECT
      // the CAS result (m5, mirrors Phase-1 C41): a miss that is not a benign
      // already-confirmed-with-the-SAME-hash race means Vex's own record of the
      // (real) on-chain settlement did not persist, so the leg is reported
      // `confirmed_unrecorded`, never an ordinary confirmed.
      let legStatus = "confirmed";
      priorLeg = priorLegAnchorFrom(outcome.settledAtBlock);
      try {
        // What this leg may declare it moved. An allowance leg moves nothing; a
        // deposit leg declares only what its own receipt proves, or declines by
        // name (`bridge-deposit-evidence.ts`). Confirming a leg proves inclusion
        // and never, on its own, the principal it carried.
        const confirmResult = stagedLeg.isDeposit
          ? await confirmDepositWithProvenAmounts({
            eventId: legRow.id,
            role: legRow.eventRole,
            txHash: outcome.txHash,
            chainId: fromChainId,
            settlement: khalaniDepositSettlement(stagedLeg, outcome, input),
            logScope: "khalani.bridge",
          })
          : await confirmActivityEvent(
            legRow.id,
            provenLegAmounts(legRow.eventRole, { kind: "opaque_provider_payload" }),
          );
        if (!confirmResult.applied) {
          const alreadyMatches =
            confirmResult.row.status === "confirmed" && confirmResult.row.txHash === outcome.txHash;
          if (!alreadyMatches) {
            legStatus = "confirmed_unrecorded";
            logger.warn("khalani.bridge.leg_confirm_cas_miss", { id: legRow.id, role: stagedLeg.role, rowStatus: confirmResult.row.status });
          }
        }
      } catch (err) {
        legStatus = "confirmed_unrecorded";
        logger.warn("khalani.bridge.leg_confirm_failed", { id: legRow.id, role: stagedLeg.role, error: khalaniFailureMessage(err) });
      }
      recordedLegs.push({ role: stagedLeg.role, chain: fromChainName, txHash: outcome.txHash, explorerUrl: txExplorerUrl(fromChainId, chains, outcome.txHash), status: legStatus });
      if (stagedLeg.isDeposit) depositTxHash = outcome.txHash;
    }
  } catch (err) {
    return {
      outcome: "halted", currentIndex,
      result: await renderPostIntentFailure(err, { ...input, currentIndex, depositTxHash }),
    };
  }

  return { outcome: "confirmed", depositTxHash, currentIndex };
}

/**
 * A post-intent failure (e.g. a CAS-miss throw) NEVER creates a second
 * execution: the remaining never-signed rows are aborted and the SAME
 * execution id is returned. The three named branches are refusals that signed
 * NOTHING - reporting them as an interruption of unknown scope is what turned
 * a transient RPC lag into a permanent, funded-looking failure (live
 * 2026-07-24), so each says so explicitly instead.
 */
async function renderPostIntentFailure(
  err: unknown,
  input: KhalaniLegLoopInput & { currentIndex: number; depositTxHash: string | undefined },
): Promise<ToolResult> {
  const { executionId, currentIndex, stagedLegs, recordedLegs, pendingBase, depositTxHash } = input;
  const safeMessage = khalaniFailureMessage(err);
  await abortRemaining(executionId, currentIndex, safeMessage);
  logger.warn("khalani.bridge.post_intent_failure", { executionId, index: currentIndex, error: safeMessage });
  const refusedRole = stagedLegs[currentIndex]?.role ?? "bridge_deposit";

  // A leg refused because its estimate never succeeded after an allowance
  // this same bridge confirmed is NOT an interruption of unknown scope:
  // nothing was signed for it, every remaining row (including the logical
  // fill row, so the in-flight guard is released) is finalized "not
  // attempted", and no deposit reached the network.
  if (err instanceof DependentLegGasEstimateError) {
    return bridgeResult({
      ...pendingBase, success: false, status: "not_attempted",
      message: `The ${refusedRole} leg could not be gas-estimated, so it was refused before signing and no bridge was initiated. ${dependentLegEstimateGuidance(err)} The node reported: ${safeMessage}`,
      legs: recordedLegs,
    });
  }
  // The signer's native-value backstop. Step 8 should already have refused
  // this plan, so reaching here means the exposure changed AFTER the intent
  // was recorded - but it is still a refusal that signed nothing.
  if (err instanceof VexError && err.code === ErrorCodes.NATIVE_VALUE_UNAUTHORIZED) {
    return bridgeResult({
      ...pendingBase, success: false, status: "not_attempted",
      message: `The ${refusedRole} leg sends native currency Vex could not account for, so it was refused before signing and no bridge was initiated. ${safeMessage} Re-quote to get a fresh deposit plan.`,
      legs: recordedLegs,
    });
  }
  // The signer's gas-ceiling backstop (W6/6a), same shape and same reasoning
  // as the native-value branch above. Carried here rather than left to the
  // generic tail because `safeMessage` is capped - the cap holds the numbers,
  // this sentence holds the action.
  if (err instanceof VexError && err.code === ErrorCodes.PROVIDER_GAS_LIMIT_EXCESSIVE) {
    return bridgeResult({
      ...pendingBase, success: false, status: "not_attempted",
      message: `The ${refusedRole} leg asked for far more gas than Vex measured for that exact call, so it was refused before signing and no bridge was initiated. ${safeMessage} Re-quote for a fresh deposit plan; a gas estimate does not move with congestion, so waiting will not change this. If a fresh quote asks for the same limit, bridge over a different route instead of retrying this one.`,
      legs: recordedLegs,
    });
  }
  return bridgeResult({
    ...pendingBase, success: false, status: "pending",
    message: `An internal error interrupted the bridge after it was recorded - ${safeMessage}. Check the record (execution ${executionId}) before any further action; do not re-bridge.`,
    legs: recordedLegs, depositTxHash,
  });
}
