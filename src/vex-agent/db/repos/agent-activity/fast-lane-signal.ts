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
  type PendingActivityLane,
} from "../../../events/pending-activity-bus.js";
import type { AgentActivityEvent } from "./types.js";

/**
 * Emit `armed` for a row that just became watchable.
 *
 * `lane` is NAMED HERE, at the authoritative CAS, because this is the only place
 * that knows which kind of row applied: a broadcast-accepted transition owns a
 * hash and arms `"onchain"`; `attachProviderOrderId` arms the logical
 * `bridge_fill_expected` row, whose fill is the bridge provider's to report and
 * which therefore arms `"provider"`. Downstream code reads this field and never
 * re-derives it from the payload.
 */
export function armFastLane(row: AgentActivityEvent, lane: PendingActivityLane): AgentActivityEvent {
  emitPendingActivityArmed({
    activityId: row.id,
    chainFamily: row.chainFamily,
    chainId: row.chainId,
    lane,
  });
  return row;
}

/**
 * Emit `resolved` for a row that just reached a terminal status.
 *
 * The lane is read off the row's OWN persisted `event_role` rather than passed
 * in: the terminal CAS primitives are shared (`failActivityEvent` terminalizes
 * both a signed swap and the logical bridge row), so a hardcoded lane at the
 * call site would be a lie for one of its callers. `event_role` is stored truth,
 * not an inference.
 */
export function resolveFastLane(row: AgentActivityEvent): AgentActivityEvent {
  emitPendingActivityResolved({
    activityId: row.id,
    chainFamily: row.chainFamily,
    chainId: row.chainId,
    lane: laneForRow(row),
    status: row.status,
  });
  return row;
}

/** The logical bridge-fill row is the only provider-owned role; everything else is locally signed. */
export function laneForRow(row: Pick<AgentActivityEvent, "eventRole">): PendingActivityLane {
  return row.eventRole === "bridge_fill_expected" ? "provider" : "onchain";
}
