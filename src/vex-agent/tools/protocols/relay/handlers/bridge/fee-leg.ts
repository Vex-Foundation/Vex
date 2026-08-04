/**
 * The Vex integrator fee on a Relay bridge: how it is DISCLOSED on every surface
 * (quote, dryRun, execute) and how it is COLLECTED — always last, always after
 * the origin deposit is confirmed, never as a claim about the bridge itself.
 *
 * Money-path ordering (audit §4, KEEP): a bridge that never lands never pays a
 * fee, and a fee that does not land is missed Vex revenue on a bridge that DID
 * happen. Nothing in this module may fail a bridge.
 *
 * Extracted verbatim from `../bridge.ts` as part of a façade-preserving
 * structural split (SPEC wave 0R.2). `../bridge.ts` remains the public entry
 * point.
 */

import {
  BRIDGE_FEE_RECEIVER_EVM,
  buildBridgeFeeDisclosure,
  buildBridgeFeeSkippedDisclosure,
  buildEvmBridgeFeeTransfer,
  type BridgeFeeDisclosure,
} from "@tools/bridge-fee/index.js";
import type { RelayQuoteSide } from "@tools/relay/quote.js";
import type { RelayStepClients } from "@tools/relay/execute.js";
import { signStageBroadcast } from "@tools/kyberswap/evm/staged-broadcast.js";
import {
  confirmActivityEvent,
  failActivityEvent,
  markActivityBroadcast,
  markBroadcastAccepted,
  provenLegAmounts,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import { relayFeeUsdEstimate } from "../bridge-output.js";
import type { OriginBroadcast } from "./broadcast.js";
import type { RelayLegs } from "./legs.js";
import type { FeeNotTaken } from "./results.js";
import { abortRemaining } from "./recording.js";

export interface RelayFeeCollection {
  readonly collection: string;
  readonly collectionNote: string;
}

/** No fee applies to this bridge — the disclosure already states why. */
export const NO_FEE_COLLECTION: RelayFeeCollection = {
  collection: "not_charged",
  collectionNote: "No Vex fee applies to this bridge.",
};

/**
 * The fee, as the agent must see it on EVERY Relay surface (quote, dryRun,
 * execute). Pure projection of the already-resolved split — no second
 * derivation, so the disclosed number and the transferred number are the same
 * number by construction.
 */
export function relayFeeDisclosure(legs: RelayLegs, inSide: RelayQuoteSide): BridgeFeeDisclosure {
  if (legs.feeSkipReason !== null) {
    return buildBridgeFeeSkippedDisclosure({ reason: legs.feeSkipReason, totalRaw: legs.feeSplit.totalRaw });
  }
  return buildBridgeFeeDisclosure({
    tokenAddress: legs.originCurrency,
    tokenSymbol: inSide.symbol ?? undefined,
    tokenDecimals: inSide.decimals ?? undefined,
    feeRaw: legs.feeSplit.feeRaw,
    bridgedRaw: legs.feeSplit.bridgedRaw,
    totalRaw: legs.feeSplit.totalRaw,
    receiver: BRIDGE_FEE_RECEIVER_EVM,
    feeUsdEstimate: relayFeeUsdEstimate(inSide, legs.feeSplit.feeRaw) ?? undefined,
  });
}

/** Disclosure for every path where the bridge did not complete — nothing is ever charged there. */
export function feeNotTaken(legs: RelayLegs): FeeNotTaken {
  return {
    ...buildBridgeFeeSkippedDisclosure({
      reason: "the bridge did not complete, so no Vex fee was taken",
      totalRaw: legs.feeSplit.totalRaw,
    }),
    collection: "not_attempted",
    collectionNote: "No Vex fee was taken: the bridge did not complete.",
  };
}

/**
 * Sign, stage, broadcast and record the Vex fee transfer on the origin chain.
 * Never throws and never touches the logical fill row: the bridge already
 * happened, so every failure path here is missed revenue reported honestly,
 * not a bridge failure and not a claim that user funds are at risk.
 */
export async function runRelayVexFeeLeg(input: {
  readonly executionId: number;
  readonly legRowId: number | undefined;
  readonly feeLegIndex: number;
  readonly tokenAddress: string;
  readonly feeRaw: bigint;
  readonly clients: RelayStepClients;
  readonly broadcasts: OriginBroadcast[];
}): Promise<RelayFeeCollection> {
  const { executionId, legRowId, feeLegIndex, broadcasts } = input;
  if (legRowId === undefined) {
    logger.warn("relay.bridge.fee_leg_row_missing", { executionId, index: feeLegIndex });
    return {
      collection: "not_attempted",
      collectionNote: "The bridge went through. The Vex fee had no recorded row, so no fee was taken.",
    };
  }
  try {
    const transfer = buildEvmBridgeFeeTransfer(input.tokenAddress, input.feeRaw);
    const outcome = await signStageBroadcast(
      input.clients.publicClient,
      input.clients.walletClient,
      {
        to: transfer.to,
        data: transfer.kind === "erc20" ? transfer.data : "0x",
        value: transfer.value,
      },
      {
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(legRowId, handles);
          if (!res.applied) {
            throw new Error(`markActivityBroadcast CAS miss for Vex fee leg ${legRowId} — refusing to broadcast untracked`);
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(legRowId);
          if (!res.applied) logger.warn("relay.bridge.fee_accept_miss", { id: legRowId });
        },
      },
    );

    if (outcome.kind === "reverted") {
      broadcasts.push({ role: "vex_fee", txHash: outcome.txHash, status: "reverted" });
      await failActivityEvent(legRowId, {
        failureCode: "mined_revert",
        failureReason: `Vex fee transfer ${outcome.txHash} reverted on-chain; the bridge itself was unaffected.`,
      });
      return {
        collection: "reverted",
        collectionNote: "The bridge went through. The Vex fee transfer reverted, so no fee was collected — your bridge is unaffected.",
      };
    }
    if (outcome.kind === "ambiguous") {
      // Left PENDING with its staged hash for the receipt sweep. NEVER retried
      // here: a blind retry could charge the user twice.
      broadcasts.push({ role: "vex_fee", txHash: outcome.txHash, status: "broadcast_unconfirmed" });
      return {
        collection: "unconfirmed",
        collectionNote: "The bridge went through. The Vex fee transfer was broadcast but not confirmed this turn; it is tracked automatically and is never re-sent.",
      };
    }

    let legStatus: OriginBroadcast["status"] = "confirmed";
    try {
      // R1 Step 3b: Vex COMPOSED this transfer, so its atomic amount is the
      // exact `feeSplit.feeRaw` we signed — not a quote, not a provider's word.
      // It is therefore one of the few legs whose executed amount may be written
      // at return time, and doing so is what puts the collected fee on the feed
      // row instead of leaving it to a decode that may never happen.
      const confirmResult = await confirmActivityEvent(
        legRowId,
        provenLegAmounts("bridge_fee", {
          kind: "vex_built_exact",
          amountRaw: input.feeRaw.toString(),
        }),
      );
      if (!confirmResult.applied && confirmResult.row.status !== "confirmed") {
        legStatus = "confirmed_unrecorded";
        logger.warn("relay.bridge.fee_confirm_cas_miss", { id: legRowId, rowStatus: confirmResult.row.status });
      }
    } catch (err) {
      legStatus = "confirmed_unrecorded";
      logger.warn("relay.bridge.fee_confirm_failed", { id: legRowId, error: summarizeProtocolError(err).message });
    }
    broadcasts.push({ role: "vex_fee", txHash: outcome.txHash, status: legStatus });
    return {
      collection: legStatus,
      collectionNote: "The bridge went through and the Vex fee was transferred to the treasury.",
    };
  } catch (err) {
    logger.warn("relay.bridge.fee_leg_failed", { executionId, error: summarizeProtocolError(err).message });
    await abortRemaining(executionId, feeLegIndex, "vex fee leg refused before signing", feeLegIndex + 1);
    return {
      collection: "not_attempted",
      collectionNote: "The bridge went through. The Vex fee transfer was refused before signing, so no fee was collected — your bridge is unaffected.",
    };
  }
}
