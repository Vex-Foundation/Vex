/**
 * Mission runs repo — per-run state persistence.
 *
 * NO parent_run_id — session_links is the canonical relationship graph.
 * Run status is the source of truth for per-run state (not runtime_state).
 */

import {
  type MissionRunStatus,
  ACTIVE_RUN_STATUSES,
  PAUSED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  ACTIVE_OR_PAUSED_RUN_STATUSES,
} from "../../engine/types.js";
import type { PoolClient } from "pg";

import { query, queryOne, queryOneWith, execute, getPool } from "../client.js";
import { nullableJsonb } from "../params.js";
import logger from "@utils/logger.js";

// ── Types ───────────────────────────────────────────────────────

/**
 * Mission run state. Approval gating reads `sessions.permission` (hydrated
 * into `EngineContext`) so
 * the per-run snapshot is no longer needed.
 */
export interface MissionRun {
  id: string;
  missionId: string;
  sessionId: string;
  status: MissionRunStatus;
  startedAt: string;
  endedAt: string | null;
  lastCheckpointAt: string | null;
  stopReason: string | null;
  stopSummary: string | null;
  stopEvidenceJson: Record<string, unknown> | null;
  iterationCount: number;
  contractSnapshotJson: Record<string, unknown> | null;
  recoveredFromRunId: string | null;
  /** Phase 4d: count of auto-retries scheduled for this run (budget + wake epoch). */
  errorRetryCount: number;
  /** Phase 4d: STICKY fail-closed stamp — true once the run touched a mutating tool. */
  autoRetryUnsafe: boolean;
}

/** SQL `IN (…)` literal compiled once from `ACTIVE_OR_PAUSED_RUN_STATUSES`. */
const ACTIVE_OR_PAUSED_SQL_IN = Array.from(ACTIVE_OR_PAUSED_RUN_STATUSES)
  .map((s) => `'${s}'`)
  .join(",");

/** SQL `IN (…)` literal compiled once from `TERMINAL_RUN_STATUSES`. */
const TERMINAL_SQL_IN = Array.from(TERMINAL_RUN_STATUSES)
  .map((s) => `'${s}'`)
  .join(",");

const ALLOWED_RUN_STATUSES: ReadonlySet<MissionRunStatus> = new Set([
  ...ACTIVE_RUN_STATUSES,
  ...PAUSED_RUN_STATUSES,
  ...TERMINAL_RUN_STATUSES,
]);

function coerceStatus(raw: unknown, runId: string): MissionRunStatus {
  if (typeof raw === "string" && ALLOWED_RUN_STATUSES.has(raw as MissionRunStatus)) {
    return raw as MissionRunStatus;
  }
  logger.warn("engine.mission.status_drift", { runId, raw: String(raw) });
  throw new Error(`Unknown mission run status for ${runId}: ${String(raw)}`);
}

function mapRow(r: Record<string, unknown>): MissionRun {
  const id = r.id as string;
  return {
    id,
    missionId: r.mission_id as string,
    sessionId: r.session_id as string,
    status: coerceStatus(r.status, id),
    startedAt: (r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at as string),
    endedAt: r.ended_at ? (r.ended_at instanceof Date ? r.ended_at.toISOString() : r.ended_at as string) : null,
    lastCheckpointAt: r.last_checkpoint_at ? (r.last_checkpoint_at instanceof Date ? r.last_checkpoint_at.toISOString() : r.last_checkpoint_at as string) : null,
    stopReason: r.stop_reason as string | null,
    stopSummary: r.stop_summary as string | null,
    stopEvidenceJson: r.stop_evidence_json as Record<string, unknown> | null,
    iterationCount: (r.iteration_count as number) ?? 0,
    contractSnapshotJson: r.contract_snapshot_json as Record<string, unknown> | null,
    recoveredFromRunId: r.recovered_from_run_id as string | null,
    errorRetryCount: (r.error_retry_count as number) ?? 0,
    autoRetryUnsafe: (r.auto_retry_unsafe as boolean) ?? false,
  };
}

// ── CRUD ────────────────────────────────────────────────────────

