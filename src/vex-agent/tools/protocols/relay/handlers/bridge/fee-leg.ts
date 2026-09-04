/**
 * The Vex integrator fee on a Relay bridge: how it is DISCLOSED on every surface
 * (quote, dryRun, execute) and how it is COLLECTED - always last, always after
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
  bridgeFeeStatementChangedMessage,
  buildBridgeFeeDisclosure,
  buildBridgeFeeSkippedDisclosure,
  buildEvmBridgeFeeTransfer,
  checkBridgeFeeStatementUnchanged,
  missingBridgeFeeStatementMessage,
  unauthorizedBridgeQuoteMessage,
  unregisteredBridgeFeeGateMessage,
  VEX_FEE_GATE_UNREGISTERED_REASON,
  VEX_FEE_QUOTE_UNAUTHORIZED_REASON,
  VEX_FEE_STATEMENT_CHANGED_REASON,
  VEX_FEE_STATEMENT_MISSING_REASON,
  type BridgeFeeDisclosure,
  type BridgeFeeRefusal,
} from "@tools/bridge-fee/index.js";
import { findFreshMatchedPrequote } from "@vex-agent/tools/protocols/prequote/gate.js";
import type { RelayQuoteSide } from "@tools/relay/quote.js";
import type { RelayStepClients } from "@tools/relay/execute.js";
import { signStageBroadcast } from "@tools/kyberswap/evm/staged-broadcast.js";
import {
  confirmActivityEvent,
  failActivityEvent,
  markActivityBroadcast,
  reserveActivityEvmNonce,
  markBroadcastAccepted,
  provenLegAmounts,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import { relayFeeUsdEstimate } from "../bridge-output.js";
import type { OriginBroadcast } from "./broadcast.js";
import type { RelayLegs } from "./legs.js";
import { BRIDGE_TOOL_ID } from "./constants.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import type { FeeNotTaken } from "./results.js";
import { abortRemaining } from "./recording.js";
import {
  isVerifiedEvmBridgeAssetIdentity,
  type BridgeAssetIdentity,
} from "@vex-agent/tools/protocols/bridge-token-identity.js";

export interface RelayFeeCollection {
  readonly collection: string;
  readonly collectionNote: string;
}

/** No fee applies to this bridge - the disclosure already states why. */
export const NO_FEE_COLLECTION: RelayFeeCollection = {
  collection: "not_charged",
  collectionNote: "No Vex fee applies to this bridge.",
};

/**
 * The fee, as the agent must see it on EVERY Relay surface (quote, dryRun,
 * execute). Pure projection of the already-resolved split - no second
 * derivation, so the disclosed number and the transferred number are the same
 * number by construction.
 */
export function relayFeeDisclosure(
  legs: RelayLegs,
  inSide: RelayQuoteSide,
  identity?: BridgeAssetIdentity,
): BridgeFeeDisclosure {
  if (legs.feeSkipReason !== null) {
    return buildBridgeFeeSkippedDisclosure({ reason: legs.feeSkipReason, totalRaw: legs.feeSplit.totalRaw });
  }
  const direct = isVerifiedEvmBridgeAssetIdentity(identity) ? identity : undefined;
  return buildBridgeFeeDisclosure({
    tokenAddress: legs.originCurrency,
    tokenSymbol: direct?.symbol ?? inSide.symbol ?? undefined,
    tokenDecimals: direct?.decimals ?? inSide.decimals ?? undefined,
    feeRaw: legs.feeSplit.feeRaw,
    bridgedRaw: legs.feeSplit.bridgedRaw,
    totalRaw: legs.feeSplit.totalRaw,
    receiver: BRIDGE_FEE_RECEIVER_EVM,
    feeUsdEstimate: relayFeeUsdEstimate(inSide, legs.feeSplit.feeRaw, identity) ?? undefined,
  });
}

/** The quote tool an agent must call again when this bridge refuses to sign. */
const RELAY_QUOTE_TOOL_NAME = "relay__bridge_quote_get";

