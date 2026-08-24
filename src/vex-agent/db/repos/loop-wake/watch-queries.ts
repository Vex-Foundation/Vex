/**
 * Wake-WATCH queries - the reads and the promotion that back `LoopDefer`'s
 * `watch` parameter.
 *
 * Split out of `loop-wake.ts` (which owns enqueue / claim / cancel, the row
 * lifecycle) because the watch surface changes for a different reason: it grows
 * a query every time a new watch TYPE learns how to find its own pending rows.
 * `loop-wake.ts` re-exports everything here, so no caller's import changed.
 */

import { execute, query } from "../../client.js";
import { jsonb } from "../../params.js";
import { mapRow, type LoopWakeRequest, type LoopWakeRow } from "./row.js";

/** Pending rows with a versioned generic watch payload. */
export async function getPendingWithWatch(): Promise<LoopWakeRequest[]> {
  const rows = await query<LoopWakeRow>(
    `SELECT * FROM loop_wake_requests
     WHERE status = 'pending'
       AND payload ? 'watchId'
       AND payload ? 'conditions'
     ORDER BY due_at ASC`,
  );
  return rows.map(mapRow);
}

/**
 * Pending rows carrying at least one watch condition of `conditionType`.
 *
 * The PULL half of the watch system needs this: the price poller runs on its
 * own 3 s tick and must not read, deserialize and scan every session's bridge
 * watches to discover that none of them is its business. The containment
 * predicate is evaluated by Postgres against the JSONB, so an idle poller costs
 * one indexless scan of the (small, pending-only) wake table and returns zero
 * rows.
 *
 * `conditionType` is a build-time constant supplied by the owning evaluator,
 * never model input.
 */
export async function getPendingWithWatchType(
  conditionType: string,
): Promise<LoopWakeRequest[]> {
  const rows = await query<LoopWakeRow>(
    `SELECT * FROM loop_wake_requests
     WHERE status = 'pending'
       AND payload ? 'watchId'
       AND payload -> 'conditions' @> $1::jsonb
     ORDER BY due_at ASC`,
    [jsonb([{ type: conditionType }])],
  );
  return rows.map(mapRow);
}

/**
 * What woke the session early. Written onto the wake row by the promotion that
 * actually advanced the deadline, so the banner can say WHY rather than leaving
 * the model to infer it from a timer that fired suspiciously early.
 *
 * Values are produced by the poller from validated provider data, never copied
 * out of model input.
 */
export interface WakeTriggeredBy {
  readonly type: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly direction: string;
  readonly thresholdUsd: string;
  readonly observedPriceUsd: string;
  readonly observedAt: string;
}

export interface PromotePendingWakeInput {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly watchId: string;
  /**
   * OPTIONAL, and it changes the predicate on purpose. When present the UPDATE
   * additionally requires `due_at > NOW()`, so `affected > 0` PROVES this
   * statement is the one that advanced the deadline. Without that, a row whose
   * deadline had already passed (timer wake, or a second condition that fired
   * first) would report `true` and get stamped with a cause it did not have.
   * At most one promotion can therefore ever claim a wake.
   */
  readonly triggeredBy?: WakeTriggeredBy;
}

/**
 * Move a matching wake deadline to now, NEVER later - `LEAST(due_at, NOW())`,
 * so a promotion can only ever make the session wake sooner. A watch is an
 * optimization over the timer; it must not be able to extend a wait.
 *
 * TWO SHAPES, matching the two shapes of wake row (see `loop-wake.ts`):
 *
 *   - MISSION RUN (`missionRunId` set) joins `mission_runs` and requires the run
 *     to still be `paused_wake`. That predicate is what stops a stale trigger
 *     from promoting a run that a user message or a terminal transition already
 *     resumed.
 *   - AGENT SESSION (`missionRunId === null`) has no run row to join, so the
 *     pending wake row IS the park - exactly the invariant
 *     `scheduleAgentSessionContinuation` already relies on. `mission_run_id IS
 *     NULL` is asserted explicitly rather than left to a parameter compare,
 *     because `= NULL` is never true in SQL and would silently promote nothing.
 */
export async function promotePendingWake(
  input: PromotePendingWakeInput,
): Promise<boolean> {
  const stamping = input.triggeredBy !== undefined;

  if (input.missionRunId === null) {
    const params: unknown[] = [input.sessionId, input.watchId];
    if (stamping) params.push(jsonb(input.triggeredBy));
    const affected = await execute(
      `UPDATE loop_wake_requests AS wake
       SET due_at = LEAST(wake.due_at, NOW())${stamping ? triggeredBySetClause(3) : ""}
       WHERE wake.session_id = $1
         AND wake.mission_run_id IS NULL
         AND wake.status = 'pending'
         AND wake.payload->>'watchId' = $2${stamping ? "\n         AND wake.due_at > NOW()" : ""}`,
      params,
    );
    return affected > 0;
  }

  const params: unknown[] = [input.sessionId, input.missionRunId, input.watchId];
  if (stamping) params.push(jsonb(input.triggeredBy));
  const affected = await execute(
    `UPDATE loop_wake_requests AS wake
     SET due_at = LEAST(wake.due_at, NOW())${stamping ? triggeredBySetClause(4) : ""}
     FROM mission_runs AS run
     WHERE wake.session_id = $1
       AND wake.mission_run_id = $2
       AND wake.status = 'pending'
       AND wake.payload->>'watchId' = $3
       AND run.id = wake.mission_run_id
       AND run.status = 'paused_wake'${stamping ? "\n       AND wake.due_at > NOW()" : ""}`,
    params,
  );
  return affected > 0;
}

function triggeredBySetClause(paramIndex: number): string {
  return `,\n           payload = COALESCE(wake.payload, '{}'::jsonb)`
    + `\n                     || jsonb_build_object('triggeredBy', $${paramIndex}::jsonb)`;
}
