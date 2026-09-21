/**
 * Session reads — single fetch and bounded list, both enriched with active
 * mission_run status for mission-mode rows.
 */

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  VEX_APP_SESSION_SCOPE,
  type MissionRunStatus,
  type SessionListItem,
} from "@shared/schemas/sessions.js";
import { withClient, dbError } from "./connection.js";
import {
  ACTIVE_OR_PAUSED_MISSION_RUN_STATUSES,
  loadMissionStatus,
  type MissionRunStatusRow,
  normaliseMissionStatus,
  normaliseMode,
  SESSION_ROW_COLUMNS,
  type SessionRow,
  toListItem,
} from "./mappers.js";

/**
 * Fetch a single session by id, enriched with active mission_run status
 * (mission mode only).
 */
export async function getSessionById(
  id: string,
): Promise<Result<SessionListItem | null, VexError>> {
  return withClient(async (client) => {
    try {
      const sessionResult = await client.query<SessionRow>(
        `SELECT ${SESSION_ROW_COLUMNS} FROM sessions WHERE id = $1 AND scope = $2 AND deleted_at IS NULL`,
        [id, VEX_APP_SESSION_SCOPE],
      );
      const row = sessionResult.rows[0];
      if (!row) return ok(null);
      const missionStatus: MissionRunStatus | null =
        normaliseMode(row.mode) === "mission"
          ? await loadMissionStatus(client, id)
          : null;
      return ok(toListItem(row, missionStatus));
    } catch (cause) {
      return dbError("getSessionById failed", cause);
    }
  });
}

/**
 * List sessions (most-recent first), enriched with active mission_run
 * status for mission-mode rows. Bounded at 100 per workspace so the newer
 * Lighter rail cannot starve the agent rail (or the reverse) before the
 * renderer applies its workspace filter.
 */
export async function listSessions(
  limit = 100,
): Promise<Result<readonly SessionListItem[], VexError>> {
  return withClient(async (client) => {
    try {
      const sessionsResult = await client.query<SessionRow>(
        `WITH ranked AS (
           SELECT ${SESSION_ROW_COLUMNS},
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(workspace, 'agent')
               ORDER BY pinned_at DESC NULLS LAST, started_at DESC
             ) AS workspace_row
           FROM sessions
           WHERE scope = $1 AND deleted_at IS NULL
         )
         SELECT ${SESSION_ROW_COLUMNS}
         FROM ranked
         WHERE workspace_row <= $2
         ORDER BY pinned_at DESC NULLS LAST, started_at DESC`,
        [VEX_APP_SESSION_SCOPE, limit],
      );
      const rows = sessionsResult.rows;
      if (rows.length === 0) return ok([]);

      const missionSessionIds = rows
        .filter((r) => normaliseMode(r.mode) === "mission")
        .map((r) => r.id);

      const statusBySession = new Map<string, MissionRunStatus>();
      if (missionSessionIds.length > 0) {
        // Single query, latest active run per session. DISTINCT ON keeps
        // the most recent active/paused row per session_id.
        const runsResult = await client.query<MissionRunStatusRow>(
          `SELECT DISTINCT ON (session_id) session_id, status
           FROM mission_runs
           WHERE session_id = ANY($1::text[])
             AND status = ANY($2::text[])
           ORDER BY session_id, started_at DESC`,
          [missionSessionIds, ACTIVE_OR_PAUSED_MISSION_RUN_STATUSES],
        );
        for (const r of runsResult.rows) {
          const status = normaliseMissionStatus(r.status);
          if (status !== null) statusBySession.set(r.session_id, status);
        }
      }

      return ok(
        rows.map((r) =>
          toListItem(r, statusBySession.get(r.id) ?? null),
        ),
      );
    } catch (cause) {
      return dbError("listSessions failed", cause);
    }
  });
}
