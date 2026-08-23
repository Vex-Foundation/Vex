/**
 * Usage DB helper for the chat panel meter + per-session totals modal.
 *
 * Mirrors `sessions-db.ts` decoupling: own `pg.Client` per call, no
 * `@vex-agent/db/repos/*` import. Maps `usage_log` rows into renderer-
 * safe DTOs with explicit `null` handling for the `NUMERIC cost` column.
 *
 *   usage_log(
 *     id SERIAL PK,
 *     session_id, prompt_tokens, completion_tokens, total_tokens,
 *     cached_tokens, reasoning_tokens,
 *     cost NUMERIC, provider, model, currency, created_at,
 *     cached_savings NUMERIC, cache_write_tokens INT   -- migration 032
 *   )
 *
 * `cached_savings` is the NET cache effect (read savings − write
 * surcharge) and can legitimately be NEGATIVE (first request of an
 * explicit-cache prefix writes more than it reads) — mapped via `toCost`,
 * never clamped.
 *
 * ONE ROW IS ONE MODEL ROUND, NOT ONE TURN. `runTurnLoop` performs many rounds
 * per turn and `executeTurn` logs each of them, so any per-turn figure must
 * aggregate (`getLastTurn`); reading the newest row alone under-reports a
 * multi-round turn by roughly the round count.
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  USAGE_DEFAULT_CURRENCY,
  type ContextWindowResult,
  type LastTurnUsageResult,
  type SessionUsageTotalsDto,
} from "@shared/schemas/usage.js";
import { VEX_APP_SESSION_SCOPE } from "@shared/schemas/sessions.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

// `correlationId` intentionally omitted; `registerHandler` stamps
// `ctx.requestId` downstream. See `messages-db.ts` for full rationale.
function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "usage",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[usage-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "usage",
    message: "Unable to load usage.",
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
    log.warn("[usage-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

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
    log.warn("[usage-db] client.connect failed", cause);
    return dbUnavailable();
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[usage-db] client.end failed (non-fatal)", cause);
    }
  }
}

/**
 * The single aggregate row `getLastTurn` reads. `latest_*` are correlated
 * scalars from the newest round in the turn window; the rest are aggregates
 * over the whole window. `latest_created_at` is `null` exactly when the window
 * is empty.
 */
interface TurnRollupRow {
  readonly latest_prompt_tokens: number | string | null;
  readonly latest_cached_tokens: number | string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly latest_created_at: string | Date | null;
  readonly turn_completion_tokens: number | string | null;
  readonly turn_reasoning_tokens: number | string | null;
  readonly turn_cache_write_tokens: number | string | null;
  readonly turn_cost: number | string | null;
  readonly turn_cached_savings: number | string | null;
  readonly round_count: number | string;
}

interface UsageTotalsRow {
  readonly total_prompt: number | string | null;
  readonly total_completion: number | string | null;
  readonly total_total: number | string | null;
  readonly total_cached_tokens: number | string | null;
  readonly total_cost: number | string | null;
  readonly total_cached_savings: number | string | null;
  readonly request_count: number | string;
  readonly last_request_at: string | Date | null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

function toInt(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/**
 * `NUMERIC` columns come back from `pg` as strings to preserve
 * precision. We coerce to a finite JS number when safe; out-of-range
 * or unparseable values collapse to `null` so the DTO stays JSON-safe.
 */
function toCost(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getSessionTotals(
  sessionId: string,
  currency: string,
): Promise<Result<SessionUsageTotalsDto, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<UsageTotalsRow>(
        `SELECT
            COALESCE(SUM(prompt_tokens), 0)     AS total_prompt,
            COALESCE(SUM(completion_tokens), 0) AS total_completion,
            COALESCE(SUM(total_tokens), 0)      AS total_total,
            COALESCE(SUM(cached_tokens), 0)     AS total_cached_tokens,
            SUM(cost)                            AS total_cost,
            SUM(cached_savings)                  AS total_cached_savings,
            COUNT(*)                             AS request_count,
            MAX(created_at)                      AS last_request_at
           FROM usage_log
          WHERE session_id = $1
            AND currency = $2`,
        [sessionId, currency],
      );
      const row = result.rows[0];
      if (!row) {
        return ok({
          sessionId,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          totalCachedTokens: 0,
          totalCost: null,
          totalCachedSavings: null,
          currency,
          requestCount: 0,
          lastRequestAt: null,
        });
      }
      return ok({
        sessionId,
        totalPromptTokens: toInt(row.total_prompt),
        totalCompletionTokens: toInt(row.total_completion),
        totalTokens: toInt(row.total_total),
        totalCachedTokens: toInt(row.total_cached_tokens),
        totalCost: toCost(row.total_cost),
        // NET savings sum - can be negative; sign preserved.
        totalCachedSavings: toCost(row.total_cached_savings),
        currency,
        requestCount: toInt(row.request_count),
        lastRequestAt: toIsoOrNull(row.last_request_at),
      });
    } catch (cause) {
      return dbError("getSessionTotals query failed", cause);
    }
  });
}

