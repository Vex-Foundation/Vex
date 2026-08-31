/**
 * The session control-state aggregate — ONE always-returning statement that
 * answers every question the operator's controls turn on.
 *
 * ## Why one statement, and why always-returning
 *
 * The read this replaces was TWO statements for an agent session: a run query,
 * then a no-row fallback. Two statements are two snapshots, so the facts could
 * legitimately disagree with each other — and the fact that matters most here
 * is a DISJUNCTION (`stoppable`), where one stale term is enough to hide the
 * Stop key from live work. A single statement over a one-row driver
 * (`FROM (SELECT $1 AS session_id)`) gives one coherent snapshot AND always
 * returns a row, so "this session has no run" is an answer rather than an
 * absence the caller has to invent a second query for.
 *
 * ## `stoppable` is computed HERE, not in the renderer
 *
 * It is the authoritative answer to "would pressing Stop do anything?", and
 * every disjunct below is exactly a state `runStopDispatch` acts on. The
 * renderer must never re-derive it from `leaseActive`: `leaseActive` is a
 * sawtooth — true inside a slice, false across every `loop_defer` park — and
 * keying the control off it is the defect this module exists to close.
 *
 * ## The private facts stay private
 *
 * `hasPendingWake` / `hasPendingApproval` / `hasIncompleteApprovalLifecycle`
 * are main-internal. Only `stoppable` crosses to the renderer. They are three
 * different reasons for one answer, and exposing them would invite a consumer
 * to re-implement the policy from the parts.
 *
 * The lifecycle predicate is IMPORTED from the engine's pure contracts leaf,
 * never copied: the same fact decides whether a committed `stop_terminal` stays
 * open, and two spellings of it means the Stop key can be visible while the
 * request that Stop writes is silently retired.
 */

import type { Client } from "pg";