export async function createRun(
  id: string,
  missionId: string,
  sessionId: string,
  options: {
    contractSnapshotJson?: Record<string, unknown> | null;
    recoveredFromRunId?: string | null;
  } = {},
  client?: PoolClient,
): Promise<void> {
  const sql = `INSERT INTO mission_runs (
       id, mission_id, session_id, contract_snapshot_json, recovered_from_run_id
     ) VALUES ($1, $2, $3, $4::jsonb, $5)`;
  const params = [
    id,
    missionId,
    sessionId,
    nullableJsonb(options.contractSnapshotJson ?? null),
    options.recoveredFromRunId ?? null,
  ];
  if (client) {
    await client.query(sql, params);
  } else {
    await execute(sql, params);
  }
}

/**
 * UNCONDITIONAL status write — the narrow exception, not the default.
 *
 * INVARIANT (enforced repo-wide): a terminal user Stop (`status = 'stopped'`,
 * `stop_reason = 'user_stopped'`) must never be overwritten or reopened by any
 * other write. A terminal run row is immutable audit history.
 *
 * Choose the right helper:
 *   - flipping a run to `running`      → `startRunIfNotTerminal`
 *   - any pause / park / recovery write → `updateStatusIfNotTerminal`
 *   - a write that moves a run TO a terminal state → `updateStatusIfNotTerminal`
 *     as well, unless the caller is on the ALLOWLIST below. Reaching terminal is
 *     not by itself a licence to overwrite a Stop: `completed` / `failed` are
 *     outcomes decided from state that is stale by the time the write lands.
 *
 * THE ONE CRITERION for an allowlist entry: the caller holds the run row's
 * `SELECT … FOR UPDATE` lock and has re-checked `TERMINAL_RUN_STATUSES` on the
 * freshly-locked row INSIDE THE SAME TRANSACTION as the write. The guard is the
 * lock, not the CAS.
 *
 * "It writes the `stopped`/`user_stopped` pair itself" is NOT a criterion and
 * was removed after it proved wrong: stop-for-edit wrote that same pair and
 * still clobbered a committed ordinary Stop, because the pair is identical but
 * the PARENT MISSION state is not (`draft` versus `cancelled`). Writing the
 * same status as the invariant's subject says nothing about whether you raced
 * it. Only the locked re-check does.
 *
 * ALLOWLIST — the only callers that may use this function, and why:
 *   1. `engine/runtime/lease-and-status/apply-user-stop.ts` — IS the user stop.
 *      Reads the run `FOR UPDATE` and returns `already_terminal` without
 *      writing when the re-check fails, in the same transaction as the write.
 *   2. `engine/core/runner/mission-auto-retry.ts` — writes `paused_error` inside
 *      a transaction that already re-checked `TERMINAL_RUN_STATUSES` under
 *      `SELECT … FOR UPDATE` on the same row, behind the session control lock
 *      and `gateOnOperatorStopWithClient`.
 *   3. `engine/core/turn-loop-tool-batch/approval-stop.ts` — writes
 *      `paused_approval` inside a transaction holding the session control lock
 *      with `gateOnOperatorStopWithClient` already run (which locks the run row
 *      and applies any queued stop).
 *
 * `engine/core/runner/abort.ts` and `engine/core/runner/mission-finalize.ts`
 * were removed from this list: both now delegate the stop-for-edit transition
 * to `lease-and-status/apply-stop-for-edit.ts`, which runs entirely inside
 * entry 1's transaction.
 *
 * A NEW caller outside that list is a defect. `mission-runs-unconditional-status-write.test.ts`
 * enumerates the call sites and fails when one appears — update the allowlist
 * there and here together, with the reason, or use a guarded helper instead.
 */
export async function updateStatus(
  id: string,
  status: MissionRunStatus,
  stopReason?: string,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
  client?: PoolClient,
): Promise<void> {
  // Two SQL paths (not one with conditional string-injection) so the
  // placeholder count always matches the params array. A single template
  // with `isRunning ? "NULL" : "COALESCE($N, …)"` left $2..$4 orphan when
  // status === "running" and Postgres aborts type-inference for unused
  // placeholders ("could not determine data type of parameter $2").
  if (status === "running") {
    // Live state: clear stale stop evidence from paused_wake / paused_error.
    const runningSql = `UPDATE mission_runs SET status = 'running',
       stop_reason = NULL, stop_summary = NULL,
       stop_evidence_json = NULL, ended_at = NULL
       WHERE id = $1`;
    if (client) {
      await client.query(runningSql, [id]);
    } else {
      await execute(runningSql, [id]);
    }
    return;
  }

  // Paused statuses keep prior evidence (COALESCE merge); terminal statuses
  // additionally stamp ended_at to NOW().
  const ended = TERMINAL_RUN_STATUSES.has(status) ? "NOW()" : "ended_at";
  const pausedSql = `UPDATE mission_runs SET status = $1,
     stop_reason = COALESCE($2, stop_reason),
     stop_summary = COALESCE($3, stop_summary),
     stop_evidence_json = COALESCE($4::jsonb, stop_evidence_json),
     ended_at = ${ended}
     WHERE id = $5`;
  const pausedParams = [
    status,
    stopReason ?? null,
    stopPayload?.summary ?? null,
    nullableJsonb(stopPayload?.evidence ?? null),
    id,
  ];
  if (client) {
    await client.query(pausedSql, pausedParams);
  } else {
    await execute(pausedSql, pausedParams);
  }
}

