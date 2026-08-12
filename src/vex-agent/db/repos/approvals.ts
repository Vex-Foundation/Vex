/**
 * Approvals repo — tool execution approval queue.
 *
 * `permission_at_enqueue` is NOT NULL + CHECK (IN 'restricted'|'full').
 * The column is an audit
 * snapshot of `session.permission` at enqueue time; it does not authorize
 * re-dispatch on its own (approval flow handles the bypass via the
 * standard `approved: true` context flag).
 */

import type { PoolClient } from "pg";
import type { Permission } from "../../engine/types.js";
import { query, queryOne, execute } from "../client.js";
import { jsonb, nullableJsonb } from "../params.js";

export interface ApprovalItem {
  id: string;
  toolCall: Record<string, unknown>;
  reasoning: string;
  status: "pending" | "approved" | "rejected";
  sessionId: string | null;
  toolCallId: string | null;
  /** Permission snapshot at enqueue time. Audit only. */
  permissionAtEnqueue: Permission;
  createdAt: string;
  resolvedAt: string | null;
}

function mapRow(r: Record<string, unknown>): ApprovalItem {
  const raw = (r.permission_at_enqueue as string) ?? "restricted";
  const permission: Permission = raw === "full" ? "full" : "restricted";
  return {
    id: r.id as string,
    toolCall: r.tool_call as Record<string, unknown>,
    reasoning: r.reasoning as string,
    status: r.status as ApprovalItem["status"],
    sessionId: r.session_id as string | null,
    toolCallId: r.tool_call_id as string | null,
    permissionAtEnqueue: permission,
    createdAt: r.created_at as string,
    resolvedAt: r.resolved_at as string | null,
  };
}

const INSERT_APPROVAL_SQL = `INSERT INTO approval_queue (
  id, tool_call, reasoning, status, session_id, tool_call_id,
  permission_at_enqueue, pending_context
) VALUES ($1, $2::jsonb, $3, 'pending', $4, $5, $6, $7::jsonb)`;

function enqueueParams(
  id: string,
  toolCall: Record<string, unknown>,
  reasoning: string,
  sessionId: string,
  toolCallId: string | undefined,
  permission: Permission | undefined,
): unknown[] {
  const pendingContext = nullableJsonb(toolCallId ? { toolCallId } : null);
  return [
    id,
    jsonb(toolCall),
    reasoning,
    sessionId,
    toolCallId ?? null,
    permission ?? "restricted",
    pendingContext,
  ];
}

export async function enqueue(
  id: string,
  toolCall: Record<string, unknown>,
  reasoning: string,
  sessionId: string,
  toolCallId?: string,
  permission?: Permission,
): Promise<void> {
  await execute(INSERT_APPROVAL_SQL, enqueueParams(id, toolCall, reasoning, sessionId, toolCallId, permission));
}

/**
 * Transactional INSERT variant — required for the puzzle-5 phase-2 enqueue
 * site. The caller wraps `enqueueWith` + `approvalIntentsRepo.createWith` +
 * `missionRunsRepo.updateStatus(..., client)` in one `withTransaction(fn)`
 * so a partial state (queue without intent, or queue+intent without
 * `paused_approval`) is unrepresentable.
 */
export async function enqueueWith(
  client: PoolClient,
  id: string,
  toolCall: Record<string, unknown>,
  reasoning: string,
  sessionId: string,
  toolCallId?: string,
  permission?: Permission,
): Promise<void> {
  await client.query(INSERT_APPROVAL_SQL, enqueueParams(id, toolCall, reasoning, sessionId, toolCallId, permission));
}

const APPROVE_CAS_SQL =
  "UPDATE approval_queue SET status = 'approved', resolved_at = NOW() " +
  "WHERE id = $1 AND status = 'pending' RETURNING *";

const REJECT_CAS_SQL =
  "UPDATE approval_queue SET status = 'rejected', resolved_at = NOW() " +
  "WHERE id = $1 AND status = 'pending' RETURNING *";

function mapWithPendingContext(
  row: Record<string, unknown>,
): ApprovalItem & { pendingContext: Record<string, unknown> | null } {
  const ctx = row.pending_context as Record<string, unknown> | null;
  return { ...mapRow(row), pendingContext: ctx };
}

/** Atomically approve — returns null if already resolved. */
export async function approve(
  id: string,
): Promise<
  (ApprovalItem & { pendingContext: Record<string, unknown> | null }) | null
> {
  const row = await queryOne<Record<string, unknown>>(APPROVE_CAS_SQL, [id]);
  return row ? mapWithPendingContext(row) : null;
}

/**
 * Transactional CAS variant — required for the puzzle-5 phase-3 decision
 * tx where `approveWith` + `approvalIntentsRepo.markDecisionWith` must
 * succeed or fail together. Caller is responsible for `BEGIN`/`COMMIT`;
 * pass the `PoolClient` yielded by `withTransaction(fn)`. Returns null
 * with the same semantics as `approve(id)` when CAS misses.
 */
export async function approveWith(
  client: PoolClient,
  id: string,
): Promise<
  (ApprovalItem & { pendingContext: Record<string, unknown> | null }) | null
> {
  const res = await client.query<Record<string, unknown>>(
    APPROVE_CAS_SQL,
    [id],
  );
  const row = res.rows[0];
  return row ? mapWithPendingContext(row) : null;
}

export async function reject(id: string): Promise<ApprovalItem | null> {
  const row = await queryOne<Record<string, unknown>>(REJECT_CAS_SQL, [id]);
  return row ? mapRow(row) : null;
}

/**
 * Transactional CAS variant for the phase-3 reject/expire decision tx.
 * Same caller contract as `approveWith`.
 */
export async function rejectWith(
  client: PoolClient,
  id: string,
): Promise<ApprovalItem | null> {
  const res = await client.query<Record<string, unknown>>(REJECT_CAS_SQL, [id]);
  const row = res.rows[0];
  return row ? mapRow(row) : null;
}

export async function getPending(): Promise<ApprovalItem[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM approval_queue WHERE status = 'pending' ORDER BY created_at",
  );
  return rows.map(mapRow);
}

export async function getByIdForSession(
  id: string,
  sessionId: string,
): Promise<ApprovalItem | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM approval_queue WHERE id = $1 AND session_id = $2",
    [id, sessionId],
  );
  return row ? mapRow(row) : null;
}

export async function getPendingCount(): Promise<number> {
  const r = await queryOne<{ c: string }>("SELECT COUNT(*) AS c FROM approval_queue WHERE status = 'pending'");
  return parseInt(r?.c ?? "0", 10);
}