import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  missionRunStatusSchema,
  type MissionRunStatus,
} from "@shared/schemas/sessions.js";
import type {
  RuntimeActivity,
  RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import {
  engineCauseCodeSchema,
  engineErrorClassSchema,
  engineErrorTypeSchema,
  engineStatusCodeSchema,
} from "@shared/schemas/engine-error.js";
import { INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE } from "@vex-agent/db/contracts/approval-lifecycle-predicates.js";
import { OUTSTANDING_USER_FORM_PREDICATE } from "@vex-agent/db/contracts/user-form-lifecycle-predicates.js";
import {
  runtimeDbError,
  withRuntimeDbClient,
} from "./runtime-db-client.js";

const ACTIVE_OR_PAUSED_STATUSES: readonly MissionRunStatus[] = [
  "running",
  "paused_approval",
  "paused_wake",
  "paused_error",
  "paused_user",
  "paused_plan_acceptance",
  "paused_user_form",
];

export type PendingControlKind =
  | "pause_after_step"
  | "stop_terminal"
  | "resume"
  | "cancel_wake";

/**
 * Everything the main process knows about a session's control state, from one
 * snapshot. A superset of the DTO: the existence facts below never cross IPC.
 */
export interface RuntimeControlFacts {
  readonly sessionId: string;
  readonly hasActiveRun: boolean;
  readonly missionRunId: string | null;
  readonly status: MissionRunStatus | null;
  readonly stopReason: string | null;
  readonly lastCheckpointAt: string | null;
  readonly startedAt: string | null;
  readonly iterationCount: number | null;
  readonly leaseActive: boolean;
  readonly leaseExpiresAt: string | null;
  readonly pendingControlKind: PendingControlKind | null;
  readonly lastError?: RuntimeStateDto["lastError"];
  /** MAIN-INTERNAL. A `loop_defer` / continuation park is live. */
  readonly hasPendingWake: boolean;
  /**
   * `due_at` of the earliest pending SESSION-SCOPED wake (`mission_run_id IS
   * NULL`), or `null`.
   *
   * Deliberately narrower than `hasPendingWake`, which counts every pending
   * wake including a mission run's own. This one answers "is the SESSION
   * asleep", which is the question the agent-session surfaces ask and the one
   * `pausedWake` (mission-scoped, status-gated) does not answer.
   */
  readonly sessionWakeDueAt: string | null;
  /** MAIN-INTERNAL. The user still owes an approval decision. */
  readonly hasPendingApproval: boolean;
  /** MAIN-INTERNAL. Durable approval work the system still owes (D1). */
  readonly hasIncompleteApprovalLifecycle: boolean;
  /**
   * MAIN-INTERNAL. An agent turn is parked on a user form and still owed an
   * answer — durable work with no run, no lease and no wake behind it.
   */
  readonly hasOutstandingUserForm: boolean;
}

/**
 * THE control-gating policy, in one named place.
 *
 * Each disjunct is a state the stop dispatcher acts on, so the predicate means
 * exactly "pressing Stop would do something":
 *
 *   - `hasActiveRun` — a non-terminal `mission_runs` row (already restricted to
 *     the active/paused statuses, so a terminal run cannot make it true);
 *   - `leaseActive` — a runner is attached right now;
 *   - `hasPendingWake` — parked on a `loop_defer` or continuation wake;
 *   - `hasPendingApproval` — a decision is queued and the session is waiting;
 *   - `hasIncompleteApprovalLifecycle` — an approved-but-unfinished lifecycle
 *     the reconciler will resume, including the abandoned `dispatching` row
 *     that makes every other fact false while still owing real work;
 *   - `hasOutstandingUserForm` — an agent turn parked on a launch form whose
 *     result was never appended. Same shape of hole as the one above, on the
 *     money path: no run, no lease, no wake, no approval, and a resume that
 *     will run a model turn as soon as the human answers.
 */
export function isStoppable(facts: RuntimeControlFacts): boolean {
  return (
    facts.hasActiveRun
    || facts.leaseActive
    || facts.hasPendingWake
    || facts.hasPendingApproval
    || facts.hasIncompleteApprovalLifecycle
    || facts.hasOutstandingUserForm
  );
}

/**
 * THE activity policy, in one named place (M5), derived from the SAME snapshot
 * `isStoppable` reads.
 *
 * PRECEDENCE, and it is not arbitrary: a held lease outranks a pending wake.
 * The two overlap for exactly one real interval - the executor claims a wake
 * row and acquires the lease before it marks the row consumed - and during it
 * the honest word is "running", because a runner is attached and burning
 * money. Reporting "sleeping until 12:04" while the slice executes is the
 * same class of lie the sawtooth produced in the other direction.
 *
 * Consumers (the composer strip, the tape word) read THIS, never `leaseActive`
 * plus a wake read of their own; two derivations is how the strip and the tape
 * came to disagree.
 */
export function readSessionActivity(facts: RuntimeControlFacts): RuntimeActivity {
  if (facts.leaseActive) return { kind: "running" };
  if (facts.sessionWakeDueAt !== null) {
    return { kind: "sleeping", nextWakeAt: facts.sessionWakeDueAt };
  }
  return { kind: "none" };
}

interface ControlFactsRow {
  readonly mission_run_id: string | null;
  readonly status: string | null;
  readonly started_at: string | Date | null;
  readonly last_checkpoint_at: string | Date | null;
  readonly stop_reason: string | null;
  readonly iteration_count: number | string | null;
  readonly lease_active: boolean | null;
  readonly lease_expires_at: Date | null;
  readonly pending_control_kind: string | null;
  readonly has_pending_wake: boolean | null;
  readonly session_wake_due_at: string | Date | null;
  readonly has_pending_approval: boolean | null;
  readonly has_incomplete_approval_lifecycle: boolean | null;
  readonly has_outstanding_user_form: boolean | null;
  readonly last_error_type: string | null;
  readonly last_error_class: string | null;
  readonly last_error_status: string | null;
  readonly last_error_cause_code: string | null;
}

const CONTROL_FACTS_SQL = `
  SELECT run.id                                          AS mission_run_id,
         run.status                                      AS status,
         run.started_at                                  AS started_at,
         run.last_checkpoint_at                          AS last_checkpoint_at,
         run.stop_reason                                 AS stop_reason,
         run.iteration_count                             AS iteration_count,
         -- BOUNDED extraction: four named keys, never the evidence column
         -- itself and never the run summary. The blob also holds raw
         -- provider/exception text that must not leave the main process, and
         -- selecting the whole column then picking keys in TS would put that
         -- text one refactor away from a DTO.
         run.stop_evidence_json->>'errorType'            AS last_error_type,
         run.stop_evidence_json->>'sdkErrorClass'        AS last_error_class,
         run.stop_evidence_json->>'statusCode'           AS last_error_status,
         run.stop_evidence_json->>'causeCode'            AS last_error_cause_code,
         CASE WHEN l.session_id IS NOT NULL AND l.expires_at >= NOW()
              THEN TRUE ELSE FALSE END                   AS lease_active,
         CASE WHEN l.session_id IS NOT NULL AND l.expires_at >= NOW()
              THEN l.expires_at ELSE NULL END            AS lease_expires_at,
         (SELECT kind FROM runtime_control_requests
           WHERE session_id = s.session_id
             AND status IN ('pending', 'observed')
           ORDER BY created_at ASC
           LIMIT 1)                                      AS pending_control_kind,
         EXISTS (SELECT 1 FROM loop_wake_requests w
                  WHERE w.session_id = s.session_id
                    AND w.status = 'pending')            AS has_pending_wake,
         -- SESSION-scoped park only (mission_run_id IS NULL, migration 057).
         -- A mission run's own wake is described by pausedWake under its
         -- paused_wake status; mixing the two here would make a sleeping
         -- mission report session activity and give the tape two answers.
         -- NOTE: no backticks in this comment. The whole statement is a
         -- template literal, so a backtick here ends the SQL string.
         (SELECT sw.due_at FROM loop_wake_requests sw
           WHERE sw.session_id = s.session_id
             AND sw.status = 'pending'
             AND sw.mission_run_id IS NULL
           ORDER BY sw.due_at ASC
           LIMIT 1)                                      AS session_wake_due_at,
         EXISTS (SELECT 1 FROM approval_queue a
                  WHERE a.session_id = s.session_id
                    AND a.status = 'pending')            AS has_pending_approval,
         EXISTS (SELECT 1 FROM approval_intents ai
                  WHERE ai.session_id = s.session_id
                    AND ${INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE})
                                                         AS has_incomplete_approval_lifecycle,
         EXISTS (SELECT 1 FROM token_launch_intents tli
                  WHERE tli.session_id = s.session_id
                    AND ${OUTSTANDING_USER_FORM_PREDICATE})
                                                         AS has_outstanding_user_form
    FROM (SELECT $1::text AS session_id) s
    LEFT JOIN runner_leases l ON l.session_id = s.session_id
    LEFT JOIN LATERAL (
      SELECT m.id, m.status, m.started_at, m.last_checkpoint_at,
             m.stop_reason, m.iteration_count, m.stop_evidence_json
        FROM mission_runs m
       WHERE m.session_id = s.session_id
         AND m.status = ANY($2::text[])
       ORDER BY m.started_at DESC
       LIMIT 1
    ) run ON TRUE`;

/**
 * Read the whole control state for a session. Always resolves to a fact set
 * when the query succeeds — a session with no run, no lease and nothing queued
 * is a valid answer, not a missing row.
 */
export async function readSessionControlFacts(
  sessionId: string,
  correlationId: string,
): Promise<Result<RuntimeControlFacts, VexError>> {
  return withRuntimeDbClient(correlationId, async (client: Client) => {
    try {
      const result = await client.query<ControlFactsRow>(CONTROL_FACTS_SQL, [
        sessionId,
        ACTIVE_OR_PAUSED_STATUSES,
      ]);
      const row = result.rows[0];
      if (row === undefined) {
        // Unreachable against the one-row driver above; treated as an error
        // rather than silently synthesised, because a fact set nobody read is
        // exactly the "unknown" the renderer must not see as "idle".
        return runtimeDbError(
          correlationId,
          "readSessionControlFacts returned no row for the one-row driver",
        );
      }
      return ok(toFacts(sessionId, row));
    } catch (cause) {
      return runtimeDbError(
        correlationId,
        "readSessionControlFacts query failed",
        cause,
      );
    }
  });
}

function toFacts(sessionId: string, row: ControlFactsRow): RuntimeControlFacts {
  const status = normaliseStatus(row.status);
  return {
    sessionId,
    // The run is only "active" when its status survived the shared validator:
    // an unrecognised status is not a run this process knows how to control.
    hasActiveRun: status !== null,
    missionRunId: row.mission_run_id,
    status,
    stopReason: row.stop_reason,
    lastCheckpointAt: toIsoOrNull(row.last_checkpoint_at),
    startedAt: toIsoOrNull(row.started_at),
    iterationCount: toIntOrNull(row.iteration_count),
    leaseActive: Boolean(row.lease_active),
    leaseExpiresAt: row.lease_expires_at ? toIso(row.lease_expires_at) : null,
    pendingControlKind: normalisePendingControlKind(row.pending_control_kind),
    hasPendingWake: Boolean(row.has_pending_wake),
    sessionWakeDueAt: toIsoOrNull(row.session_wake_due_at ?? null),
    hasPendingApproval: Boolean(row.has_pending_approval),
    hasIncompleteApprovalLifecycle: Boolean(
      row.has_incomplete_approval_lifecycle,
    ),
    hasOutstandingUserForm: Boolean(row.has_outstanding_user_form),
    ...buildLastError(row),
  };
}

// ── Row narrowing ───────────────────────────────────────────────────

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

function normaliseStatus(raw: string | null): MissionRunStatus | null {
  if (raw === null) return null;
  const parsed = missionRunStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const PENDING_CONTROL_KINDS = new Set<string>([
  "pause_after_step",
  "stop_terminal",
  "resume",
  "cancel_wake",
]);

function normalisePendingControlKind(
  raw: string | null,
): PendingControlKind | null {
  if (raw === null) return null;
  return PENDING_CONTROL_KINDS.has(raw) ? (raw as PendingControlKind) : null;
}

function toIntOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

/**
 * Narrow ONE evidence value through the shared boundary schema.
 *
 * The evidence JSONB is untrusted row data: it is written by the engine, but a
 * row may predate the current writer, may have been written by a different
 * version, or may simply be malformed. Validating with the SAME schemas the
 * live `EV.engine.error` payload uses means the durable answer to "why did my
 * run stop" and the live push event speak one vocabulary.
 *
 * A failing value DEGRADES to absent rather than being truncated or coerced: a
 * truncated code is not a code, and a renderer switching on it would land in a
 * default branch anyway.
 */
function narrowEvidence<T>(
  schema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false };
  },
  raw: unknown,
): T | undefined {
  // `undefined` as well as `null`: a driver that never saw the column (an
  // older query shape, a partial row fixture) hands back an absent property,
  // and a reader of untrusted row data must not assume which absence it gets.
  if (raw === null || raw === undefined) return undefined;
  const parsed = schema.safeParse(typeof raw === "string" ? raw.trim() : raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Build the optional `lastError` from the four extracted evidence keys. Every
 * key is independently optional; when nothing survives, the field is omitted
 * entirely, which the DTO reads as "no classification available".
 */
function buildLastError(row: {
  readonly last_error_type?: string | null;
  readonly last_error_class?: string | null;
  readonly last_error_status?: string | null;
  readonly last_error_cause_code?: string | null;
}): { lastError?: RuntimeStateDto["lastError"] } {
  const errorType = narrowEvidence(engineErrorTypeSchema, row.last_error_type);
  const errorClass = narrowEvidence(engineErrorClassSchema, row.last_error_class);
  const causeCode = narrowEvidence(engineCauseCodeSchema, row.last_error_cause_code);
  // `statusCode` arrives as text from the JSONB `->>` operator. Parsed to a
  // number first, then bounded to the real HTTP range by the shared schema —
  // a malformed value is dropped, never coerced to 0.
  const rawStatus = row.last_error_status;
  const parsedStatus =
    typeof rawStatus === "string" ? Number(rawStatus) : Number.NaN;
  const statusCode = narrowEvidence(
    engineStatusCodeSchema,
    Number.isFinite(parsedStatus) ? parsedStatus : undefined,
  );

  const lastError = {
    ...(errorType !== undefined ? { errorType } : {}),
    ...(errorClass !== undefined ? { errorClass } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(causeCode !== undefined ? { causeCode } : {}),
  };
  return Object.keys(lastError).length === 0 ? {} : { lastError };
}
