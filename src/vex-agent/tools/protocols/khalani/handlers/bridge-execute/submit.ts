/**
 * `khalani.bridge` provider submit + order-id attach (steps 14 and 15 of the
 * staged-execute contract, split out in 0R.4, refactor-only). The deposit is
 * already confirmed on-chain here, so every failure is PENDING and tracked —
 * never a "do it again" instruction.
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import { attachProviderOrderId } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import { VexError } from "../../../../../../errors.js";
import type { ToolResult } from "../../../../types.js";
import {
  bridgeResult,
  fetchExistingOrderId,
  khalaniFailureMessage,
  type RecordedLeg,
} from "../bridge-support.js";
import { skipKhalaniFeeLeg } from "./fee-leg.js";
import type { KhalaniBridgePendingBase } from "./types.js";

export interface KhalaniSubmitInput {
  readonly executionId: number;
  readonly feeLegIndex: number;
  readonly quoteId: string;
  readonly routeId: string;
  readonly depositTxHash: string;
  readonly fromAddress: string;
  readonly pendingBase: KhalaniBridgePendingBase;
  readonly recordedLegs: readonly RecordedLeg[];
}

export type KhalaniSubmitOutcome =
  /** The order id to poll — the PERSISTED one, never a newly-returned conflicting one (m4). */
  | { readonly outcome: "attached"; readonly pollOrderId: string }
  | { readonly outcome: "halted"; readonly result: ToolResult };

export async function submitKhalaniDeposit(input: KhalaniSubmitInput): Promise<KhalaniSubmitOutcome> {
  const { executionId, quoteId, routeId, depositTxHash, pendingBase, recordedLegs } = input;

  // 14. Submit the confirmed deposit hash to Khalani → order id.
  let orderId: string;
  try {
    const submitted = await getKhalaniClient().submitDeposit({ quoteId, routeId, txHash: depositTxHash });
    orderId = submitted.orderId;
  } catch (err) {
    const externalName = err instanceof VexError ? err.externalName : undefined;
    if (externalName === "DuplicateRecordException") {
      // Already submitted — fetch the existing order (no new action).
      const existing = await fetchExistingOrderId(input.fromAddress, depositTxHash);
      if (existing) {
        orderId = existing;
      } else {
        logger.warn("khalani.bridge.duplicate_no_existing", { executionId });
        await skipKhalaniFeeLeg(input, "provider order could not be reconciled; fee not attempted");
        return {
          outcome: "halted",
          result: bridgeResult({ ...pendingBase, success: false, status: "pending", message: `The deposit (${depositTxHash}) was already submitted; its order could not be re-fetched in this turn but is recorded and tracked automatically. Do not re-bridge.`, legs: recordedLegs, depositTxHash }),
        };
      }
    } else {
      // Deposit is confirmed + recorded; W4 recovers the null-order-id row.
      logger.warn("khalani.bridge.submit_failed", { executionId, error: khalaniFailureMessage(err) });
      await skipKhalaniFeeLeg(input, "provider order submission pending; fee not attempted");
      return {
        outcome: "halted",
        result: bridgeResult({ ...pendingBase, success: false, status: "pending", message: `The deposit confirmed on-chain (${depositTxHash}) but the provider order submission is pending — it is recorded and tracked automatically. Do not re-bridge.`, legs: recordedLegs, depositTxHash }),
      };
    }
  }

  // 15. Attach the provider order id to the logical row (CAS, all outcomes).
  const attach = await attachProviderOrderId({ executionId, providerOrderId: orderId });
  // m4: the in-turn poll must use the PERSISTED order id, NEVER a newly-returned
  // conflicting one. On `conflict_different_id` the logical row already carries a
  // different id (that persisted id is the one to trust); on `not_pending` the row
  // may carry the id a prior attach/W4 recorded. Default to the id we just
  // submitted only when the fresh attach succeeded.
  if (attach.outcome === "conflict_different_id") {
    logger.warn("khalani.bridge.order_id_conflict", { executionId });
    const persisted = attach.row?.providerOrderId ?? null;
    if (!persisted) {
      // Defensive: a genuine conflict always carries a persisted id, but never
      // poll the conflicting id — skip the poll with a truthful pending output.
      await skipKhalaniFeeLeg(input, "provider order id could not be reconciled; fee not attempted");
      return {
        outcome: "halted",
        result: bridgeResult({
          ...pendingBase, success: false, status: "pending", depositTxHash,
          message: `The deposit confirmed on-chain (${depositTxHash}) but the provider order id could not be reconciled this turn — it is recorded and tracked automatically. Do not re-bridge.`,
          legs: recordedLegs,
        }),
      };
    }
    return { outcome: "attached", pollOrderId: persisted };
  }
  if (attach.outcome === "not_pending") {
    logger.info("khalani.bridge.attach_not_pending", { executionId });
    return { outcome: "attached", pollOrderId: attach.row?.providerOrderId ?? orderId };
  }
  return { outcome: "attached", pollOrderId: orderId };
}