/**
 * Guarded status write for RECOVERY paths — a terminal run row is immutable
 * audit history and must never be re-opened.
 *
 * `updateStatus` is unconditional by design: it is how a run legitimately
 * REACHES a terminal state. But every "something failed, park the run in
 * `paused_error`" path is a decision made from knowledge that may already be
 * stale — an operator Stop can have landed terminally in between. Overwriting
 * it would erase what the user actually asked for and re-open a run whose
 * approvals were already rejected and whose lease was already released. The
 * guard is a CAS in the WHERE clause, not a read-then-write, so it holds under
 * concurrency.
 *
 * `running` is excluded at the type level: this helper keeps prior stop
 * evidence (COALESCE merge), whereas a flip to `running` must CLEAR it, and
 * no recovery path needs that.
 *
 * Returns `true` when the row was updated, `false` when the run was already
 * terminal or no longer exists.
 */
export async function updateStatusIfNotTerminal(
  id: string,
  status: Exclude<MissionRunStatus, "running">,
  stopReason?: string,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
  client?: PoolClient,
): Promise<boolean> {
  const ended = TERMINAL_RUN_STATUSES.has(status) ? "NOW()" : "ended_at";
  const sql = `UPDATE mission_runs SET status = $1,
     stop_reason = COALESCE($2, stop_reason),
     stop_summary = COALESCE($3, stop_summary),
     stop_evidence_json = COALESCE($4::jsonb, stop_evidence_json),
     ended_at = ${ended}
     WHERE id = $5 AND status NOT IN (${TERMINAL_SQL_IN})`;
  const params = [
    status,
    stopReason ?? null,
    stopPayload?.summary ?? null,
    nullableJsonb(stopPayload?.evidence ?? null),
    id,
  ];
  const affected = client
    ? (await client.query(sql, params)).rowCount ?? 0
    : await execute(sql, params);
  return affected > 0;
}

/**
 * Guarded `running` flip — the counterpart of `updateStatusIfNotTerminal` for
 * the one status that helper excludes at the type level.
 *
 * `running` needs its own function because it CLEARS prior stop evidence
 * (`stop_reason` / `stop_summary` / `stop_evidence_json` / `ended_at`) whereas
 * `updateStatusIfNotTerminal` COALESCE-merges it. The terminal CAS in the
 * WHERE clause is identical, and needed for the same reason: a resume decides
 * "this run is resumable" from a read taken before several awaits (provider
 * resolve, config load, mission read), and an operator Stop can land terminally
 * inside that window. An unconditional flip would re-open a stopped run AND let
 * the turn loop keep executing it.
 *
 * Returns `true` when the row was flipped, `false` when the run was already
 * terminal or no longer exists — the caller must not run the turn on `false`.
 */
export async function startRunIfNotTerminal(
  id: string,
  client?: PoolClient,
): Promise<boolean> {
  const sql = `UPDATE mission_runs SET status = 'running',
     stop_reason = NULL, stop_summary = NULL,
     stop_evidence_json = NULL, ended_at = NULL
     WHERE id = $1 AND status NOT IN (${TERMINAL_SQL_IN})`;
  const affected = client
    ? (await client.query(sql, [id])).rowCount ?? 0
    : await execute(sql, [id]);
  return affected > 0;
}

export async function setLastCheckpoint(id: string): Promise<void> {
  await execute(
    "UPDATE mission_runs SET last_checkpoint_at = NOW() WHERE id = $1",
    [id],
  );
}

