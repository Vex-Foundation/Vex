/**
 * Session-memory DB helper — read-only per-session memory list + stats
 * (agent integration stage 7-2a).
 *
 * Mirrors `usage-db.ts`: own `pg.Client` per call, no `@vex-agent/db/repos/*`
 * import. Reads are app-scoped — both functions first verify the session is
 * an app-scope (`scope = 'vex_app'`), non-deleted session and return `null`
 * for an unknown/foreign/deleted id (no fabricated stats), mirroring
 * `usage.getContextWindow`.
 *
 * SANITIZATION (codex 7-2a guardrail): the SELECT omits every narrative
 * column (`body_md`, `happened_md`, `did_md`, `tried_md`), the raw
 * `outstanding_items` array, all embedding columns, and hashes. Outstanding
 * work is exposed as open/resolved COUNTS computed in SQL.
 */

import type { Client } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { VEX_APP_SESSION_SCOPE } from "@shared/schemas/sessions.js";
import {
  type MemoryStatsResult,
  type SessionMemoryDto,
  type SessionMemoryListResult,
  type SessionMemoryStatusDto,
} from "@shared/schemas/memory.js";
import { buildPoolConfig } from "./db-config.js";
import { runWithMainDbClient } from "./main-ipc-pg-pool.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;
/** Distinct recent themes surfaced in the stats banner. Not caller-controlled. */
const RECENT_THEMES_LIMIT = 6;

function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "memory",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[memory-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "memory",
    message: "Unable to load session memory.",
    retryable: true,
    userActionable: false,
    redacted: true,
  });
}

