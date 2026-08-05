/**
 * The ORIGIN-ONLY staged broadcast loop (R4/B3): for every signable Relay step,
 * planned row → sign → persist hash CAS → broadcast → mark accepted, with the
 * revert / ambiguous / post-intent-throw branches that end the bridge early.
 *
 * Vex signs ONLY origin steps; the destination fill is solver-signed and
 * externally observed. Any early end returns a finished `ToolResult` built by
 * `./results.js` — this module owns the sequencing, not the wording.
 *
 * Extracted verbatim from `../bridge.ts` as part of a façade-preserving
 * structural split (SPEC wave 0R.2). `../bridge.ts` remains the public entry
 * point.
 */

import type { Hex } from "viem";

import { planRelayStepTx, type RelayPollResult, type RelayStepClients } from "@tools/relay/execute.js";
import { relayNativeValueGuidance, relayStepLabel } from "@tools/relay/native-value.js";
import type { RelaySignableStep } from "@tools/relay/step-policy.js";
import { signStageBroadcast } from "@tools/kyberswap/evm/staged-broadcast.js";
import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
  priorLegAnchorFrom,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { RelayStepRole } from "@tools/relay/step-policy.js";
import {
  confirmActivityEvent,
  provenLegAmounts,
  failActivityEvent,
  markActivityBroadcast,
  markBroadcastAccepted,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import type { BridgeEndpointDisplay } from "../bridge-output.js";
import type { RelayFeeCollection } from "./fee-leg.js";
import type { RelayLegs } from "./legs.js";
import { abortRemaining, attachRequestIdBestEffort, maybeAutoPin } from "./recording.js";
import {
  approvalUnconfirmedResult,
  gasEstimateNotAttemptedResult,
  interruptedResult,
  nativeValueNotAttemptedResult,
  originRevertedResult,
  type FeeNotTaken,
} from "./results.js";

export interface OriginBroadcast {
  /**
   * `vex_fee` is Vex's OWN treasury transfer, not a Relay step — surfaced with
   * its own display role so the agent can tell it apart from a real approval
   * (the durable row records it under `allowance`, the closest existing
   * `event_role`; see `BRIDGE_FEE_ACTIVITY_EVENT_ROLE`).
   */
  readonly role: RelayStepRole | "vex_fee";
  readonly txHash: string;
  // `confirmed_unrecorded` (m5-relay / Phase-1 C41): the origin tx confirmed
  // on-chain but Vex's durable confirm write did NOT apply — never present it as
  // an ordinary confirmation.
  readonly status: "confirmed" | "confirmed_unrecorded" | "broadcast_unconfirmed" | "reverted";
}

/**
 * Either every signable origin step confirmed (the caller continues to the fee
 * leg and the poll), or the bridge ended in this loop and the finished body is
 * already built.
 */
export type OriginBroadcastRun =
  | { readonly kind: "confirmed"; readonly broadcasts: OriginBroadcast[] }
  | { readonly kind: "ended"; readonly result: ToolResult };

export interface OriginBroadcastInput {
  readonly signable: readonly RelaySignableStep[];
  readonly legRows: readonly { readonly id: number }[];
  readonly logicalRowId: number;
  readonly executionId: number;
  readonly requestId: string;
  readonly legs: RelayLegs;
  readonly clients: RelayStepClients;
  readonly expectedFrom: Hex;
  readonly walletAddress: string;
  /** Index of the planned Vex fee row, or -1 when no fee applies. */
  readonly feeLegIndex: number;
  readonly from: BridgeEndpointDisplay;
  readonly to: BridgeEndpointDisplay;
  readonly feeNotTaken: FeeNotTaken;
  /** Builds the pending body from the caller's already-captured display context. */
  readonly pending: (args: {
    broadcasts: readonly OriginBroadcast[];
    poll: RelayPollResult | null;
    depositUnconfirmed: boolean;
    feeCollection: RelayFeeCollection;
  }) => ToolResult;
}

export async function runOriginBroadcasts(input: OriginBroadcastInput): Promise<OriginBroadcastRun> {
  const { signable, legRows, executionId, requestId, legs, clients, from, to, feeLegIndex } = input;
  const broadcasts: OriginBroadcast[] = [];
  let currentIndex = 0;
  // Read-after-write anchor for the NEXT origin leg: the approve leg this loop
  // just confirmed is exactly the state the deposit leg's pre-sign estimate
  // depends on, and the estimating node does not always have it yet (live
  // 2026-07-25, deposit `0xc96bfee1…` — `dependent-leg-gas-estimate.ts`).
  let priorLeg: ConfirmedPriorLeg | undefined;
  try {
    for (let i = 0; i < signable.length; i++) {
      currentIndex = i;
      const stepEntry = signable[i]!;
      const legRow = legRows[i]!;
      // The native-value context is what Vex DERIVED for this bridge, never an
      // echo of the quote: `legs.amount` is the post-fee amount Vex asked Relay
      // for, and `legs.originCurrency` is the resolved origin asset. The planner
      // refuses the step if the provider's `tx.value` carries anything beyond
      // it (`@tools/relay/native-value.ts`).
      const txParams = planRelayStepTx(stepEntry.step, legs.originChainId, input.expectedFrom, {
        role: stepEntry.role,
        originCurrency: legs.originCurrency,
        tradeType: legs.tradeType,
        bridgedAmountRaw: legs.amount,
      });
      const outcome = await signStageBroadcast(clients.publicClient, clients.walletClient, txParams, {
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(legRow.id, handles);
          if (!res.applied) {
            // A CAS miss means the row is no longer the pending/hashless row we
            // expect — refuse to broadcast an UNTRACKED transaction (throwing
            // here aborts signStageBroadcast BEFORE sendRawTransaction).
            throw new Error(`markActivityBroadcast CAS miss for leg ${legRow.id} — refusing to broadcast untracked`);
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(legRow.id);
          if (!res.applied) logger.warn("relay.bridge.broadcast_accept_miss", { id: legRow.id });
        },
      }, priorLeg);

      if (outcome.kind === "reverted") {
        broadcasts.push({ role: stepEntry.role, txHash: outcome.txHash, status: "reverted" });
        await failActivityEvent(legRow.id, {
          failureCode: "bridge_failed",
          failureReason: `origin ${stepEntry.role} transaction ${outcome.txHash} reverted on-chain.`,
        });
        await failActivityEvent(input.logicalRowId, {
          failureCode: "bridge_failed",
          failureReason: `origin ${stepEntry.role} reverted (${outcome.txHash}); the bridge did not execute.`,
        });
        await abortRemaining(executionId, i + 1, `earlier ${stepEntry.role} reverted`);
        return {
          kind: "ended",
          result: originRevertedResult({
            executionId, requestId, role: stepEntry.role, txHash: outcome.txHash,
            from, to, broadcasts, vexFee: input.feeNotTaken,
          }),
        };
      }

      if (outcome.kind === "ambiguous") {
        broadcasts.push({ role: stepEntry.role, txHash: outcome.txHash, status: "broadcast_unconfirmed" });
        if (stepEntry.role === "bridge_deposit") {
          // Deposit in-flight → attach the order id so W4 can track it, leave the
          // logical row PENDING, and DO NOT poll (the origin receipt is itself
          // uncertain). Deposit is the last signable step, so nothing follows.
          await attachRequestIdBestEffort(executionId, requestId);
          await maybeAutoPin(input.walletAddress, legs);
          // An unconfirmed deposit is never charged: finalize ONLY the fee row
          // (bounded), leaving the logical row pending for the W4 sweep.
          if (feeLegIndex !== -1) {
            await abortRemaining(executionId, feeLegIndex, "deposit unconfirmed; fee not attempted", feeLegIndex + 1);
          }
          return {
            kind: "ended",
            result: input.pending({
              broadcasts, poll: null, depositUnconfirmed: true,
              feeCollection: {
                collection: "not_attempted",
                collectionNote: "No Vex fee was taken: the origin deposit is not confirmed, so the bridge has not been charged.",
              },
            }),
          };
        }
        // An ambiguous APPROVE means the deposit will not be signed → the bridge
        // will not execute; abort the deposit + logical row as not-attempted.
        // The approve leg keeps its staged hash (the receipt sweep owns it).
        await abortRemaining(executionId, i + 1, `${stepEntry.role} could not be confirmed`);
        return {
          kind: "ended",
          result: approvalUnconfirmedResult({
            executionId, txHash: outcome.txHash, from, to, broadcasts, vexFee: input.feeNotTaken,
          }),
        };
      }

      // confirmed on origin — but never present an UNRECORDED confirmation as
      // ordinary (m5-relay / Phase-1 C41): the on-chain tx is confirmed, yet if
      // the durable confirm CAS misses to a non-confirmed state (the row is no
      // longer the pending row we expect), Vex's own record did not capture it.
      // `applied:false` with the row already `confirmed` is a benign race (a
      // repair sweep beat us) and stays ordinary; any other state is surfaced as
      // `confirmed_unrecorded`.
      let legStatus: OriginBroadcast["status"] = "confirmed";
      priorLeg = priorLegAnchorFrom(outcome.receipt.blockNumber);
      try {
        // R1 Step 3b, the NO-amount arm, stated rather than left silent.
        // Confirming this leg proves it was INCLUDED; it does not prove what it
        // moved. Relay's own native-value module says the principal is provable
        // only when the origin asset IS the chain's native currency — on an
        // ERC-20 route it travels as provider calldata and `tx.value` is zero —
        // and the final gate authorizes exactly such a zero-value deposit "with
        // no components". Writing the quoted amount here would state a
        // settlement this repository's authorization layer refuses to state.
        // The amounts are left to a decode that can prove them.
        const confirmResult = await confirmActivityEvent(
          legRow.id,
          provenLegAmounts(stepEntry.role, { kind: "opaque_provider_payload" }),
        );
        if (!confirmResult.applied && confirmResult.row.status !== "confirmed") {
          legStatus = "confirmed_unrecorded";
          logger.warn("relay.bridge.leg_confirm_cas_miss", { id: legRow.id, rowStatus: confirmResult.row.status });
        }
      } catch (err) {
        legStatus = "confirmed_unrecorded";
        logger.warn("relay.bridge.leg_confirm_failed", { id: legRow.id, error: summarizeProtocolError(err).message });
      }
      broadcasts.push({ role: stepEntry.role, txHash: outcome.txHash, status: legStatus });
      if (stepEntry.role === "bridge_deposit") {
        await attachRequestIdBestEffort(executionId, requestId);
      }
    }
  } catch (err) {
    // The intent already exists — abort the remaining never-signed rows (incl. the
    // logical row) and return with the SAME executionId; never create a second one.
    const safe = summarizeProtocolError(err).message;
    await abortRemaining(executionId, currentIndex, safe);
    logger.warn("relay.bridge.post_intent_failure", { executionId, index: currentIndex, error: safe });
    if (err instanceof DependentLegGasEstimateError) {
      return {
        kind: "ended",
        result: gasEstimateNotAttemptedResult({
          executionId, requestId,
          refusedRole: signable[currentIndex]?.role ?? "bridge_deposit",
          guidance: dependentLegEstimateGuidance(err),
          safe, from, to, broadcasts, vexFee: input.feeNotTaken,
        }),
      };
    }
    if (err instanceof VexError && err.code === ErrorCodes.NATIVE_VALUE_UNAUTHORIZED) {
      const refusedRole = signable[currentIndex]?.role ?? "bridge_deposit";
      return {
        kind: "ended",
        result: nativeValueNotAttemptedResult({
          executionId, requestId,
          refusedLabel: relayStepLabel(refusedRole),
          message: `${safe} ${relayNativeValueGuidance(refusedRole)}`,
          from, to, broadcasts, vexFee: input.feeNotTaken,
        }),
      };
    }
    return {
      kind: "ended",
      result: interruptedResult({ executionId, safe, from, to, vexFee: input.feeNotTaken }),
    };
  }

  return { kind: "confirmed", broadcasts };
}
