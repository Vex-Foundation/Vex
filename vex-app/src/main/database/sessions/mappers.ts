/**
 * Shared row/DTO/status surface for the sessions DB repository.
 *
 * Single-sourced here so the `SessionRow` shape, the column list, the
 * status normalization, and the `loadMissionStatus` lookup cannot drift
 * across `create` / `read` / `delete` / `pin` consumers.
 */

import type { Client } from "pg";
import {
  missionRunStatusSchema,
  type MissionRunStatus,
  type SessionListItem,
  type SessionMode,
  type SessionPermission,
} from "@shared/schemas/sessions.js";

// Mirror of engine `ACTIVE_OR_PAUSED_RUN_STATUSES` (engine/types.ts).
// Drift between these two breaks sidebar bucketing, delete guards, and
// active-run lookups — puzzle 03 introduced `paused_user` engine-side
// but the app whitelist missed it; puzzle 04 closes that gap.
export const ACTIVE_OR_PAUSED_MISSION_RUN_STATUSES: readonly MissionRunStatus[] = [
  "running",
  "paused_approval",
  "paused_wake",
  "paused_user",
  "paused_error",
  "paused_plan_acceptance",
  "paused_user_form",
];

export interface SessionRow {
  readonly id: string;
  readonly mode: string;
  readonly permission: string;
  readonly initial_goal: string | null;
  readonly started_at: string | Date;
  readonly ended_at: string | Date | null;
  readonly title: string | null;
  readonly pinned_at: string | Date | null;
}

export interface MissionRunStatusRow {
  readonly session_id: string;
  readonly status: string;
}

export const SESSION_ROW_COLUMNS =
  "id, mode, permission, initial_goal, started_at, ended_at, title, pinned_at";

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoStringOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIsoString(value);
}

export function normaliseMode(raw: string): SessionMode {
  return raw === "mission" ? "mission" : "agent";
}

function normalisePermission(raw: string): SessionPermission {
  return raw === "full" ? "full" : "restricted";
}

function normaliseMissionStatus(raw: string | null | undefined): MissionRunStatus | null {
  if (raw === null || raw === undefined) return null;
  const parsed = missionRunStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function toListItem(
  row: SessionRow,
  missionStatus: MissionRunStatus | null,
): SessionListItem {
  return {
    id: row.id,
    mode: normaliseMode(row.mode),
    permission: normalisePermission(row.permission),
    title: row.title,
    initialGoal: row.initial_goal,
    startedAt: toIsoString(row.started_at),
    endedAt: toIsoStringOrNull(row.ended_at),
    missionStatus,
    pinnedAt: toIsoStringOrNull(row.pinned_at),
  };
}

/**
 * Load the active mission_run status for a single session id. Shared by
 * `getSessionById` and `setSessionPinned` so a freshly-pinned mission row
 * never gets returned with a wiped `missionStatus`. `listSessions` keeps
 * its batch DISTINCT ON query — single-row lookups here would be N+1.
 */
export async function loadMissionStatus(
  client: Client,
  sessionId: string,
): Promise<MissionRunStatus | null> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM mission_runs
       WHERE session_id = $1
         AND status = ANY($2::text[])
       ORDER BY started_at DESC LIMIT 1`,
    [sessionId, ACTIVE_OR_PAUSED_MISSION_RUN_STATUSES],
  );
  return normaliseMissionStatus(result.rows[0]?.status);
}

// `normaliseMissionStatus` is also consumed by `listSessions` batch mapping.
export { normaliseMissionStatus };
