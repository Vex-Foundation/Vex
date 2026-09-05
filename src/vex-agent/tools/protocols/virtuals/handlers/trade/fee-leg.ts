/**
 * Vex's fee leg on a Virtuals curve trade - AFTER the trade confirms, never
 * before, and never retried.
 *
 * THE INVARIANT, copied from the bridge lane that says it about bridges and
 * means it identically here:
 *
 *   "a bridge that fails at any point NEVER charges a fee for a bridge that did
 *    not happen. The worst case is that Vex misses revenue - never that the user
 *    pays for nothing. Do not reorder to fee-first."
 *
 * Concretely, and every one of these is pinned by a test:
 *
 *  - A REVERTED, REFUSED or AMBIGUOUS trade means this function is never called:
 *    the fee is not signed, and the caller finalizes the fee row as
 *    never-attempted through `abortPlannedEvents`.
 *  - A FAILED fee leaves the trade UNAFFECTED. Nothing here throws, nothing
 *    aborts or fails the parent row, and no caller may mark a confirmed trade
 *    failed because its fee did not land.
 *  - An AMBIGUOUS fee is NEVER retried. It is left pending with its staged hash
 *    for the sweep, because a blind retry of an unconfirmed transfer could
 *    charge the user twice.
 *
 * ## The sell side is settlement-derived, and that is the whole asymmetry
 *
 * A BUY's fee was split off the committed VIRTUAL before the curve ever saw it,
 * so the exact amount is known before the trade. A SELL's fee is 25 bps of the
 * VIRTUAL that ACTUALLY REACHED THE WALLET, which is a receipt fact: the curve
 * removes its protocol tax and any anti-sniper tax inside the transaction. So
 * the sell arm takes its base from the decoded settlement, and a settlement that
 * could not be decoded means NO FEE AT ALL - Vex does not charge a percentage of
 * a number nobody observed.
 */

import { formatUnits, type Account, type Chain, type Transport, type WalletClient } from "viem";

import {
  buildEvmVexFeeTransfer,
} from "@tools/bridge-fee/evm-fee-transfer.js";
import { signStageBroadcast, type DeferredEvmSigner } from "@tools/evm-chains/staged-broadcast.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  VIRTUALS_CURVE_FEE_RECEIVER_EVM,
  virtualsCurveSellFeeFromProceeds,
  type VirtualsCurveDeployment,
  type getVirtualsCurveClients,
} from "@tools/virtuals/curve/index.js";
import {
  confirmActivityEvent,
  failActivityEvent,
  markActivityBroadcast,
  markBroadcastAccepted,
  reserveActivityEvmNonce,
} from "@vex-agent/db/repos/agent-activity.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

import { abortRemainingCurvePlans } from "./activity.js";

/**
 * How the fee attempt ended. Richer than a boolean deliberately: `not_charged`
 * (there was no fee to take) and `not_attempted` (there was, and it never
 * reached the network) are different truths and the audit surface must be able
 * to tell them apart.
 */
export interface CurveFeeCollection {
  readonly collection:
    | "confirmed"
    | "confirmed_unrecorded"
    | "reverted"
    | "unconfirmed"
    | "not_attempted"
    | "not_charged";
  /** Plain language, agent-facing. Always states that the trade is unaffected. */
  readonly collectionNote: string;
  readonly txHash: string | null;
  /** The amount actually transferred, raw, when one was. */
  readonly feeAmountRaw: string | null;
  readonly receiver: string;
}

