/**
 * Compaction DB helper — read-only Track-2 status for the runtime bar
 * (agent integration stage 7-1).
 *
 * Mirrors `usage-db.ts`: own `pg.Client` per call, no `@vex-agent/db/repos/*`
 * import. Reads are app-scoped — a `compact_jobs` row only surfaces when its
 * `session_id` belongs to an app-scope (`scope = 'vex_app'`), non-deleted
 * session, so a foreign-scope or unknown id resolves to `null` (mirrors
 * `usage-db.getContextWindow`) instead of leaking another scope's status.
 *
 * `probeCompactJobsReady()` is a schema-readiness gate for the worker
 * supervisor: it proves Postgres is reachable AND the `compact_jobs` table
 * exists (migrations applied) — not merely that `VEX_DB_URL` resolves.
 */

import type { Client } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { VEX_APP_SESSION_SCOPE } from "@shared/schemas/sessions.js";
import {
  type CompactionHistoryResult,
  type CompactionStatusResult,
  type CompactJobStatusDto,
} from "@shared/schemas/compaction.js";
import { buildPoolConfig } from "./db-config.js";
import { runWithMainDbClient } from "./main-ipc-pg-pool.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "compaction",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[compaction-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "compaction",
    message: "Unable to load compaction status.",
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
    log.warn("[compaction-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  // Fresh client per call, or a pooled one when MAIN_IPC_PG_POOL is on
  // (`main-ipc-pg-pool.ts`): same config, timeouts and failure results.
  return runWithMainDbClient(
    cfg,
    {
      logPrefix: "[compaction-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: () => dbUnavailable(),
    },
    fn,
  );
}

interface StatusRow {
  readonly latest_status: string | null;
  readonly checkpoint_generation: number | string | null;
  readonly updated_at: string | Date | null;
  readonly active_count: number | string;
}

function toInt(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Latest compact job status + active-job count for a session, app-scoped.
 *
 * One round-trip: the outer `sessions` row gates app scope (so the result
 * is `null` for an unknown/foreign-scope/soft-deleted id); the LATERAL join
 * yields the most recent job (or all-null columns when none exist); the
 * correlated subquery counts jobs still expected to produce work.
 */
export async function getCompactionStatus(
  sessionId: string,
): Promise<Result<CompactionStatusResult, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<StatusRow>(
        `SELECT
            cj.status                 AS latest_status,
            cj.checkpoint_generation  AS checkpoint_generation,
            COALESCE(
              cj.completed_at, cj.inference_completed_at,
              cj.heartbeat_at, cj.started_at, cj.created_at
            )                         AS updated_at,
            (
              SELECT COUNT(*)
                FROM compact_jobs c2
               WHERE c2.session_id = s.id
                 AND c2.status IN ('pending', 'running', 'failed')
            )                         AS active_count
           FROM sessions s
           LEFT JOIN LATERAL (
             SELECT status, checkpoint_generation, completed_at,
                    inference_completed_at, heartbeat_at, started_at, created_at
               FROM compact_jobs c
              WHERE c.session_id = s.id
              ORDER BY c.id DESC
              LIMIT 1
           ) cj ON true
          WHERE s.id = $1
            AND s.scope = $2
            AND s.deleted_at IS NULL`,
        [sessionId, VEX_APP_SESSION_SCOPE],
      );
      const row = result.rows[0];
      if (!row) return ok(null); // unknown / foreign-scope / soft-deleted

      // `created_at` is NOT NULL in the schema, so a present job row always
      // yields a non-null `updated_at` via COALESCE. Guarding both keeps the
      // mapper honest without a non-null assertion.
      const latest =
        row.latest_status !== null && row.updated_at !== null
          ? {
              status: row.latest_status as CompactJobStatusDto,
              checkpointGeneration: toInt(row.checkpoint_generation),
              updatedAt: toIso(row.updated_at),
            }
          : null;

      return ok({
        sessionId,
        latest,
        activeCount: toInt(row.active_count),
      });
    } catch (cause) {
      return dbError("getCompactionStatus query failed", cause);
    }
  });
}

