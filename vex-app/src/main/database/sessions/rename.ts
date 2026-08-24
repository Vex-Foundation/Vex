/**
 * Rename a session (user-entered display title).
 */

import type { Client } from "pg";
import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  VEX_APP_SESSION_SCOPE,
  type MissionRunStatus,
  type SessionListItem,
} from "@shared/schemas/sessions.js";
import { dbError, withClient } from "./connection.js";
import {
  loadMissionStatus,
  normaliseMode,
  SESSION_ROW_COLUMNS,
  type SessionRow,
  toListItem,
} from "./mappers.js";

/**
 * Set a session's display title. The name is already trimmed and bounded by
 * `sessionTitleSchema` at the IPC boundary. Returns the updated
 * `SessionListItem` (enriched with `missionStatus`) or `null` when the id is
 * unknown or soft-deleted — a stale renderer cache is not a fault worth
 * surfacing.
 */
export async function renameSessionWithClient(
  client: Client,
  id: string,
  name: string,
): Promise<Result<SessionListItem | null, VexError>> {
  try {
    // `AND deleted_at IS NULL` keeps soft-deleted sessions unreachable — a
    // hostile or stale rename cannot resurrect a hidden row (the pin-path
    // invariant, applied identically here).
    const updateResult = await client.query<SessionRow>(
      `UPDATE sessions
          SET title = $2
        WHERE id = $1 AND scope = $3 AND deleted_at IS NULL
        RETURNING ${SESSION_ROW_COLUMNS}`,
      [id, name, VEX_APP_SESSION_SCOPE],
    );
    const row = updateResult.rows[0];
    if (!row) return ok(null);
    const missionStatus: MissionRunStatus | null =
      normaliseMode(row.mode) === "mission"
        ? await loadMissionStatus(client, id)
        : null;
    return ok(toListItem(row, missionStatus));
  } catch (cause) {
    return dbError("renameSession failed", cause);
  }
}

export async function renameSession(
  id: string,
  name: string,
): Promise<Result<SessionListItem | null, VexError>> {
  return withClient((client) => renameSessionWithClient(client, id, name));
}
