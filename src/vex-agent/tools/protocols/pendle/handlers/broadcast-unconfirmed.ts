/**
 * The Pendle broadcast-unconfirmed failure contract - ONE owner for the wording
 * the agent sees when a transaction is already on-chain but its outcome is not
 * known.
 *
 * Every mutating Pendle handler signs, broadcasts, and THEN reads the result
 * back (the Pendle asset catalogue, for USD valuation). A throw in that
 * read-back used to land in a catch whose `txHash` was out of scope, so the
 * agent was told a funded, already-broadcast trade had simply FAILED - and was
 * free to retry it with real funds (phase-4 card H-4).
 *
 * SCOPE, POST-CARD-B1. This is now the NARROW residual case. Pendle writes a
 * durable `agent_activity` row through `signed-broadcast.ts` and a `pendle`
 * settlement decoder is registered, so the ordinary post-broadcast outcomes -
 * ambiguous submit, mined revert, undecodable receipt - are owned there and
 * carry their own honest wording. This function is reached ONLY when something
 * throws in a handler's own read-back AFTER `sendPendleRouterTx` already
 * returned; the row exists and the repair sweep owns it, but the handler can no
 * longer state the outcome itself.
 *
 * The wording therefore keeps its refusal-to-retry, and now also tells the truth
 * that Pendle could NOT tell before: the attempt IS recorded and WILL resolve.
 * Saying "Vex has NOT recorded this transaction" today would be its own version
 * of the phase-3 DEFECT 3 error - claiming more (or here, less) than the
 * evidence supports, in the direction that makes an agent act wrongly.
 *
 * `broadcast_unconfirmed` is the repo's existing term for this state
 * (`relay/handlers/bridge.ts`, `khalani/handlers/bridge-execute.ts`) and is
 * reused verbatim rather than paraphrased.
 *
 * Deliberate: the underlying reason is labelled as the READ-BACK's failure and
 * any retry advice inside it is explicitly disclaimed. The dominant
 * post-broadcast cause is `PENDLE_RATE_LIMITED`, whose hint is literally
 * "Wait and retry." - passing that through unqualified, next to a trade that is
 * already on-chain, would invite the double-spend this contract exists to
 * prevent.
 */

import type { Hex } from "viem";

import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import { failureDetail } from "./shared.js";

/**
 * A failure result for a Pendle transaction that WAS broadcast before the
 * error. Never reports success: the on-chain outcome is genuinely unknown, and
 * `success: true` for a trade we cannot prove settled would be a worse lie than
 * the one this replaces.
 */
export function broadcastUnconfirmedFailure(
  toolId: string,
  txHash: Hex,
  err: unknown,
): ToolResult {
  // failureDetail() also emits the bounded `pendle.handler.error` log line, so
  // the underlying cause stays in the operator log exactly as before.
  const detail = failureDetail(toolId, err);
  logger.warn("pendle.handler.broadcast_unconfirmed", { toolId, txHash });
  return {
    success: false,
    output:
      `${toolId}: broadcast_unconfirmed - the transaction WAS BROADCAST on-chain ` +
      `(tx ${txHash}) and its outcome is UNKNOWN. Vex failed AFTER signing, while ` +
      `reading the result back. DO NOT retry: the trade may already have executed, ` +
      `and a retry could execute it a second time with real funds. The attempt IS ` +
      `recorded as pending and resolves automatically once the receipt is read. ` +
      `Surface the hash to the user and confirm it on a block ` +
      `explorer before acting on this position again. Post-broadcast failure ` +
      `reason: ${detail} (that reason describes the failed read-back only - ` +
      `disregard any "retry" wording in it).`,
  };
}
