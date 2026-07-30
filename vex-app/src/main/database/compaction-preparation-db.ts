/**
 * Compaction-PREPARATION DB helper — read-only, app-scoped (compaction v2).
 *
 * Sibling of `compaction-db.ts`, same responsibility split and same
 * scaffolding: own `pg.Client` per call, no `@vex-agent/db/repos/*` import,
 * connect/statement timeouts, redacted errors. Reads are app-scoped — a
 * preparation row only surfaces when its `session_id` belongs to an app-scope
 * (`scope = 'vex_app'`), non-deleted session, so a foreign-scope or unknown id
 * resolves to `null` rather than leaking another scope's state.
 *
 * ## The projection is a COLUMN ALLOWLIST, not a convenience
 *
 * `compaction_preparations` stores `corpus` (a verbatim frozen copy of the
 * conversation), `summary_output` (a model-authored condensation of it) and
 * `last_error` (free text that can carry provider prose). None of them are
 * selected here, and readiness is reported as `summary_output IS NOT NULL`.
 * Widening this SELECT means editing this file on purpose.
 *
 * The apply compare-and-swap deliberately does NOT live here: it is an engine
 * state transition owned by `engine/compaction/apply`, and the IPC handler
 * consumes that surface rather than writing SQL of its own.
 *
 * `probeCompactionPreparationsReady()` is the schema-readiness gate for the
 * preparation worker supervisor: it proves Postgres is reachable AND that
 * migration 058 has been applied, so a build running against an older database
 * degrades instead of throwing.
 */

import { randomUUID } from "node:crypto";
import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { VEX_APP_SESSION_SCOPE } from "@shared/schemas/sessions.js";
import {
  compactionPreparationResultSchema,
  type CompactionPreparationResult,
} from "@shared/schemas/compaction-preparation.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

function dbUnavailable(correlationId: string): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "compaction",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

function dbError(
  correlationId: string,
  reason: string,
  cause?: unknown,
): Result<never, VexError> {
  log.warn(
    `[compaction-preparation-db] ${reason} correlationId=${correlationId}`,
    cause,
  );
  return err({
    code: "internal.unexpected",
    domain: "compaction",
    message: "Unable to load compaction status.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  });
}

async function withClient<T>(
  correlationId: string,
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[compaction-preparation-db] buildPoolConfig threw", cause);
    return dbUnavailable(correlationId);
  }
  if (cfg === null) return dbUnavailable(correlationId);

  const clientConfig: ClientConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn("[compaction-preparation-db] client.connect failed", cause);
    return dbUnavailable(correlationId);
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn(
        "[compaction-preparation-db] client.end failed (non-fatal)",
        cause,
      );
    }
  }
}

interface PreparationRow {
  readonly status: string;
  readonly summary_status: string;
  readonly chunks_status: string;
  readonly summary_attempt_count: number | string;
  readonly summary_max_attempts: number | string;
  readonly chunks_attempt_count: number | string;
  readonly chunks_max_attempts: number | string;
  readonly has_summary: boolean;
  readonly apply_source: string | null;
  readonly apply_requested_at: string | Date | null;
  readonly applied_at: string | Date | null;
  readonly created_at: string | Date;
  readonly completed_at: string | Date | null;
}

function toInt(value: number | string): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoNullable(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * The session's most recent preparation, projected to progress facts only.
 *
 * `null` for an unknown / foreign-scope / soft-deleted session AND for an
 * app-scope session that simply has no preparation — both are normal states,
 * and the renderer treats them identically (no button).
 *
 * The mapped row is parsed through the shared DTO schema before it leaves this
 * module: an unknown status literal (a build newer than this one wrote it) is
 * a redacted error here rather than an unvalidated value flowing to the
 * renderer.
 */
export async function getCompactionPreparation(
  sessionId: string,
  correlationId: string,
): Promise<Result<CompactionPreparationResult, VexError>> {
  return withClient(correlationId, async (client) => {
    try {
      const result = await client.query<PreparationRow>(
        `SELECT cp.status,
                cp.summary_status,
                cp.chunks_status,
                cp.summary_attempt_count,
                cp.summary_max_attempts,
                cp.chunks_attempt_count,
                cp.chunks_max_attempts,
                (cp.summary_output IS NOT NULL) AS has_summary,
                cp.apply_source,
                cp.apply_requested_at,
                cp.applied_at,
                cp.created_at,
                cp.completed_at
           FROM sessions s
           JOIN compaction_preparations cp ON cp.session_id = s.id
          WHERE s.id = $1
            AND s.scope = $2
            AND s.deleted_at IS NULL
          ORDER BY cp.created_at DESC, cp.id DESC
          LIMIT 1`,
        [sessionId, VEX_APP_SESSION_SCOPE],
      );
      const row = result.rows[0];
      if (!row) return ok(null); // no preparation / unknown / foreign / deleted

      const parsed = compactionPreparationResultSchema.safeParse({
        sessionId,
        status: row.status,
        summaryStatus: row.summary_status,
        chunksStatus: row.chunks_status,
        summaryAttemptCount: toInt(row.summary_attempt_count),
        summaryMaxAttempts: toInt(row.summary_max_attempts),
        chunksAttemptCount: toInt(row.chunks_attempt_count),
        chunksMaxAttempts: toInt(row.chunks_max_attempts),
        hasSummary: row.has_summary,
        applySource: row.apply_source,
        applyRequestedAt: toIsoNullable(row.apply_requested_at),
        appliedAt: toIsoNullable(row.applied_at),
        createdAt: toIso(row.created_at),
        completedAt: toIsoNullable(row.completed_at),
      });
      if (!parsed.success) {
        return dbError(
          correlationId,
          "getCompactionPreparation row failed the DTO contract",
          parsed.error.issues,
        );
      }
      return ok(parsed.data);
    } catch (cause) {
      return dbError(correlationId, "getCompactionPreparation query failed", cause);
    }
  });
}

/**
 * Schema-readiness probe for the preparation worker supervisor. `true` only
 * when Postgres is reachable AND `public.compaction_preparations` exists
 * (migration 058 applied). Any failure → `false`, so the supervisor keeps the
 * branch loops idle rather than claiming against a missing table.
 */
export async function probeCompactionPreparationsReady(): Promise<boolean> {
  // No inbound request to correlate to — the supervisor is the caller.
  const correlationId = randomUUID();
  const outcome = await withClient(correlationId, async (client) => {
    try {
      const r = await client.query<{ reg: string | null }>(
        `SELECT to_regclass('public.compaction_preparations') AS reg`,
      );
      return ok(r.rows[0]?.reg != null);
    } catch (cause) {
      return dbError(
        correlationId,
        "probeCompactionPreparationsReady query failed",
        cause,
      );
    }
  });
  return outcome.ok ? outcome.data : false;
}