export async function incrementIterations(id: string): Promise<number> {
  const row = await queryOne<{ iteration_count: number }>(
    "UPDATE mission_runs SET iteration_count = iteration_count + 1 WHERE id = $1 RETURNING iteration_count",
    [id],
  );
  return row?.iteration_count ?? 0;
}

/**
 * Phase 4d: STICKY fail-closed stamp. Set the instant the run is about to
 * dispatch a mutating tool. Once true it is never cleared within the run's
 * life, so an error after a side effect can never auto-retry (double-spend
 * gate). Idempotent — re-stamping an already-unsafe run is a harmless no-op.
 */
export async function markAutoRetryUnsafe(
  id: string,
  client?: PoolClient,
): Promise<void> {
  const sql = "UPDATE mission_runs SET auto_retry_unsafe = true WHERE id = $1";
  // Verify the stamp actually landed. A drifted/missing run id affects 0 rows;
  // returning silently would let a mutating handler proceed with NO durable
  // unsafe stamp (fail-OPEN). Throwing keeps the dispatcher fail-closed.
  const affected = client
    ? (await client.query(sql, [id])).rowCount ?? 0
    : await execute(sql, [id]);
  if (affected !== 1) {
    throw new Error(
      `markAutoRetryUnsafe: expected to stamp exactly 1 run, affected ${affected} (run ${id})`,
    );
  }
}

/**
 * Phase 4d: bump the auto-retry budget/epoch. Returns the new count. The
 * scheduler calls this inside the same locked tx that persists `paused_error`
 * so the count and the scheduled wake's `attempt` payload stay consistent.
 */
export async function incrementErrorRetryCount(
  id: string,
  client?: PoolClient,
): Promise<number> {
  const sql =
    "UPDATE mission_runs SET error_retry_count = error_retry_count + 1 WHERE id = $1 RETURNING error_retry_count";
  const row = client
    ? (await client.query<{ error_retry_count: number }>(sql, [id])).rows[0]
    : await queryOne<{ error_retry_count: number }>(sql, [id]);
  return row?.error_retry_count ?? 0;
}

export async function getActiveRun(
  missionId: string,
  client?: PoolClient,
): Promise<MissionRun | null> {
  const sql = `SELECT * FROM mission_runs WHERE mission_id = $1 AND status IN (${ACTIVE_OR_PAUSED_SQL_IN}) ORDER BY started_at DESC LIMIT 1`;
  const row = client
    ? await queryOneWith<Record<string, unknown>>(client, sql, [missionId])
    : await queryOne<Record<string, unknown>>(sql, [missionId]);
  return row ? mapRow(row) : null;
}

/**
 * Fetch the active run for a session (keyed by `session_id`, filtered to
 * non-terminal statuses). Used by the PR-7 ingress router — user messages
 * arrive with a session id, not a mission id, and the router needs to
 * distinguish `running` / `paused_approval` / `paused_wake` from no active
 * work at all. `getRunBySession` is intentionally statusless and unsuitable
 * for routing decisions; `getActiveRun(missionId)` is keyed by mission id.
 */
export async function getActiveRunBySession(
  sessionId: string,
  client?: PoolClient,
): Promise<MissionRun | null> {
  const sql = `SELECT * FROM mission_runs WHERE session_id = $1 AND status IN (${ACTIVE_OR_PAUSED_SQL_IN}) ORDER BY started_at DESC LIMIT 1`;
  const row = client
    ? await queryOneWith<Record<string, unknown>>(client, sql, [sessionId])
    : await queryOne<Record<string, unknown>>(sql, [sessionId]);
  return row ? mapRow(row) : null;
}

/**
 * Atomic compare-and-set transition from any of `fromStatuses` to `running`.
 *
 * Used by `/retry` and the wake executor to claim a paused run without
 * racing each other: the SELECT … FOR UPDATE locks the row, the UPDATE only
 * fires when the locked status is in the allowed set, and the function
 * returns the previous status on success or `null` if another resumer
 * already moved the row out of the allowed set.
 */
