/**
 * The `loop_wake_requests` row shape and its DB-to-domain mapping.
 *
 * Its own module so `loop-wake.ts` (row lifecycle) and `watch-queries.ts`
 * (watch reads + promotion) share ONE mapping instead of each carrying a copy
 * that could drift. Re-exported by `loop-wake.ts`, which stays the public entry
 * point for every caller.
 */

export type LoopWakeStatus = "pending" | "consumed" | "cancelled";

export interface LoopWakeRequest {
  id: string;
  sessionId: string;
  /** `null` for a session-scoped agent continuation - see `loop-wake.ts`. */
  missionRunId: string | null;
  dueAt: string;
  status: LoopWakeStatus;
  reason: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  consumedAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
}

export interface LoopWakeRow {
  id: string;
  session_id: string;
  mission_run_id: string | null;
  due_at: string | Date;
  status: string;
  reason: string | null;
  payload: Record<string, unknown> | null;
  created_at: string | Date;
  consumed_at: string | Date | null;
  cancelled_at: string | Date | null;
  cancelled_reason: string | null;
}

function isoOrNull(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function mapRow(r: LoopWakeRow): LoopWakeRequest {
  return {
    id: r.id,
    sessionId: r.session_id,
    missionRunId: r.mission_run_id,
    dueAt: iso(r.due_at),
    status: r.status as LoopWakeStatus,
    reason: r.reason,
    payload: r.payload,
    createdAt: iso(r.created_at),
    consumedAt: isoOrNull(r.consumed_at),
    cancelledAt: isoOrNull(r.cancelled_at),
    cancelledReason: r.cancelled_reason,
  };
}