/**
 * Hold this bridge to the Vex fee statement its approval was granted on, in the
 * pre-sign window.
 *
 * WHY IT RE-DERIVES AND THEN COMPARES, rather than consuming the bound block:
 * the disposition depends on facts that can move between the quote and the
 * signature (a token flagged fee-on-transfer or a honeypot after the card was
 * shown), and consuming the row would hand a treasury transfer to exactly the
 * token the fresh eligibility read just declined. Re-deriving alone is what Vex
 * did before this check and is equally wrong: it signs a fee nobody was shown.
 * So both are computed and any disagreement REFUSES.
 *
 * Returns the typed refusal, or `null` when this call may proceed. Every
 * refusal - including the structural one - carries its bounded reason, so the
 * public result can state WHY rather than collapsing into a generic bridge
 * failure.
 *
 * `not_gated` IS A REFUSAL HERE (round-2 blocker 4). It used to answer `null`,
 * which turned the loss of this tool's registry mapping into permission to sign
 * a fee: this handler is gated by construction and its whole fee authority is
 * the prequote row, so an absent registration means the fee cannot be bound to
 * anything anyone approved. Rule 07, fail closed.
 *
 * Nothing here signs, records or reserves anything: it runs BEFORE the intent,
 * the in-flight guard and the signing wallet, so a refusal leaves the world
 * exactly as it found it.
 */
export async function relayVexFeeStatementRefusal(input: {
  readonly params: Record<string, unknown>;
  readonly context: ProtocolExecutionContext;
  readonly sessionId: string;
  /** The disposition this call would actually execute on, freshly derived. */
  readonly derivedNow: BridgeFeeDisclosure;
}): Promise<BridgeFeeRefusal | null> {
  const matched = await findFreshMatchedPrequote(
    BRIDGE_TOOL_ID,
    input.sessionId,
    input.params,
    input.context,
  );
  if (!matched.ok) {
    // Destructured so the literal narrows.
    const { reason, eligibilityKind } = matched;
    if (reason === "not_gated") {
      logger.error("relay.bridge.vex_fee_gate_unregistered", {
        reason: VEX_FEE_GATE_UNREGISTERED_REASON,
        toolId: BRIDGE_TOOL_ID,
      });
      return {
        reason: VEX_FEE_GATE_UNREGISTERED_REASON,
        movedFields: [],
        message: unregisteredBridgeFeeGateMessage(BRIDGE_TOOL_ID),
        remediation: "Report this build defect; a re-quote cannot clear it.",
      };
    }
    return {
      reason: VEX_FEE_QUOTE_UNAUTHORIZED_REASON,
      movedFields: [],
      message: unauthorizedBridgeQuoteMessage({ reason, eligibilityKind }, RELAY_QUOTE_TOOL_NAME),
      remediation: `Call ${RELAY_QUOTE_TOOL_NAME} again and approve the fresh quote.`,
    };
  }
  if (matched.vexFee === undefined) {
    logger.warn("relay.bridge.vex_fee_statement_missing", { reason: VEX_FEE_STATEMENT_MISSING_REASON });
    return {
      reason: VEX_FEE_STATEMENT_MISSING_REASON,
      movedFields: [],
      message: missingBridgeFeeStatementMessage(RELAY_QUOTE_TOOL_NAME),
      remediation: `Call ${RELAY_QUOTE_TOOL_NAME} again and approve the fresh quote.`,
    };
  }
  const check = checkBridgeFeeStatementUnchanged({
    statedOnCard: matched.vexFee,
    derivedNow: input.derivedNow,
  });
  if (check.ok) return null;
  // The FIELD only. The two values include a treasury address and the amounts a
  // card showed; the bounded reason plus the field name is what an operator
  // needs, and the agent gets the rest in the refusal itself.
  logger.warn("relay.bridge.vex_fee_statement_changed", {
    reason: VEX_FEE_STATEMENT_CHANGED_REASON,
    field: check.field,
  });
  return {
    reason: VEX_FEE_STATEMENT_CHANGED_REASON,
    movedFields: [check.field],
    message: bridgeFeeStatementChangedMessage(check, RELAY_QUOTE_TOOL_NAME),
    remediation: `Call ${RELAY_QUOTE_TOOL_NAME} again and approve the fresh quote.`,
  };
}

/** Disclosure for every path where the bridge did not complete - nothing is ever charged there. */
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
        onNonceReserved: (request) => reserveActivityEvmNonce(legRowId, request),
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(legRowId, handles);
          if (!res.applied) {
            throw new Error(`markActivityBroadcast CAS miss for Vex fee leg ${legRowId} - refusing to broadcast untracked`);
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
        collectionNote: "The bridge went through. The Vex fee transfer reverted, so no fee was collected - your bridge is unaffected.",
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
      // exact `feeSplit.feeRaw` we signed - not a quote, not a provider's word.
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
      collectionNote: "The bridge went through. The Vex fee transfer was refused before signing, so no fee was collected - your bridge is unaffected.",
    };
  }
}
