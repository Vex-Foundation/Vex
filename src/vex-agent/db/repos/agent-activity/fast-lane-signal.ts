/**
 * Fast-lane signalling for the `agent_activity` CAS writes (Wave P).
 *
 * Arming and resolving are emitted from the CAS itself, not from the seven venue
 * handlers that call it. The CAS is the one place that knows a transition
 * actually APPLIED, and every emit here therefore satisfies the bus's
 * post-commit contract for free: each producing statement is a single
 * auto-committed UPDATE, so by the time the caller holds a mapped row the new
 * state is visible to any subscriber that re-reads.
 *
 * Both helpers RETURN THE ROW UNCHANGED so a call site can wrap its existing
 * `mapRow(row)` expression without restructuring the CAS result.
 *
 * `abortPlannedEvents` and the hashless-recovery sweep deliberately do NOT emit:
 * they terminalize rows that were NEVER signed (`tx_hash IS NULL`), so no lane
 * was ever armed for them and nothing settled on chain that a balance snapshot
 * could observe.
 */

import {
  emitPendingActivityArmed,
  emitPendingActivityResolved,
} from "../../../events/pending-activity-bus.js";
import type { AgentActivityEvent } from "./types.js";

/** Emit `armed` for a row whose signed submission just became watchable. */
export function armFastLane(row: AgentActivityEvent): AgentActivityEvent {
  emitPendingActivityArmed({
    activityId: row.id,
    chainFamily: row.chainFamily,
    chainId: row.chainId,
  });
  return row;
}

/** Emit `resolved` for a row that just reached a terminal status. */
export function resolveFastLane(row: AgentActivityEvent): AgentActivityEvent {
  emitPendingActivityResolved({
    activityId: row.id,
    chainFamily: row.chainFamily,
    chainId: row.chainId,
    status: row.status,
  });
  return row;
}
