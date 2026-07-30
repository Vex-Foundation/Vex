/**
 * Protocol executions repo — audit log of every mutating tool call.
 */

import type { PoolClient } from "pg";

import { query, queryOne, queryOneWith } from "../client.js";
import { jsonb, jsonbByteLength, nullableJsonb } from "../params.js";
import { redactBugPayload } from "../../../lib/diagnostics/redactor.js";

/**
 * Repo-boundary sanitization for the intent-first `params` echo (FIX-SPINE
 * round 1, finding 9/C5) — the shared secret-shape detectors (key-name +
 * two-tier text redaction) plus a hard total-size cap. Applied here, not by
 * callers, so `protocol_executions.params` can never carry an unredacted
 * secret or an unbounded payload regardless of which intent-first caller
 * (Hyperliquid, Agent Scan swap executes) supplied it.
 */
const MAX_INTENT_PARAMS_BYTES = 8 * 1024;
function sanitizeIntentParams(params: Record<string, unknown>): Record<string, unknown> {
  const { value } = redactBugPayload(params);
  const sizeBytes = jsonbByteLength(value);
  if (sizeBytes <= MAX_INTENT_PARAMS_BYTES) {
    return value;
  }
  return {
    _dropped: true,
    _reason: "intentParams exceeded the 8KiB cap after redaction",
    _originalSizeBytes: sizeBytes,
  };
}

export interface ExecutionRecord {
  id: number;
  toolId: string;
  namespace: string;
  sessionId: string | null;
  success: boolean;
  executionStatus: "intent" | "succeeded" | "failed";
  tradeCapture: Record<string, unknown> | null;
  externalRefs: Record<string, unknown>;
  durationMs: number | null;
  createdAt: string;
}

/**
 * Persisted before a signing path may submit any side effect (Hyperliquid;
 * Agent Scan's Kyber/Uniswap swap executes — see `db/repos/agent-activity.ts`).
 * Accepts an optional shared `client` so a caller can persist this intent row
 * and the FIRST `agent_activity` event row in the SAME transaction (plan
 * §11.1 step 1 — atomic with intent creation).
 */
export async function createExecutionIntent(
  toolId: string,
  namespace: string,
  sessionId: string | null,
  params: Record<string, unknown>,
  client?: PoolClient,
): Promise<number> {
  const sql = `INSERT INTO protocol_executions (tool_id, namespace, session_id, params, result, success, trade_capture, external_refs, execution_status)
     VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, false, NULL, '{}'::jsonb, 'intent') RETURNING id`;
  const bindParams = [toolId, namespace, sessionId, jsonb(sanitizeIntentParams(params))];
  const row = client
    ? await queryOneWith<{ id: number }>(client, sql, bindParams)
    : await queryOne<{ id: number }>(sql, bindParams);
  return row?.id ?? 0;
}

const COMPLETE_EXECUTION_INTENT_SQL = `UPDATE protocol_executions
   SET result = $2::jsonb, success = $3, trade_capture = $4::jsonb,
       external_refs = $5::jsonb, duration_ms = $6,
       execution_status = CASE WHEN $3 THEN 'succeeded' ELSE 'failed' END
 WHERE id = $1 AND execution_status = 'intent'`;

export interface CompleteExecutionIntentInput {
  readonly executionId: number;
  readonly result: Record<string, unknown>;
  readonly success: boolean;
  readonly tradeCapture: Record<string, unknown> | null;
  readonly externalRefs: Record<string, unknown>;
  readonly durationMs: number;
}

function toCompleteParams(input: CompleteExecutionIntentInput): unknown[] {
  return [
    input.executionId,
    jsonb(input.result),
    input.success,
    nullableJsonb(input.tradeCapture),
    jsonb(input.externalRefs),
    input.durationMs,
  ];
}

/**
 * Finalize a durable pre-sign record with the known exchange outcome, on the
 * CALLER's transaction. Client-bound with no pool-level twin, so the completion
 * can only run under the session control lock: an `execution_status = 'intent'` row is
 * unresolved money state for the compaction safe-moment gate
 * (`approval-intents/money-state.ts`), and this write is what moves it out of
 * that set. A reader under the lock is a boundary only if the writer takes it
 * too.
 *
 * The CAS predicate (`execution_status = 'intent'`) is unchanged — only the
 * transaction it runs in.
 */
export async function completeExecutionIntentWith(
  client: PoolClient,
  input: CompleteExecutionIntentInput,
): Promise<void> {
  await client.query(COMPLETE_EXECUTION_INTENT_SQL, toCompleteParams(input));
}

export async function recordExecution(
  toolId: string,
  namespace: string,
  sessionId: string | null,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
  success: boolean,
  tradeCapture: Record<string, unknown> | null,
  externalRefs: Record<string, unknown>,
  durationMs: number,
): Promise<number> {
  // execution_status defaults to 'succeeded' (migration 039) — the normal,
  // post-hoc (non-intent) capture path used by every non-Hyperliquid mutation
  // must set it explicitly, or a failed execution (success=false) is
  // mislabeled 'succeeded'. Mirrors completeExecutionIntent's CASE.
  const row = await queryOne<{ id: number }>(
    `INSERT INTO protocol_executions (tool_id, namespace, session_id, params, result, success, trade_capture, external_refs, duration_ms, execution_status)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, CASE WHEN $6 THEN 'succeeded' ELSE 'failed' END) RETURNING id`,
    [toolId, namespace, sessionId, jsonb(params), jsonb(result),
     success, nullableJsonb(tradeCapture), jsonb(externalRefs), durationMs],
  );
  return row?.id ?? 0;
}

export async function getByExternalRef(key: string, value: string): Promise<ExecutionRecord[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM protocol_executions WHERE external_refs->>$1 = $2 ORDER BY created_at DESC",
    [key, value],
  );
  return rows.map(mapRow);
}

export async function getByNamespace(namespace: string, limit = 50): Promise<ExecutionRecord[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM protocol_executions WHERE namespace = $1 ORDER BY created_at DESC LIMIT $2",
    [namespace, limit],
  );
  return rows.map(mapRow);
}

export async function getById(id: number): Promise<ExecutionRecord | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM protocol_executions WHERE id = $1",
    [id],
  );
  return row ? mapRow(row) : null;
}

export async function getBySession(sessionId: string): Promise<ExecutionRecord[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM protocol_executions WHERE session_id = $1 ORDER BY created_at DESC",
    [sessionId],
  );
  return rows.map(mapRow);
}

function mapRow(r: Record<string, unknown>): ExecutionRecord {
  return {
    id: r.id as number,
    toolId: r.tool_id as string,
    namespace: r.namespace as string,
    sessionId: r.session_id as string | null,
    success: r.success as boolean,
    executionStatus: (r.execution_status as "intent" | "succeeded" | "failed") ?? "succeeded",
    tradeCapture: r.trade_capture as Record<string, unknown> | null,
    externalRefs: (r.external_refs as Record<string, unknown>) ?? {},
    durationMs: r.duration_ms as number | null,
    createdAt: r.created_at as string,
  };
}