export async function runCurveFeeLeg(input: {
  readonly side: "buy" | "sell";
  readonly deployment: VirtualsCurveDeployment;
  /** The pre-created `agent_activity` row, or null when none was planned. */
  readonly feeRowId: number | null;
  readonly executionId: number;
  readonly tradeLegCount: number;
  /** BUY: the exact fee split off the input. Null on a sell. */
  readonly buyFeeRaw: bigint | null;
  /** SELL: the PROVEN VIRTUAL that reached the wallet, or null when undecodable. */
  readonly provenProceedsRaw: bigint | null;
  readonly clients: ReturnType<typeof getVirtualsCurveClients>;
  readonly priorLeg: ConfirmedPriorLeg | undefined;
}): Promise<CurveFeeCollection> {
  const feeRaw = input.side === "buy"
    ? input.buyFeeRaw
    : input.provenProceedsRaw === null
      ? null
      : virtualsCurveSellFeeFromProceeds(input.provenProceedsRaw);

  if (feeRaw === null || feeRaw <= 0n) {
    const reason = input.side === "sell" && input.provenProceedsRaw === null
      ? "the VIRTUAL proceeds could not be decoded from the receipt, and Vex never charges a percentage of an amount nobody observed"
      : "the fee rounds to zero at this size, so no transfer is made";
    if (input.feeRowId !== null) {
      await abortRemainingCurvePlans(input.executionId, input.tradeLegCount, reason);
    }
    return notCharged(reason);
  }

  if (input.feeRowId === null) {
    // A fee DID apply but has no row to record it under - a different truth from
    // "no fee applies", and the audit surface must tell them apart. Nothing is
    // signed: a transfer with no audit row is exactly what the plan-before-sign
    // rule exists to prevent.
    return {
      collection: "not_attempted",
      collectionNote: "No Vex fee was taken: the fee leg had no recorded row, so nothing was signed. Your trade is unaffected.",
      txHash: null,
      feeAmountRaw: null,
      receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
    };
  }

  const feeRowId = input.feeRowId;
  try {
    const transfer = buildEvmVexFeeTransfer(input.deployment.virtual, feeRaw, VIRTUALS_CURVE_FEE_RECEIVER_EVM);
    if (transfer.kind !== "erc20") {
      // Structurally impossible - VIRTUAL is an ERC-20 on both chains - and
      // refused rather than asserted: a native transfer here would move ETH the
      // fee policy never mentions.
      throw new Error("The Virtuals curve fee must be an ERC-20 transfer of VIRTUAL.");
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
          if (!res.applied) logger.warn("virtuals.fee.broadcast_accept_miss", { id: feeRowId });
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
        collectionNote: "The Vex fee transfer reverted, so no fee was collected - your trade is unaffected.",
        txHash: outcome.txHash,
        feeAmountRaw: feeRaw.toString(),
        receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
      };
    }

    if (outcome.kind === "ambiguous") {
      logger.info("virtuals.fee.ambiguous", { id: feeRowId, stage: outcome.stage });
      await noteHandlerPendingReason("virtuals.fee", feeRowId, "fee_broadcast_ambiguous");
      return {
        collection: "unconfirmed",
        collectionNote:
          "The Vex fee transfer was broadcast but not confirmed this turn; it is tracked automatically and is never "
          + "re-sent. Your trade is unaffected.",
        txHash: outcome.txHash,
        feeAmountRaw: feeRaw.toString(),
        receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
      };
    }

    return {
      collection: await confirmFeeRow(feeRowId, outcome.txHash, feeRaw, input.deployment.virtualDecimals),
      collectionNote: `The Vex fee of ${formatUnits(feeRaw, input.deployment.virtualDecimals)} VIRTUAL was transferred to the treasury.`,
      txHash: outcome.txHash,
      feeAmountRaw: feeRaw.toString(),
      receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
    };
  } catch (err) {
    // Includes a gas-estimate refusal and a staging CAS miss. None of them may
    // touch the parent row.
    logger.warn("virtuals.fee.leg_failed", { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return {
      collection: "not_attempted",
      collectionNote: "The Vex fee transfer was refused before signing, so no fee was collected - your trade is unaffected.",
      txHash: null,
      feeAmountRaw: null,
      receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
    };
  }
}

function notCharged(reason: string): CurveFeeCollection {
  return {
    collection: "not_charged",
    collectionNote: `No Vex fee applies to this trade: ${reason}.`,
    txHash: null,
    feeAmountRaw: null,
    receiver: VIRTUALS_CURVE_FEE_RECEIVER_EVM,
  };
}

/** Never throws: the revert and its hash are established by the receipt. */
async function recordFeeRevert(feeRowId: number, txHash: string): Promise<void> {
  try {
    await failActivityEvent(feeRowId, {
      failureCode: "mined_revert",
      failureReason: `Vex fee transfer ${txHash} reverted on-chain; the curve trade itself was unaffected.`,
    });
  } catch (err) {
    logger.warn("virtuals.fee.revert_record_failed", { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
  }
}

/**
 * A non-applied CAS confirm (the reconciler already finalized this row) must not
 * read as a clean confirm - mirrors the trade path's own confirm.
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
    logger.warn("virtuals.fee.confirm_cas_miss", { id: feeRowId, rowStatus: result.row.status });
    return "confirmed_unrecorded";
  } catch (err) {
    logger.warn("virtuals.fee.confirm_failed", { id: feeRowId, error: err instanceof Error ? err.name : "unknown" });
    return "confirmed_unrecorded";
  }
}
