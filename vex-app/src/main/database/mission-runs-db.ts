/**
 * Mission runs DB helper for `runtime.getState`.
 *
 * Mirrors `sessions-db.ts` decoupling: own `pg.Client` per call. The
 * helper resolves the single active or paused run for a session (the
 * engine guarantees at most one at a time through its mission CAS,
 * but this code never trusts that invariant blindly — it sorts by
 * `started_at DESC` and takes the first row).
 *
 *   mission_runs(
 *     id, mission_id, session_id, status, started_at, ended_at,
 *     last_checkpoint_at, stop_reason, stop_summary, iteration_count,
 *     recovered_from_run_id (migration 015)
 *   )
 */

import { Client, type ClientConfig } from "pg";
import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  missionRunStatusSchema,
  type MissionRunStatus,
} from "@shared/schemas/sessions.js";
import { type RuntimeRunStateFacts } from "@shared/schemas/runtime.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";
import {
  readSessionControlFacts,
  type RuntimeControlFacts,
} from "./session-control-state.js";
import {
  runtimeDbError,
  withRuntimeDbClient,
} from "./runtime-db-client.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

/**
 * Latest mission_run for a session regardless of status (incl. terminal).
 * Unlike `getActiveRunForSession` (active/paused only), this lets the
 * `mission.retry` dispatcher distinguish a terminal run (→ blocked_terminal)
 * from a session that never had a run (→ no_active_run). `null` = no run ever.
 *
 * `leaseActive` (same `runner_leases` join as `getActiveRunForSession`) lets
 * the retry dispatcher tell a genuinely `running` run apart from one whose
 * lease expired/released while status stayed `running` — WITHOUT that, a
 * dead lease reported `already_running` and stranded the operator with no
 * way to recover it (issue #12's bug class).
 */
export async function getLatestRunForSession(
  sessionId: string,
  correlationId: string,
): Promise<
  Result<
    { missionRunId: string; status: MissionRunStatus; leaseActive: boolean } | null,
    VexError
  >
> {
  return withRuntimeDbClient(correlationId, async (client) => {
    try {
      const result = await client.query<{
        id: string;
        status: string;
        lease_active: boolean | null;
      }>(
        `SELECT m.id, m.status,
                CASE WHEN l.session_id IS NOT NULL AND l.expires_at >= NOW()
                     THEN TRUE ELSE FALSE END AS lease_active
           FROM mission_runs m
           LEFT JOIN runner_leases l ON l.session_id = m.session_id
          WHERE m.session_id = $1
          ORDER BY m.started_at DESC
          LIMIT 1`,
        [sessionId],
      );
      const row = result.rows[0];
      if (!row) return ok(null);
      const parsed = missionRunStatusSchema.safeParse(row.status);
      if (!parsed.success) {
        return runtimeDbError(
          correlationId,
          `getLatestRunForSession: unrecognized run status "${row.status}"`,
        );
      }
      return ok({
        missionRunId: row.id,
        status: parsed.data,
        leaseActive: Boolean(row.lease_active),
      });
    } catch (cause) {
      return runtimeDbError(
        correlationId,
        "getLatestRunForSession query failed",
        cause,
      );
    }
  });
}

/**
 * Run + lease + pending-control facts for a session, projected from the ONE
 * control-state aggregate.
 *
 * The two-statement implementation this replaces (a run query plus a no-row
 * fallback) is gone rather than kept alongside: two statements are two
 * snapshots of the same tables, and a control surface that reads a disjunction
 * across them can be stale in exactly the term that matters. `stoppable` and
 * `pausedWake` are deliberately NOT projected here — this helper reports what a
 * run and its lease are doing, and does not own the control-gating policy or
 * the wake table.
 */
export async function getActiveRunForSession(
  sessionId: string,
  correlationId: string,
): Promise<Result<RuntimeRunStateFacts, VexError>> {
  const facts = await readSessionControlFacts(sessionId, correlationId);
  if (!facts.ok) return facts;
  return ok(toRunStateFacts(facts.data));
}

/**
 * EXPLICIT field-by-field projection, never a spread of the fact set. The DTO
 * is `.strict()`, and the aggregate deliberately carries main-internal
 * existence facts that must not cross IPC — a spread would carry them the day
 * one is added, and the strict parse would start failing somewhere else.
 */
export function toRunStateFacts(
  facts: RuntimeControlFacts,
): RuntimeRunStateFacts {
  return {
    sessionId: facts.sessionId,
    hasActiveRun: facts.hasActiveRun,
    missionRunId: facts.missionRunId,
    status: facts.status,
    stopReason: facts.stopReason,
    lastCheckpointAt: facts.lastCheckpointAt,
    startedAt: facts.startedAt,
    iterationCount: facts.iterationCount,
    leaseActive: facts.leaseActive,
    leaseExpiresAt: facts.leaseExpiresAt,
    pendingControlKind: facts.pendingControlKind,
    ...(facts.lastError === undefined ? {} : { lastError: facts.lastError }),
  };
}

const AGENT_WORK_UNVERIFIABLE =
  "Couldn't verify it's safe to update right now. Make sure Vex's services are running, then try again.";

/**
 * Safe-restart signal for the updater (M13): is any agent work in flight that
 * an app restart could corrupt? Does NOT reuse `withClient` because it must be
 * TRI-STATE on DB availability:
 *   - DB UNCONFIGURED (`buildPoolConfig() === null`, e.g. pre-onboarding) ->
 *     not active (fail-OPEN): no agent can run without a DB.
 *   - CONFIGURED but connect/query fails -> ACTIVE (fail-CLOSED): a broken
 *     runtime signal must not be read as "idle" (no in-memory fallback gate
 *     exists).
 *   - query succeeds -> running mission OR live runner lease OR pending approval.
 */
export async function hasActiveAgentWork(): Promise<{
  active: boolean;
  reason: string;
}> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[mission-runs-db] hasActiveAgentWork: buildPoolConfig threw", cause);
    return { active: true, reason: AGENT_WORK_UNVERIFIABLE };
  }
  if (cfg === null) {
    // DB not configured yet — no agent work is possible (fail-open).
    return { active: false, reason: "" };
  }

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
    log.warn("[mission-runs-db] hasActiveAgentWork: connect failed", cause);
    return { active: true, reason: AGENT_WORK_UNVERIFIABLE };
  }
  try {
    const result = await client.query<{
      running_mission: boolean;
      active_lease: boolean;
      pending_approval: boolean;
    }>(
      `SELECT
         EXISTS(SELECT 1 FROM mission_runs WHERE status = 'running')      AS running_mission,
         EXISTS(SELECT 1 FROM runner_leases WHERE expires_at >= NOW())    AS active_lease,
         EXISTS(SELECT 1 FROM approval_queue WHERE status = 'pending')    AS pending_approval`,
    );
    const row = result.rows[0];
    if (!row) return { active: false, reason: "" };
    if (row.running_mission || row.active_lease) {
      return {
        active: true,
        reason:
          "An agent run is still in progress. Let it finish or pause it, then update.",
      };
    }
    if (row.pending_approval) {
      return {
        active: true,
        reason:
          "An approval is waiting for your decision. Resolve it before updating.",
      };
    }
    return { active: false, reason: "" };
  } catch (cause) {
    log.warn("[mission-runs-db] hasActiveAgentWork: query failed", cause);
    return { active: true, reason: AGENT_WORK_UNVERIFIABLE };
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn(
        "[mission-runs-db] hasActiveAgentWork: client.end failed (non-fatal)",
        cause,
      );
    }
  }
}
