/**
 * Session branching (A14): create a NEW session seeded with a copy of the
 * source transcript prefix up to and including an anchor message. The
 * source session is never rewritten; every blocked state returns a named
 * fail-closed outcome and mutates nothing.
 */

import type { Client } from "pg";
import { randomUUID } from "node:crypto";
import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  VEX_APP_SESSION_SCOPE,
  type SessionBranchInput,
  type SessionBranchResult,
} from "@shared/schemas/sessions.js";
import { log } from "../../logger/index.js";
import { dbError, withClient } from "./connection.js";
import { SESSION_ROW_COLUMNS, type SessionRow, toListItem } from "./mappers.js";

export interface BranchSessionParams {
  readonly sourceId: string;
  /** Anchor `messages.id` — last copied message, inclusive. */
  readonly messageId: number;
  readonly name: string | null;
  readonly newSessionId: string;
}

async function rollbackTo(
  client: Client,
  outcome: Exclude<SessionBranchResult["outcome"], "created">,
): Promise<Result<SessionBranchResult, VexError>> {
  await client.query("ROLLBACK");
  return ok({ outcome });
}

/**
 * The whole branch runs inside one REPEATABLE READ transaction so the
 * validation, the copy, and the bookkeeping all see the same snapshot — a
 * concurrent compaction cannot shear the prefix between the anchor probe
 * and the INSERT..SELECT.
 *
 * Copied alongside the messages: `summary`, `compacted`, `token_count`
 * (an upper bound for a prefix — errs toward earlier compaction, never
 * context overflow), `checkpoint_generation`, and the immutable wallet
 * selection columns. Mission sessions are refused: the frozen mission
 * contract, `approval_queue`, and wallet policy are session-scoped state
 * a transcript copy would desynchronize.
 */
export async function branchSessionWithClient(
  client: Client,
  params: BranchSessionParams,
): Promise<Result<SessionBranchResult, VexError>> {
  const { sourceId, messageId, name, newSessionId } = params;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");

    const source = await client.query<{ mode: string; title: string | null }>(
      `SELECT mode, title FROM sessions
        WHERE id = $1 AND scope = $2 AND deleted_at IS NULL`,
      [sourceId, VEX_APP_SESSION_SCOPE],
    );
    const sourceRow = source.rows[0];
    if (!sourceRow) return rollbackTo(client, "not_found");
    if (sourceRow.mode !== "agent") {
      return rollbackTo(client, "unsupported_mode");
    }

    const anchor = await client.query<{ created_at: Date }>(
      "SELECT created_at FROM messages WHERE session_id = $1 AND id = $2",
      [sourceId, messageId],
    );
    const anchorRow = anchor.rows[0];
    if (!anchorRow) {
      const archived = await client.query(
        "SELECT 1 FROM messages_archive WHERE session_id = $1 AND id = $2 LIMIT 1",
        [sourceId, messageId],
      );
      return rollbackTo(
        client,
        archived.rows.length > 0 ? "anchor_compacted" : "anchor_not_found",
      );
    }

    // Tool-closed prefix invariant: every tool_call inside the prefix must
    // have its tool_result inside the prefix too (a pending approval tail
    // therefore refuses by name). Prefix order is the tape's canonical
    // (created_at, id) ordering.
    const openBatch = await client.query(
      `SELECT 1
         FROM messages m
        CROSS JOIN LATERAL jsonb_array_elements(m.tool_calls) tc
        WHERE m.session_id = $1
          AND m.tool_calls IS NOT NULL
          AND (m.created_at, m.id) <= ($2::timestamptz, $3::int)
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.session_id = $1
               AND r.tool_call_id = tc->>'id'
               AND (r.created_at, r.id) <= ($2::timestamptz, $3::int)
          )
        LIMIT 1`,
      [sourceId, anchorRow.created_at, messageId],
    );
    if (openBatch.rows.length > 0) return rollbackTo(client, "open_tool_batch");

    const title = name ?? sourceRow.title ?? "Branch";
    await client.query(
      `INSERT INTO sessions
         (id, scope, mode, permission, initial_goal, title,
          summary, compacted, token_count, checkpoint_generation,
          selected_evm_wallet_id, selected_evm_wallet_address,
          selected_solana_wallet_id, selected_solana_wallet_address)
       SELECT $1, scope, mode, permission, initial_goal, $3,
              summary, compacted, token_count, checkpoint_generation,
              selected_evm_wallet_id, selected_evm_wallet_address,
              selected_solana_wallet_id, selected_solana_wallet_address
         FROM sessions WHERE id = $2`,
      [newSessionId, sourceId, title],
    );

    // New SERIAL ids on the copy; original created_at is preserved so the
    // branch reads with the source's real timeline. `origin_session_id`
    // stamps provenance (dormant column revived by this feature).
    await client.query(
      `INSERT INTO messages
         (session_id, role, content, tool_call_id, tool_calls, created_at,
          source, message_type, visibility, origin_session_id, subagent_id,
          metadata)
       SELECT $1, role, content, tool_call_id, tool_calls, created_at,
              source, message_type, visibility, $2, subagent_id, metadata
         FROM messages
        WHERE session_id = $2
          AND (created_at, id) <= ($3::timestamptz, $4::int)
        ORDER BY created_at ASC, id ASC`,
      [newSessionId, sourceId, anchorRow.created_at, messageId],
    );

    await client.query(
      `UPDATE sessions
          SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = $1)
        WHERE id = $1`,
      [newSessionId],
    );

    await client.query(
      `INSERT INTO session_links (parent_session_id, child_session_id, relation_type)
       VALUES ($1, $2, $3)`,
      [sourceId, newSessionId, "branch"],
    );

    const created = await client.query<SessionRow>(
      `SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE id = $1 AND scope = $2`,
      [newSessionId, VEX_APP_SESSION_SCOPE],
    );
    const createdRow = created.rows[0];
    if (!createdRow) {
      await client.query("ROLLBACK");
      return dbError(`branchSession lost row id=${newSessionId} after INSERT`);
    }
    await client.query("COMMIT");
    // Agent-mode only, so missionStatus is null by construction.
    return ok({ outcome: "created", session: toListItem(createdRow, null) });
  } catch (cause) {
    try {
      await client.query("ROLLBACK");
    } catch (rbCause) {
      log.warn("[sessions-db] ROLLBACK after branchSession failure failed", rbCause);
    }
    return dbError("branchSession failed", cause);
  }
}

export async function branchSession(
  input: SessionBranchInput,
): Promise<Result<SessionBranchResult, VexError>> {
  const newSessionId = randomUUID();
  return withClient((client) =>
    branchSessionWithClient(client, {
      sourceId: input.sourceId,
      messageId: input.messageId,
      name: input.name ?? null,
      newSessionId,
    }),
  );
}
