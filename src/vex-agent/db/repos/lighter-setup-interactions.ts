import type { PoolClient } from "pg";

import { queryOne } from "../client.js";

export type LighterSetupEnvironment = "core" | "rhc";
export type LighterSetupInteractionStatus = "pending" | "completed" | "cancelled";

export interface LighterSetupInteraction {
  readonly intentId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly environment: LighterSetupEnvironment;
  readonly status: LighterSetupInteractionStatus;
  readonly resultMessageId: number | null;
  readonly resumeConsumedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const COLUMNS = `intent_id, session_id, tool_call_id, environment, status,
  result_message_id, resume_consumed_at, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): LighterSetupInteraction {
  return {
    intentId: String(row.intent_id),
    sessionId: String(row.session_id),
    toolCallId: String(row.tool_call_id),
    environment: row.environment as LighterSetupEnvironment,
    status: row.status as LighterSetupInteractionStatus,
    resultMessageId: row.result_message_id === null ? null : Number(row.result_message_id),
    resumeConsumedAt: row.resume_consumed_at === null
      ? null
      : new Date(row.resume_consumed_at as string | Date).toISOString(),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

export async function createWith(client: PoolClient, input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly environment: LighterSetupEnvironment;
}): Promise<LighterSetupInteraction> {
  const result = await client.query<Record<string, unknown>>(
    `INSERT INTO lighter_setup_interactions (
       intent_id, session_id, tool_call_id, environment
     ) VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [input.intentId, input.sessionId, input.toolCallId, input.environment],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("lighter_setup_interactions: create returned no row");
  return mapRow(row);
}

export async function getById(
  intentId: string,
  sessionId: string,
): Promise<LighterSetupInteraction | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_setup_interactions
      WHERE intent_id = $1 AND session_id = $2`,
    [intentId, sessionId],
  );
  return row === null ? null : mapRow(row);
}

export async function getPendingForSession(
  sessionId: string,
): Promise<LighterSetupInteraction | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM lighter_setup_interactions
      WHERE session_id = $1 AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  return row === null ? null : mapRow(row);
}

export async function settleIfPendingWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  status: Exclude<LighterSetupInteractionStatus, "pending">,
): Promise<LighterSetupInteraction | null> {
  const result = await client.query<Record<string, unknown>>(
    `UPDATE lighter_setup_interactions
        SET status = $3, updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [intentId, sessionId, status],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

export async function stampResultMessageWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  resultMessageId: number,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE lighter_setup_interactions
        SET result_message_id = $3, updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2
        AND status <> 'pending' AND result_message_id IS NULL`,
    [intentId, sessionId, resultMessageId],
  );
  return result.rowCount === 1;
}

export async function markResumeConsumedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE lighter_setup_interactions
        SET resume_consumed_at = NOW(), updated_at = NOW()
      WHERE intent_id = $1 AND session_id = $2
        AND status <> 'pending' AND resume_consumed_at IS NULL`,
    [intentId, sessionId],
  );
  return result.rowCount === 1;
}