async function withClient<T>(
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[memory-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  // Fresh client per call, or a pooled one when MAIN_IPC_PG_POOL is on
  // (`main-ipc-pg-pool.ts`): same config, timeouts and failure results.
  return runWithMainDbClient(
    cfg,
    {
      logPrefix: "[memory-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: () => dbUnavailable(),
    },
    fn,
  );
}

async function sessionInAppScope(
  client: Client,
  sessionId: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM sessions WHERE id = $1 AND scope = $2 AND deleted_at IS NULL`,
    [sessionId, VEX_APP_SESSION_SCOPE],
  );
  return r.rows.length > 0;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toInt(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function toIntOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNum(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

interface MemoryRow {
  readonly id: number;
  readonly theme: string;
  readonly theme_source: string | null;
  readonly entities: string[] | null;
  readonly protocols: string[] | null;
  readonly error_classes: string[] | null;
  readonly chains: string[] | null;
  readonly tasks: string[] | null;
  readonly importance: number | string | null;
  readonly confidence: number | string | null;
  readonly status: string;
  readonly checkpoint_generation: number | string;
  readonly source_start_message_id: number | string | null;
  readonly source_end_message_id: number | string | null;
  readonly outstanding_open: number | string;
  readonly outstanding_resolved: number | string;
  readonly created_at: string | Date;
}

function mapRow(r: MemoryRow): SessionMemoryDto {
  return {
    id: r.id,
    theme: r.theme,
    themeSource: r.theme_source,
    entities: r.entities ?? [],
    protocols: r.protocols ?? [],
    errorClasses: r.error_classes ?? [],
    chains: r.chains ?? [],
    tasks: r.tasks ?? [],
    importance: toIntOrNull(r.importance),
    confidence: toNum(r.confidence),
    status: r.status as SessionMemoryStatusDto,
    checkpointGeneration: toInt(r.checkpoint_generation),
    sourceStartMessageId: toIntOrNull(r.source_start_message_id),
    sourceEndMessageId: toIntOrNull(r.source_end_message_id),
    outstandingOpenCount: toInt(r.outstanding_open),
    outstandingResolvedCount: toInt(r.outstanding_resolved),
    createdAt: toIso(r.created_at),
  };
}

/**
 * Active memories for a session (newest first), sanitized. `null` for an
 * unknown/foreign/deleted session; `[]` when the session has none.
 */
export async function listSessionMemories(
  sessionId: string,
  limit: number,
): Promise<Result<SessionMemoryListResult, VexError>> {
  return withClient(async (client) => {
    try {
      if (!(await sessionInAppScope(client, sessionId))) return ok(null);
      const result = await client.query<MemoryRow>(
        `SELECT
            sm.id, sm.theme, sm.theme_source,
            sm.entities, sm.protocols, sm.error_classes, sm.chains, sm.tasks,
            sm.importance, sm.confidence, sm.status, sm.checkpoint_generation,
            sm.source_start_message_id, sm.source_end_message_id, sm.created_at,
            (SELECT COUNT(*) FROM jsonb_array_elements(
               COALESCE(sm.outstanding_items, '[]'::jsonb)) it
             WHERE it->>'resolved_at' IS NULL)      AS outstanding_open,
            (SELECT COUNT(*) FROM jsonb_array_elements(
               COALESCE(sm.outstanding_items, '[]'::jsonb)) it
             WHERE it->>'resolved_at' IS NOT NULL)  AS outstanding_resolved
           FROM session_memories sm
          WHERE sm.session_id = $1 AND sm.status = 'active'
          ORDER BY sm.created_at DESC, sm.id DESC
          LIMIT $2`,
        [sessionId, limit],
      );
      return ok(result.rows.map(mapRow));
    } catch (cause) {
      return dbError("listSessionMemories query failed", cause);
    }
  });
}

interface StatsRow {
  readonly active_count: string | number;
  readonly unresolved_outstanding: string | number;
  readonly recent_themes: string[] | null;
}

/**
 * Aggregate memory stats for a session. `null` for an unknown/foreign/
 * deleted session. `compactCount` reads `sessions.checkpoint_generation`
 * (a compaction can complete with zero inserted chunks, so deriving it from
 * memories would under-report) — mirrors the engine's `getSessionMemoryStats`.
 */
export async function getMemoryStats(
  sessionId: string,
): Promise<Result<MemoryStatsResult, VexError>> {
  return withClient(async (client) => {
    try {
      const sess = await client.query<{ checkpoint_generation: number | string | null }>(
        `SELECT checkpoint_generation
           FROM sessions
          WHERE id = $1 AND scope = $2 AND deleted_at IS NULL`,
        [sessionId, VEX_APP_SESSION_SCOPE],
      );
      const sessionRow = sess.rows[0];
      if (!sessionRow) return ok(null);

      const stats = await client.query<StatsRow>(
        `WITH active AS (
           SELECT theme, created_at, outstanding_items
             FROM session_memories
            WHERE session_id = $1 AND status = 'active'
         ),
         theme_recent AS (
           SELECT theme FROM (
             SELECT theme, MAX(created_at) AS last_at
               FROM active GROUP BY theme
           ) t ORDER BY last_at DESC LIMIT $2
         )
         SELECT
           (SELECT COUNT(*) FROM active)                                  AS active_count,
           (SELECT COALESCE(SUM(
              (SELECT COUNT(*) FROM jsonb_array_elements(
                 COALESCE(outstanding_items, '[]'::jsonb)) item
               WHERE item->>'resolved_at' IS NULL)
           ), 0) FROM active)                                             AS unresolved_outstanding,
           (SELECT array_agg(theme) FROM theme_recent)                    AS recent_themes`,
        [sessionId, RECENT_THEMES_LIMIT],
      );
      const row = stats.rows[0];
      return ok({
        activeCount: toInt(row?.active_count),
        compactCount: toInt(sessionRow.checkpoint_generation),
        unresolvedOutstandingCount: toInt(row?.unresolved_outstanding),
        recentThemes: row?.recent_themes ?? [],
      });
    } catch (cause) {
      return dbError("getMemoryStats query failed", cause);
    }
  });
}
