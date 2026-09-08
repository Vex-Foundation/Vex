/**
 * Vex's fee leg on a Virtuals agent launch - after the KEEPER's launch is
 * observed, never before, and never retried.
 *
 * ## Owner F3, stated as code
 *
 * The fee is collectible in exactly one situation: `Launched` was OBSERVED
 * while this handler still owned the approved signer. Everything else waives it
 * PERMANENTLY.
 *
 *  - `preLaunch` reverted, was refused or is ambiguous -> never called. The row
 *    is finalized as never-attempted.
 *  - `preLaunch` confirmed but the keeper's `Launched` did not arrive inside the
 *    bounded wait -> `waived`. The launch is recorded `awaiting_keeper`, the fee
 *    is never collected afterwards, and nothing schedules a later attempt.
 *    A reconciliation holds no signer and no approval, so a fee it collected
 *    would be a transfer nobody authorized; and a claim that survives a restart
 *    is a standing debt on a user's wallet. Neither exists here.
 *  - a FAILED fee leaves the launch UNAFFECTED. Nothing here throws, nothing
 *    aborts or fails the launch row, and no caller may report a confirmed
 *    launch as failed because its fee did not land.
 *  - an AMBIGUOUS fee is NEVER retried. It is left pending with its staged hash
 *    for the sweep, because a blind retry of an unconfirmed transfer could
 *    charge the user twice.
 *
 * The worst case is that Vex misses revenue on a slow keeper. That is the
 * intended trade.
 */

import { formatUnits, type Account, type Chain, type Transport, type WalletClient } from "viem";

import { buildEvmVexFeeTransfer } from "@tools/bridge-fee/evm-fee-transfer.js";
import { signStageBroadcast, type DeferredEvmSigner } from "@tools/evm-chains/staged-broadcast.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { VIRTUALS_LAUNCH_FEE_RECEIVER_EVM } from "@tools/virtuals/launch/index.js";
import type { VirtualsCurveDeployment, getVirtualsCurveClients } from "@tools/virtuals/curve/index.js";
import {
  confirmActivityEvent,
  failActivityEvent,
  markActivityBroadcast,
  markBroadcastAccepted,
  reserveActivityEvmNonce,
} from "@vex-agent/db/repos/agent-activity.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

import { abortRemainingLaunchPlans } from "./activity.js";

/**
 * How the fee attempt ended.
 *
 * `waived` is this lane's own outcome and the one that does not exist on any
 * other Vex venue: a fee that APPLIED, was never charged, and never will be.
 * It is deliberately not folded into `not_attempted`, which means "it should
 * have been charged and the transfer did not reach the network" - a defect - or
 * into `not_charged`, which means "there was no fee to take". A reader of the
 * feed must be able to tell a policy decision from a failure.
 */
export interface LaunchFeeCollection {
  readonly collection:
    | "confirmed"
    | "confirmed_unrecorded"
    | "reverted"
    | "unconfirmed"
    | "not_attempted"
    | "not_charged"
    | "waived";
  /** Plain language, agent-facing. Always states that the launch is unaffected. */
  readonly collectionNote: string;
  readonly txHash: string | null;
  readonly feeAmountRaw: string | null;
  readonly receiver: string;
}

