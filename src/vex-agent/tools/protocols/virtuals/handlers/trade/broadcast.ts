/**
 * One leg of a curve trade: reserve the nonce, sign, persist the hash, BROADCAST,
 * then wait for a bounded receipt.
 *
 * The three outcomes are three different truths and the differences are the
 * whole safety of the loop:
 *
 *  - CONFIRMED - the receipt says success. The caller may proceed to the next
 *    leg, and only a confirmed TRADE may reach the fee leg.
 *  - FAILED - either a refusal before anything reached the network (nothing was
 *    signed, no gas burned) or a MINED revert (bytes broadcast, gas spent). The
 *    two are discriminated by `stage` rather than inferred from a code, because
 *    they must never be described to a person in the same words.
 *  - AMBIGUOUS - the send or the receipt wait could not be resolved. It NEVER
 *    terminalizes: the row stays pending with its staged hash for the sweep, and
 *    the leg is never re-sent. MetaMask's PendingTransactionTracker marks such a
 *    transaction FAILED on a not-found timeout
 *    (`PendingTransactionTracker.ts:456-497`); our own wallet-reference audit
 *    records that as an explicit REJECTION and this lane keeps it rejected.
 *
 * The nonce is reserved through the shared durable allocator inside
 * `signStageBroadcast`, which holds a per-(address, chain) single flight from the
 * nonce fill through the signature - the ownership pattern MetaMask's
 * `getNextNonce` + `#approveTransaction` establishes (`utils/nonce.ts`,
 * `TransactionController.ts:3107-3179`), which our audit named as a gap to fix
 * and which this lane inherits rather than reimplementing.
 */

import type { Hex, TransactionReceipt } from "viem";

import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import type { ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { classifyCurveRevert } from "@tools/virtuals/curve/revert-mapping.js";
import type { BuiltCurveTx, getVirtualsCurveClients } from "@tools/virtuals/curve/index.js";
import {
  failActivityEvent,
  markActivityBroadcast,
  markBroadcastAccepted,
  reserveActivityEvmNonce,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

import { TRADE_TOOL_ID } from "./tool-ids.js";

export type CurveLegOutcome =
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

export async function runCurveLeg(input: {
  readonly event: AgentActivityEvent;
  readonly tx: BuiltCurveTx;
  readonly clients: ReturnType<typeof getVirtualsCurveClients>;
  readonly priorLeg: ConfirmedPriorLeg | undefined;
  /** Human name of this leg, for the agent-facing sentence. */
  readonly label: string;
}): Promise<CurveLegOutcome> {
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
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(event.id);
          if (!res.applied) logger.warn("virtuals.trade.broadcast_accept_miss", { id: event.id });
        },
      },
      input.priorLeg,
    );
  } catch (err) {
    // Nothing reached the network: the pre-sign estimate refused, the nonce
    // could not be reserved, or the staging CAS missed. The row is terminalized
    // hashless, which is exactly what "nothing was signed" means durably.
    const verdict = classifyCurveRevert(err);
    await recordLegFailure(event.id, verdict.kind === "unknown" ? "simulation_reverted" : failureCodeFor(verdict.kind), `${input.label}: ${verdict.reason}`);
    return { kind: "failed", stage: "pre_broadcast", reason: verdict.reason, txHash: null };
  }

  if (outcome.kind === "reverted") {
    const verdict = classifyCurveRevert(outcome.receipt);
    await recordLegFailure(event.id, "mined_revert", `${input.label} ${outcome.txHash} reverted on-chain: ${verdict.reason}`);
    return { kind: "failed", stage: "mined_revert", reason: verdict.reason, txHash: outcome.txHash };
  }

  if (outcome.kind === "ambiguous") {
    logger.info("virtuals.trade.leg_ambiguous", { id: event.id, stage: outcome.stage });
    await noteHandlerPendingReason(
      TRADE_TOOL_ID,
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

function failureCodeFor(kind: ReturnType<typeof classifyCurveRevert>["kind"]) {
  switch (kind) {
    case "slippage":
      return "slippage" as const;
    case "allowance_or_balance":
      return "allowance_or_balance" as const;
    case "token_status":
    case "invalid_input":
    case "unknown":
    default:
      return "simulation_reverted" as const;
  }
}

/**
 * Record a leg's terminal failure. Best-effort by contract: the outcome is
 * already established (a receipt, or the fact that nothing was signed), and no
 * repository failure may unsay it.
 */
async function recordLegFailure(
  eventId: number,
  failureCode: Parameters<typeof failActivityEvent>[1]["failureCode"],
  failureReason: string,
): Promise<void> {
  try {
    await failActivityEvent(eventId, { failureCode, failureReason });
  } catch (err) {
    logger.warn("virtuals.trade.leg_failure_record_failed", {
      id: eventId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