export async function casFlipToRunning(
  runId: string,
  fromStatuses: readonly MissionRunStatus[],
): Promise<MissionRunStatus | null> {
  if (fromStatuses.length === 0) return null;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockRow = await client.query<{ status: string }>(
      "SELECT status FROM mission_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    if (lockRow.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const prev = coerceStatus(lockRow.rows[0].status, runId);
    if (!fromStatuses.includes(prev)) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE mission_runs
       SET status = 'running',
           stop_reason = NULL,
           stop_summary = NULL,
           stop_evidence_json = NULL,
           ended_at = NULL
       WHERE id = $1`,
      [runId],
    );
    await client.query("COMMIT");
    return prev;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // ROLLBACK failures are non-actionable; the original error is what matters.
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Every run that is still `running` or parked in a `paused_*` state — the
 * candidate set for the agent-independent deadline sweep
 * (`engine/wake/deadline-watchdog.ts`). Unbounded on purpose: the active set is
 * a handful of rows (one active run per mission), and a LIMIT could starve an
 * overdue run behind newer ones. Ordered oldest-first so the most overdue rows
 * are enforced first.
 */
export async function listActiveOrPausedRuns(): Promise<MissionRun[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM mission_runs
     WHERE status IN (${ACTIVE_OR_PAUSED_SQL_IN})
     ORDER BY started_at ASC`,
  );
  return rows.map(mapRow);
}

/**
 * Atomic compare-and-set from any of `fromStatuses` to the terminal
 * `failed` / `deadline_reached` pair — the deadline watchdog's claim.
 *
 * The mirror image of `casFlipToRunning`: SELECT … FOR UPDATE locks the row,
 * the UPDATE only fires when the LOCKED status is still in the allowed set, and
 * the previous status is returned on success or `null` when someone else
 * already moved the row. That `null` is what makes the sweep idempotent and
 * safe against a concurrent resume or the loop-boundary enforcer — only one
 * caller can ever win the flip, so the terminal side-effects (mission row,
 * ledger close, approvals cleanup) run exactly once.
 *
 * Unlike `updateStatus`, stop fields are written unconditionally (no COALESCE):
 * a parked run carries stale `paused_error` evidence that must NOT survive into
 * the deadline record.
 */
export async function casStopPastDeadline(
  runId: string,
  fromStatuses: readonly MissionRunStatus[],
  payload: {
    stopReason: "deadline_reached";
    summary?: string;
    evidence?: Record<string, unknown>;
  },
): Promise<MissionRunStatus | null> {
  if (fromStatuses.length === 0) return null;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockRow = await client.query<{ status: string }>(
      "SELECT status FROM mission_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    // Destructure rather than index — `rows[0]` is `T | undefined` under the
    // app's stricter `noUncheckedIndexedAccess` tsconfig.
    const locked = lockRow.rows[0];
    if (locked === undefined) {
      await client.query("ROLLBACK");
      return null;
    }
    const prev = coerceStatus(locked.status, runId);
    if (!fromStatuses.includes(prev)) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE mission_runs
       SET status = 'failed',
           stop_reason = $2,
           stop_summary = $3,
           stop_evidence_json = $4::jsonb,
           ended_at = NOW()
       WHERE id = $1`,
      [
        runId,
        payload.stopReason,
        payload.summary ?? null,
        nullableJsonb(payload.evidence ?? null),
      ],
    );
    await client.query("COMMIT");
    return prev;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // ROLLBACK failures are non-actionable; the original error is what matters.
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function getRun(
  id: string,
  client?: PoolClient,
): Promise<MissionRun | null> {
  const sql = "SELECT * FROM mission_runs WHERE id = $1";
  const row = client
    ? await queryOneWith<Record<string, unknown>>(client, sql, [id])
    : await queryOne<Record<string, unknown>>(sql, [id]);
  return row ? mapRow(row) : null;
}

export async function getRunBySession(
  sessionId: string,
  client?: PoolClient,
): Promise<MissionRun | null> {
  const sql =
    "SELECT * FROM mission_runs WHERE session_id = $1 ORDER BY started_at DESC LIMIT 1";
  const row = client
    ? await queryOneWith<Record<string, unknown>>(client, sql, [sessionId])
    : await queryOne<Record<string, unknown>>(sql, [sessionId]);
  return row ? mapRow(row) : null;
}

export async function getLatestFailedRunBySession(sessionId: string): Promise<MissionRun | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM mission_runs WHERE session_id = $1 AND status = 'failed' ORDER BY ended_at DESC NULLS LAST, started_at DESC LIMIT 1",
    [sessionId],
  );
  return row ? mapRow(row) : null;
}