/**
 * Schema-readiness probe for the worker supervisor. `true` only when
 * Postgres is reachable AND `public.compact_jobs` exists (migrations ran).
 * Any failure (config absent, connect error, table missing) → `false`, so
 * the supervisor keeps the executor idle rather than spamming claim errors.
 */
export async function probeCompactJobsReady(): Promise<boolean> {
  const outcome = await withClient(async (client) => {
    try {
      const r = await client.query<{ reg: string | null }>(
        `SELECT to_regclass('public.compact_jobs') AS reg`,
      );
      return ok(r.rows[0]?.reg != null);
    } catch (cause) {
      return dbError("probeCompactJobsReady query failed", cause);
    }
  });
  return outcome.ok ? outcome.data : false;
}

function toIsoNullable(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

function toIntNullable(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

interface HistoryRow {
  readonly checkpoint_generation: number | string;
  readonly status: string;
  readonly source_start_message_id: number | string | null;
  readonly source_end_message_id: number | string | null;
  readonly chunks_inserted: number | string;
  readonly created_at: string | Date;
  readonly started_at: string | Date | null;
  readonly completed_at: string | Date | null;
}

/**
 * Replayable compaction-generation timeline for a session (newest first),
 * app-scoped. `null` for an unknown/foreign/deleted session; `[]` when the
 * session has no compaction jobs. Bounded by `limit` (capped in the schema).
 */
export async function listCompactionHistory(
  sessionId: string,
  limit: number,
): Promise<Result<CompactionHistoryResult, VexError>> {
  return withClient(async (client) => {
    try {
      const sess = await client.query(
        `SELECT 1 FROM sessions WHERE id = $1 AND scope = $2 AND deleted_at IS NULL`,
        [sessionId, VEX_APP_SESSION_SCOPE],
      );
      if (sess.rows.length === 0) return ok(null);

      const result = await client.query<HistoryRow>(
        `SELECT checkpoint_generation, status,
                source_start_message_id, source_end_message_id,
                chunks_inserted, created_at, started_at, completed_at
           FROM compact_jobs
          WHERE session_id = $1
          ORDER BY checkpoint_generation DESC, id DESC
          LIMIT $2`,
        [sessionId, limit],
      );
      return ok(
        result.rows.map((r) => ({
          checkpointGeneration: toInt(r.checkpoint_generation),
          status: r.status as CompactJobStatusDto,
          sourceStartMessageId: toIntNullable(r.source_start_message_id),
          sourceEndMessageId: toIntNullable(r.source_end_message_id),
          chunksInserted: toInt(r.chunks_inserted),
          createdAt: toIso(r.created_at),
          startedAt: toIsoNullable(r.started_at),
          completedAt: toIsoNullable(r.completed_at),
        })),
      );
    } catch (cause) {
      return dbError("listCompactionHistory query failed", cause);
    }
  });
}

interface RetryableJobRow {
  readonly id: number | string;
  readonly status: string;
}

/**
 * App-scope authorization for the retry mutation (stage 8-5): resolve a
 * compact job's internal id + current status from its (sessionId, generation)
 * key, ONLY when the session is app-scope + non-deleted. `null` when the
 * session is unknown/foreign/deleted or no such generation exists. The id
 * stays main-internal — the IPC handler hands it to the engine repo to perform
 * the transition; it never crosses to the renderer.
 */
export async function getRetryableCompactJob(
  sessionId: string,
  checkpointGeneration: number,
): Promise<Result<{ id: number; status: CompactJobStatusDto } | null, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<RetryableJobRow>(
        `SELECT cj.id, cj.status
           FROM sessions s
           JOIN compact_jobs cj ON cj.session_id = s.id
          WHERE s.id = $1
            AND s.scope = $2
            AND s.deleted_at IS NULL
            AND cj.checkpoint_generation = $3`,
        [sessionId, VEX_APP_SESSION_SCOPE, checkpointGeneration],
      );
      const row = result.rows[0];
      if (!row) return ok(null);
      return ok({
        id: toInt(row.id),
        status: row.status as CompactJobStatusDto,
      });
    } catch (cause) {
      return dbError("getRetryableCompactJob query failed", cause);
    }
  });
}
