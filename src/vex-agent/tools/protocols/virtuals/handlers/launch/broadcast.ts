/**
 * One leg of a Virtuals launch: reserve the nonce, sign, persist the hash,
 * BROADCAST, then wait for a bounded receipt.
 *
 * The three outcomes are three different truths and the differences are the
 * whole safety of the loop:
 *
 *  - CONFIRMED - the receipt says success. The caller may proceed, and only a
 *    confirmed `preLaunch` may reach the keeper wait.
 *  - FAILED - either a refusal before anything reached the network (nothing was
 *    signed, no gas burned) or a MINED revert (bytes broadcast, gas spent). The
 *    two are discriminated by `stage` rather than inferred from a code, because
 *    they must never be described to a person in the same words.
 *  - AMBIGUOUS - the send or the receipt wait could not be resolved. It NEVER
 *    terminalizes: the intent stays `broadcast_pending` with its staged hash for
 *    the identity sweep, and the leg is never re-sent. MetaMask's
 *    `PendingTransactionTracker` marks such a transaction FAILED on a not-found
 *    timeout (`PendingTransactionTracker.ts:490-495`); the Vex wallet-reference
 *    audit records that as an explicit REJECTION and this lane keeps it
 *    rejected.
 *
 * A LAUNCH IS NEVER RETRIED. Not the `preLaunch`, not the approval, not the fee.
 * Rabby's retry path re-signs an approved payload under a bumped nonce and a
 * 1.3x gas multiplier (`rpcFlow.ts:424-465`); the same audit records that as a
 * rejection, and a re-sent `preLaunch` would create a SECOND agent token and
 * spend the purchase twice.
 *
 * The nonce is reserved through the shared durable allocator inside
 * `signStageBroadcast`, which holds a per-(address, chain) single flight from
 * the nonce fill through the signature - the ownership pattern MetaMask's
 * `getNextNonce` + `#approveTransaction` establishes
 * (`TransactionController.ts:3107-3179`).
 */

import type { Hex, TransactionReceipt } from "viem";

import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { classifyLaunchRevert, type LaunchRevertClass } from "@tools/virtuals/launch/revert-mapping.js";
import type { BuiltLaunchTx } from "@tools/virtuals/launch/index.js";
import type { getVirtualsCurveClients } from "@tools/virtuals/curve/index.js";
import {
  failActivityEvent,
  markActivityBroadcast,
  markBroadcastAccepted,
  reserveActivityEvmNonce,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

export type LaunchLegOutcome =
  | {
      readonly kind: "confirmed";
      readonly txHash: Hex;
      readonly receipt: TransactionReceipt;
      readonly settledAtBlock: bigint;
    }
  | {
      readonly kind: "failed";
      /** `pre_broadcast` means NOTHING was signed and nothing was sent. */
      readonly stage: "pre_broadcast" | "mined_revert";
      readonly reason: string;
      readonly txHash: Hex | null;
    }
  | { readonly kind: "ambiguous"; readonly txHash: Hex };

export async function runLaunchLeg(input: {
  readonly toolId: string;
  readonly event: AgentActivityEvent;
  readonly tx: BuiltLaunchTx;
  readonly clients: ReturnType<typeof getVirtualsCurveClients>;
  readonly priorLeg: ConfirmedPriorLeg | undefined;
  /** Human name of this leg, for the agent-facing sentence. */
  readonly label: string;
  /**
   * Persist the SIGNED hash somewhere besides the activity row, BEFORE the
   * bytes reach the network. Only the `preLaunch` leg supplies one.
   *
   * IT RUNS BEFORE `sendRawTransaction`, which is the whole point: the intent's
   * hash is the only evidence the identity sweep can look a launch up by, and a
   * crash between the broadcast and a later write would leave a mined
   * `preLaunch` that nothing in the system can find. THROWING from it aborts
   * with nothing sent - which is the right answer when the CAS misses, because
   * a miss means another executor owns this intent and continuing would sign a
   * second launch for a user whose first may already be mined.
   */
  readonly onHashStaged?: (txHash: Hex) => Promise<void>;
}): Promise<LaunchLegOutcome> {
  const { event } = input;
  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(
      input.clients.publicClient,
      input.clients.walletClient,
      { to: input.tx.to, data: input.tx.data, value: input.tx.value },
      {
        onNonceReserved: (request) => reserveActivityEvmNonce(event.id, request),
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(event.id, handles);
          if (!res.applied) {
            throw new Error(
              `agent_activity: markActivityBroadcast CAS miss for event ${event.id} - refusing to broadcast untracked`,
            );
          }
          if (input.onHashStaged !== undefined) await input.onHashStaged(handles.txHash);
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(event.id);
          if (!res.applied) logger.warn("virtuals.launch.broadcast_accept_miss", { id: event.id });
        },
      },
      input.priorLeg,
    );
  } catch (err) {
    // Nothing reached the network: the pre-sign estimate refused, the nonce
    // could not be reserved, or the staging CAS missed. The row is terminalized
    // hashless, which is exactly what "nothing was signed" means durably.
    const verdict = classifyLaunchRevert(err);
    await recordLegFailure(
      input.toolId,
      event.id,
      failureCodeFor(verdict.kind),
      `${input.label}: ${verdict.reason}`,
    );
    return { kind: "failed", stage: "pre_broadcast", reason: verdict.reason, txHash: null };
  }

  if (outcome.kind === "reverted") {
    const verdict = classifyLaunchRevert(outcome.receipt);
    await recordLegFailure(
      input.toolId,
      event.id,
      "mined_revert",
      `${input.label} ${outcome.txHash} reverted on-chain: ${verdict.reason}`,
    );
    return { kind: "failed", stage: "mined_revert", reason: verdict.reason, txHash: outcome.txHash };
  }

  if (outcome.kind === "ambiguous") {
    logger.info("virtuals.launch.leg_ambiguous", { id: event.id, stage: outcome.stage });
    await noteHandlerPendingReason(
      input.toolId,
      event.id,
      outcome.stage === "send" ? "broadcast_ambiguous_send" : "broadcast_ambiguous_confirm",
    );
    return { kind: "ambiguous", txHash: outcome.txHash };
  }

  return {
    kind: "confirmed",
    txHash: outcome.txHash,
    receipt: outcome.receipt,
    settledAtBlock: outcome.receipt.blockNumber,
  };
}

function failureCodeFor(kind: LaunchRevertClass) {
  if (kind === "allowance_or_balance") return "allowance_or_balance" as const;
  return "simulation_reverted" as const;
}

/**
 * Record a leg's terminal failure. Best-effort by contract: the outcome is
 * already established (a receipt, or the fact that nothing was signed), and no
 * repository failure may unsay it.
 */
async function recordLegFailure(
  toolId: string,
  eventId: number,
  failureCode: "allowance_or_balance" | "simulation_reverted" | "mined_revert",
  failureReason: string,
): Promise<void> {
  try {
    await failActivityEvent(eventId, { failureCode, failureReason });
  } catch (err) {
    logger.warn("virtuals.launch.leg_failure_record_failed", {
      toolId,
      id: eventId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