/**
 * Usage for the session's most recent TURN - every model round since the user
 * last spoke, not just the newest `usage_log` row.
 *
 * ## The turn boundary
 *
 * `usage_log` carries no turn identifier, so the window is derived from the
 * transcript: rows written at or after the newest message with `source =
 * 'user'`. That is exactly what a turn is here - `processAgentTurn` appends the
 * user message as its FIRST state mutation and then runs the whole loop, so
 * every round of the turn lands after it. `messages_archive` is unioned in
 * because compaction moves older messages there; without it a fully compacted
 * session would lose its boundary and the window would silently widen to the
 * whole session.
 *
 * A session with no user-sourced message at all (a mission run driven entirely
 * by the engine) has no boundary to find; the window then covers the session's
 * rows, and `roundCount` says so rather than the number pretending to be one
 * exchange.
 *
 * ## Aggregation
 *
 * Input is a SNAPSHOT of the newest round, output/cost/savings are SUMS. The
 * DTO's doc comment carries the full rationale and is the contract; do not
 * re-derive the split at a call site.
 */
export async function getLastTurn(
  sessionId: string,
  currency: string,
): Promise<Result<LastTurnUsageResult, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<TurnRollupRow>(
        `WITH turn_start AS (
            SELECT MAX(created_at) AS at
              FROM (
                SELECT created_at FROM messages
                 WHERE session_id = $1 AND source = 'user'
                UNION ALL
                SELECT created_at FROM messages_archive
                 WHERE session_id = $1 AND source = 'user'
              ) AS user_messages
          ),
          turn_rows AS (
            SELECT *
              FROM usage_log
             WHERE session_id = $1
               AND currency = $2
               AND created_at >= COALESCE(
                     (SELECT at FROM turn_start),
                     TIMESTAMPTZ '-infinity')
          ),
          latest AS (
            SELECT prompt_tokens, cached_tokens, provider, model, created_at
              FROM turn_rows
             ORDER BY created_at DESC
             LIMIT 1
          )
          SELECT
            (SELECT prompt_tokens FROM latest)      AS latest_prompt_tokens,
            (SELECT cached_tokens FROM latest)      AS latest_cached_tokens,
            (SELECT provider      FROM latest)      AS provider,
            (SELECT model         FROM latest)      AS model,
            (SELECT created_at    FROM latest)      AS latest_created_at,
            COALESCE(SUM(completion_tokens), 0)     AS turn_completion_tokens,
            COALESCE(SUM(reasoning_tokens), 0)      AS turn_reasoning_tokens,
            COALESCE(SUM(cache_write_tokens), 0)    AS turn_cache_write_tokens,
            SUM(cost)                               AS turn_cost,
            SUM(cached_savings)                     AS turn_cached_savings,
            COUNT(*)                                AS round_count
           FROM turn_rows`,
        [sessionId, currency],
      );
      const row = result.rows[0];
      // An aggregate always returns one row; an EMPTY window returns that row
      // with `round_count = 0` and a null `latest_created_at`. That is "no
      // usage yet", the same `null` the renderer has always handled - never a
      // fabricated zero-round turn.
      if (!row || toInt(row.round_count) === 0 || row.latest_created_at === null) {
        return ok(null);
      }
      return ok({
        sessionId,
        latestRoundPromptTokens: toInt(row.latest_prompt_tokens),
        latestRoundCachedTokens: toInt(row.latest_cached_tokens),
        turnCompletionTokens: toInt(row.turn_completion_tokens),
        turnReasoningTokens: toInt(row.turn_reasoning_tokens),
        turnCacheWriteTokens: toInt(row.turn_cache_write_tokens),
        turnCost: toCost(row.turn_cost),
        // NET savings sum - can be negative; sign preserved.
        turnCachedSavings: toCost(row.turn_cached_savings),
        roundCount: toInt(row.round_count),
        currency,
        provider: row.provider,
        model: row.model,
        latestRoundAt: toIso(row.latest_created_at),
      });
    } catch (cause) {
      return dbError("getLastTurn query failed", cause);
    }
  });
}

/**
 * Context-window projection for the meter. Reads the session's
 * `token_count` from the `sessions` table — a usage-meter read over a
 * sessions column, deliberately app-scoped (`scope` + `deleted_at IS
 * NULL`, mirroring `sessions-db.getSessionById`) so an unknown,
 * soft-deleted, or foreign-scope id resolves to `null` instead of a
 * fabricated `0 / limit` meter.
 *
 * `contextLimit` is resolved by the caller from the global
 * `AGENT_CONTEXT_LIMIT` and passed through unchanged (or `null` when the
 * configured value is invalid).
 */
export async function getContextWindow(
  sessionId: string,
  contextLimit: number | null,
): Promise<Result<ContextWindowResult, VexError>> {
  return withClient(async (client) => {
    try {
      const result = await client.query<{ token_count: number | string | null }>(
        `SELECT token_count
           FROM sessions
          WHERE id = $1
            AND scope = $2
            AND deleted_at IS NULL`,
        [sessionId, VEX_APP_SESSION_SCOPE],
      );
      const row = result.rows[0];
      if (!row) return ok(null);
      return ok({
        sessionId,
        tokensUsed: toInt(row.token_count),
        contextLimit,
      });
    } catch (cause) {
      return dbError("getContextWindow query failed", cause);
    }
  });
}
