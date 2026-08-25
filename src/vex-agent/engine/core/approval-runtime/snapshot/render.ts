/**
 * Approval runtime — locked-tx snapshot phase: row shaping.
 *
 * Shapes the denormalised `IntentSnapshotRow` from the locked intent+queue+
 * session join. The SELECT acquires `FOR UPDATE OF i, q, s` so the live
 * permission read is serialized, but it performs NO writes — the row shape is
 * pure projection consumed by the compare/build phases.
 *
 * The Studio columns (migration 086) ride along for the same reason the queue
 * columns do: the post-tx side effects have to know WHICH KIND of approval this
 * is before they can decide whether to append a transcript message or write a
 * settlement, and a second query for that would be a second read of a row this
 * transaction already locked.
 */

export const SNAPSHOT_SELECT_SQL = `SELECT
    i.approval_id,
    i.session_id,
    i.mission_run_id,
    i.tool_call_id,
    i.expires_at,
    i.preview_json,
    i.decision,
    i.decision_reason,
    i.decided_at,
    i.execution_status,
    i.execution_result_hash,
    i.origin,
    i.project_id,
    i.scope_version_at_enqueue,
    i.request_digest,
    q.status            AS queue_status,
    q.resolved_at       AS queue_resolved_at,
    q.created_at        AS queue_created_at,
    q.tool_call         AS queue_tool_call,
    q.tool_call_id      AS queue_tool_call_id,
    q.permission_at_enqueue AS queue_permission_at_enqueue,
    s.permission        AS session_permission_live
  FROM approval_intents i
  JOIN approval_queue q ON q.id = i.approval_id
  JOIN sessions s ON s.id = i.session_id
  WHERE i.approval_id = $1
  FOR UPDATE OF i, q, s`;