export async function runLaunchFeeLeg(input: {
  readonly deployment: VirtualsCurveDeployment;
  /** The pre-created `agent_activity` row, or null when none was planned. */
  readonly feeRowId: number | null;
  readonly executionId: number;
  readonly launchLegCount: number;
  /** The exact fee split off the committed VIRTUAL, or null when it floored to zero. */
  readonly feeRaw: bigint | null;
  /**
   * TRUE only when the keeper's `Launched` was observed while this handler
   * still held the signer. Anything else waives the fee (owner F3).
   */
  readonly keeperLaunchObserved: boolean;
  readonly clients: ReturnType<typeof getVirtualsCurveClients>;
  readonly priorLeg: ConfirmedPriorLeg | undefined;
}): Promise<LaunchFeeCollection> {
  const feeRaw = input.feeRaw;

  if (feeRaw === null || feeRaw <= 0n) {
    const reason = "the fee rounds to zero at this size, so no transfer is made";
    if (input.feeRowId !== null) {
      await abortRemainingLaunchPlans(input.executionId, input.launchLegCount, reason);
    }
    return notCharged(reason);
  }

  if (!input.keeperLaunchObserved) {
    const reason =
      "waived: the Virtuals keeper had not launched the agent within the bounded wait, so Vex never charges for it";
    if (input.feeRowId !== null) {
      await abortRemainingLaunchPlans(input.executionId, input.launchLegCount, reason);
    }
    return {
      collection: "waived",
      collectionNote:
        "No Vex fee was charged, and none ever will be for this launch. Vex takes its fee only when it has seen the "
        + "Virtuals keeper launch your agent while it still held your approval; the wait elapsed first, so the fee is "
        + "waived permanently. Your agent is unaffected and Vex will reconcile the launch without charging you.",
      txHash: null,
      feeAmountRaw: null,
      receiver: VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
    };
  }

  if (input.feeRowId === null) {
    // A fee DID apply but has no row to record it under - a different truth from
    // "no fee applies", and the audit surface must tell them apart. Nothing is
    // signed: a transfer with no audit row is exactly what the plan-before-sign
    // rule exists to prevent.
    return {
      collection: "not_attempted",
      collectionNote:
        "No Vex fee was taken: the fee leg had no recorded row, so nothing was signed. Your launch is unaffected.",
      txHash: null,
      feeAmountRaw: null,
      receiver: VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
    };
  }

  const feeRowId = input.feeRowId;
  try {
    const transfer = buildEvmVexFeeTransfer(input.deployment.virtual, feeRaw, VIRTUALS_LAUNCH_FEE_RECEIVER_EVM);
    if (transfer.kind !== "erc20") {
      // Structurally impossible - VIRTUAL is an ERC-20 on both chains - and
      // refused rather than asserted: a native transfer here would move ETH the
      // fee policy never mentions.
      throw new Error("The Virtuals launch fee must be an ERC-20 transfer of VIRTUAL.");
    }

    // THE DEFERRED ARM. viem's eager `signTransaction` wallet action awaits an
    // `eth_chainId` of its own between the last hook and the signature; this leg
    // signs offline so that literally no request sits in that window.
    const walletClient: WalletClient<Transport, Chain, Account> = input.clients.walletClient;
    const deferredSigner: DeferredEvmSigner = {
      kind: "deferred",
      address: walletClient.account.address,
      chain: walletClient.chain,
      onBeforeSign: async () => {},
      createSigner: async () => walletClient,
    };

    const outcome = await signStageBroadcast(
      input.clients.publicClient,
      deferredSigner,
      { to: transfer.to, data: transfer.data, value: transfer.value },
      {
        onNonceReserved: (request) => reserveActivityEvmNonce(feeRowId, request),
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(feeRowId, handles);
          if (!res.applied) {
            throw new Error(
              `agent_activity: markActivityBroadcast CAS miss for fee event ${feeRowId} - refusing to broadcast untracked`,
            );
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(feeRowId);
          if (!res.applied) logger.warn("virtuals.launch.fee.broadcast_accept_miss", { id: feeRowId });
        },
      },
      input.priorLeg,
    );

    if (outcome.kind === "reverted") {
      // BEST-EFFORT, deliberately: the revert is a RECEIPT FACT with a known
      // hash. Letting a repository failure fall through to the catch below would
      // downgrade a proven on-chain revert to "not attempted" and erase the hash.
      await recordFeeRevert(feeRowId, outcome.txHash);
      return {
        collection: "reverted",
        collectionNote: "The Vex fee transfer reverted, so no fee was collected - your launch is unaffected.",
        txHash: outcome.txHash,
        feeAmountRaw: feeRaw.toString(),
        receiver: VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
      };
    }

    if (outcome.kind === "ambiguous") {
      logger.info("virtuals.launch.fee.ambiguous", { id: feeRowId, stage: outcome.stage });
      await noteHandlerPendingReason("virtuals.launch.fee", feeRowId, "fee_broadcast_ambiguous");
      return {
        collection: "unconfirmed",
        collectionNote:
          "The Vex fee transfer was broadcast but not confirmed this turn; it is tracked automatically and is never "
          + "re-sent. Your launch is unaffected.",
        txHash: outcome.txHash,
        feeAmountRaw: feeRaw.toString(),
        receiver: VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
      };
    }

    return {
      collection: await confirmFeeRow(feeRowId, outcome.txHash, feeRaw, input.deployment.virtualDecimals),
      collectionNote:
        `The Vex fee of ${formatUnits(feeRaw, input.deployment.virtualDecimals)} VIRTUAL was transferred to the `
        + "treasury, after the keeper's launch was observed.",
      txHash: outcome.txHash,
      feeAmountRaw: feeRaw.toString(),
      receiver: VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
    };
  } catch (err) {
    // Includes a gas-estimate refusal and a staging CAS miss. None of them may
    // touch the launch row.
    logger.warn("virtuals.launch.fee.leg_failed", { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return {
      collection: "not_attempted",
      collectionNote:
        "The Vex fee transfer was refused before signing, so no fee was collected - your launch is unaffected.",
      txHash: null,
      feeAmountRaw: null,
      receiver: VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
    };
  }
}

function notCharged(reason: string): LaunchFeeCollection {
  return {
    collection: "not_charged",
    collectionNote: `No Vex fee applies to this launch: ${reason}.`,
    txHash: null,
    feeAmountRaw: null,
    receiver: VIRTUALS_LAUNCH_FEE_RECEIVER_EVM,
  };
}

/** Never throws: the revert and its hash are established by the receipt. */
async function recordFeeRevert(feeRowId: number, txHash: string): Promise<void> {
  try {
    await failActivityEvent(feeRowId, {
      failureCode: "mined_revert",
      failureReason: `Vex fee transfer ${txHash} reverted on-chain; the agent launch itself was unaffected.`,
    });
  } catch (err) {
    logger.warn("virtuals.launch.fee.revert_record_failed", {
      id: feeRowId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * A non-applied CAS confirm (the reconciler already finalized this row) must not
 * read as a clean confirm - mirrors the launch path's own confirm.
 */
async function confirmFeeRow(
  feeRowId: number,
  txHash: string,
  feeRaw: bigint,
  decimals: number,
): Promise<"confirmed" | "confirmed_unrecorded"> {
  try {
    const result = await confirmActivityEvent(feeRowId, {
      executedAmountInRaw: feeRaw.toString(),
      executedAmountInHuman: formatUnits(feeRaw, decimals),
    });
    if (result.applied) return "confirmed";
    if (result.row.status === "confirmed" && result.row.txHash === txHash) return "confirmed";
    logger.warn("virtuals.launch.fee.confirm_cas_miss", { id: feeRowId, rowStatus: result.row.status });
    return "confirmed_unrecorded";
  } catch (err) {
    logger.warn("virtuals.launch.fee.confirm_failed", { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return "confirmed_unrecorded";
  }
}
