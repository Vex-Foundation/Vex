/**
 * ANSWERING FROM THE DURABLE ROW - the reporting half of the Studio dispatch
 * path.
 *
 * Split out of `studio.ts` because it has its own reason to change: nothing
 * here decides or writes anything. It exists for the moments in which this
 * process's own write LOST - a CAS that matched zero rows, a write that threw -
 * and the outcome it intended is therefore a belief. Every one of those paths
 * comes here, reads the committed row, and reports what the row says.
 *
 * A row that is unreadable, missing, or still mid-flight is reported as
 * UNCONFIRMED rather than dressed up as a terminal state, and no settlement is
 * announced for it (`continuation.ts` gates the announce on the same terminal
 * predicate). The release then belongs to whichever writer does commit, and to
 * the broker's periodic durable read.
 */

import logger from "@utils/logger.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";

import type { ApproveSnapshot } from "../../snapshot.js";
import { studioRefusalText } from "../../studio/refusal-settlement.js";
import { isTerminalStudioState } from "../../studio/terminal-state.js";
import type {
  ApprovePrepareOutcome,
  PreparedContinuation,
} from "../../types.js";

/**
 * The sentence for an outcome that ran and could NOT be recorded. It says both
 * true things: the effect is unknown, and Vex does not even hold a terminal
 * record of it yet.
 */
export const UNRECORDED_AFTER_DISPATCH = studioRefusalText(
  "the action was started and Vex could neither prove its outcome nor record "
  + "one, so the outcome is UNKNOWN and it will NOT be retried",
);

/**
 * The sentence for a pre-dispatch refusal that could not be written and whose
 * row is not terminal. Nothing ran, and Vex says exactly that while admitting
 * the refusal is unconfirmed.
 */
export const UNCONFIRMED_REFUSAL = studioRefusalText(
  "Vex could not record its refusal of this action, so nothing was executed "
  + "but the approval may still be pending in Vex",
);

/**
 * Read the durable row and report ITS state, for every path whose own write
 * lost or could not be proven.
 *
 * A TERMINAL row is the answer, whole: its stored settlement text if it has
 * one, its execution status otherwise. A row that is unreadable, missing, or
 * still mid-flight is reported with `unprovenOutput` and, on the money path,
 * with `indeterminate` - the only status in the contract that means "this may
 * have taken effect and Vex cannot prove it". Nothing here writes.
 */
export async function reportDurableStudioRow(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "approved_in_tx" }>,
  continuation: PreparedContinuation,
  unprovenOutput: string,
  unprovenStatus: "failed" | "indeterminate" = "indeterminate",
): Promise<ApprovePrepareOutcome> {
  const base = {
    kind: "dispatched" as const,
    approvalId,
    resolvedAt: snapshot.queueResolvedAt,
    sessionId: snapshot.row.session_id,
    missionRunId: null,
    continuation,
  };
  let durable: Awaited<
    ReturnType<typeof approvalIntentsRepo.getStudioSettlementByApprovalId>
  > = null;
  try {
    durable = await approvalIntentsRepo.getStudioSettlementByApprovalId(approvalId);
  } catch (cause) {
    logger.warn("engine.studio.durable_row_unreadable", {
      approvalId,
      errorName: cause instanceof Error ? cause.name : "unknown",
    });
  }
  if (
    durable === null
    || !isTerminalStudioState({
      decision: durable.decision,
      executionStatus: durable.executionStatus,
    })
  ) {
    return {
      ...base,
      executionStatus: unprovenStatus,
      toolResult: { success: false, output: unprovenOutput },
    };
  }
  const stored = storedOutput(durable.settlement);
  const status =
    durable.executionStatus === "succeeded"
      ? "succeeded"
      : durable.executionStatus === "indeterminate"
        ? "indeterminate"
        : "failed";
  return {
    ...base,
    executionStatus: status,
    toolResult: {
      success: status === "succeeded",
      output: stored ?? unprovenOutput,
    },
  };
}

/** The text the winning writer stored, when the envelope carries one. */
function storedOutput(settlement: Record<string, unknown> | null): string | null {
  if (settlement === null) return null;
  const result = settlement.result;
  if (typeof result !== "object" || result === null) return null;
  const output = (result as Record<string, unknown>).output;
  return typeof output === "string" && output.length > 0 ? output : null;
}
