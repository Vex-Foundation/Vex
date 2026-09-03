/**
 * The venue handlers' two BEST-EFFORT provenance writes at tool-return time
 * (R1 Steps 3a and 4), in one place so every venue states the same facts the
 * same way.
 *
 * WHY BEST-EFFORT, AND WHY THAT IS NOT A SILENT FAILURE. Both writes happen
 * AFTER a transaction is already in flight. A database hiccup at that moment
 * must not turn a broadcast-and-pending swap into a thrown tool error - the
 * money already moved, and an exception here would report the opposite. So the
 * failure is caught, LOGGED with its real cause, and (for the provider
 * observation) NAMED in the tool's own output. That is the repository's existing
 * convention for post-broadcast bookkeeping, applied to the 067 columns.
 *
 * The two writes answer two different questions:
 *
 *   `notePendingReason`              → WHY is this row still pending?
 *   `noteBridgeProviderObservation`  → WHAT did the provider say, and WHEN?
 *
 * Neither ever terminalizes a row. A handler that could not prove a settlement
 * records why it could not; it does not decide the outcome.
 */

import {
  notePendingReason,
  noteBridgeProviderObservation,
  type PendingReason,
  type NoteBridgeProviderObservationMiss,
} from "@vex-agent/db/repos/agent-activity.js";
import { describeFailureForLog } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/**
 * Record why a row the handler could not terminalize is still pending.
 *
 * Always `handler_return` context: a venue handler holds no pending-fallback
 * claim token, and asking it for one would be asking it to invent a fence it is
 * not inside. A miss is expected and normal - `already_reasoned` means the
 * fallback lane got there first with a fresher observation, which is precisely
 * the interleaving the write-once clause exists to respect.
 */
export async function noteHandlerPendingReason(
  toolId: string,
  rowId: number,
  reason: PendingReason,
): Promise<void> {
  try {
    const result = await notePendingReason(rowId, reason, { kind: "handler_return" });
    if (!result.applied) {
      logger.debug(`${toolId}.pending_reason_miss`, { rowId, reason, miss: result.reason });
    }
  } catch (err) {
    logger.warn(`${toolId}.pending_reason_failed`, {
      rowId,
      reason,
      error: describeFailureForLog(err),
    });
  }
}

/**
 * What the tool result must say about its own provider-status write (flag O-8).
 *
 * `providerStatusRecorded: null` means NO provider status was read this turn, so
 * there was nothing to record - deliberately distinct from `false`, which means
 * we read one and could NOT record it. A bare boolean cannot carry that
 * difference, and an agent that cannot tell "already terminal" from "the write
 * failed" retries blind.
 */
export interface ProviderStatusRecording {
  readonly providerStatusRecorded: boolean | null;
  readonly providerStatusRecordedReason: NoteBridgeProviderObservationMiss | null;
}

/** Nothing was read, so nothing was recorded - and the output says exactly that. */
export const NO_PROVIDER_STATUS_OBSERVED: ProviderStatusRecording = {
  providerStatusRecorded: null,
  providerStatusRecordedReason: null,
};

/**
 * Persist the handler's OWN in-turn provider observation on the logical bridge
 * row, and return what the tool result must disclose about that write.
 *
 * ORDERING, STATED HONESTLY. `observedAt` is the instant this function ran,
 * which is when the handler LEARNED the status, not necessarily the instant the
 * provider produced it: neither venue's poll returns its own observation clock.
 * The bound is therefore "no earlier than the true observation, by at most the
 * poll's last interval". That is the conservative direction for the CAS's
 * freshness comparison and it is the reason this timestamp is passed explicitly
 * rather than left to the database's `NOW()` - the writer must not pretend the
 * observation is fresher than the call that carries it. Narrowing the bound
 * needs an observation clock on the poll results themselves.
 */
export async function recordBridgeProviderObservation(input: {
  readonly toolId: string;
  readonly executionId: number;
  readonly providerStatus: string;
}): Promise<ProviderStatusRecording> {
  try {
    const result = await noteBridgeProviderObservation({
      executionId: input.executionId,
      providerStatus: input.providerStatus,
      observedAt: new Date().toISOString(),
    });
    if (result.applied) {
      return { providerStatusRecorded: true, providerStatusRecordedReason: null };
    }
    logger.info(`${input.toolId}.provider_status_not_recorded`, {
      executionId: input.executionId,
      miss: result.reason,
    });
    return {
      providerStatusRecorded: false,
      providerStatusRecordedReason: result.reason ?? "write_failed",
    };
  } catch (err) {
    logger.warn(`${input.toolId}.provider_status_write_failed`, {
      executionId: input.executionId,
      error: describeFailureForLog(err),
    });
    return { providerStatusRecorded: false, providerStatusRecordedReason: "write_failed" };
  }
}
