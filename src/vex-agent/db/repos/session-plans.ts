/**
 * Session-plans repo — pure CRUD persistence for the per-session plan-mode
 * state (toggle + agent-authored action-plan markdown + acceptance).
 *
 * One row per session (PK `session_id`). The plan is the "HOW" that complements
 * a mission's frozen "WHAT"; it is session-scoped so it also works in plain
 * agent sessions. See migration `031_session_plans.sql`.
 *
 * Acceptance contract: `accepted_at` means "the CURRENT `plan_md` is accepted".
 * Any content-changing `upsertPlan` therefore resets it to NULL (re-accept on
 * edit); a no-op same-content write preserves it. The dispatcher execution gate
 * blocks side-effecting tools while `enabled && accepted_at IS NULL`.
 */

import type { PoolClient } from "pg";

import { queryOne, queryOneWith } from "../client.js";

// ── Row + domain ────────────────────────────────────────────────

interface SessionPlanRow {
  session_id: string;
  enabled: boolean;
  plan_md: string;
  accepted_at: string | Date | null;
  off_notice_pending: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface SessionPlan {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly planMd: string;
  /** ISO timestamp of acceptance, or null when the current plan is unaccepted. */
  readonly acceptedAt: string | null;
  /** Derived: the current `planMd` has been user-accepted. */
  readonly accepted: boolean;
  /** One-shot: a "plan mode turned off" prompt note is pending consumption. */
  readonly offNoticePending: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

function mapRow(row: SessionPlanRow): SessionPlan {
  const acceptedAt = row.accepted_at == null ? null : toIso(row.accepted_at);
  return {
    sessionId: row.session_id,
    enabled: row.enabled,
    planMd: row.plan_md,
    acceptedAt,
    accepted: acceptedAt !== null,
    offNoticePending: row.off_notice_pending,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function returningOne(
  sql: string,
  params: unknown[],
  client?: PoolClient,
): Promise<SessionPlan | null> {
  const row = client
    ? await queryOneWith<SessionPlanRow>(client, sql, params)
    : await queryOne<SessionPlanRow>(sql, params);
  return row ? mapRow(row) : null;
}

// ── Reads ───────────────────────────────────────────────────────

/** The session's plan row, or null when none exists yet. */
export async function getActivePlan(
  sessionId: string,
  client?: PoolClient,
): Promise<SessionPlan | null> {
  return returningOne(
    "SELECT * FROM session_plans WHERE session_id = $1",
    [sessionId],
    client,
  );
}

// ── Writes ──────────────────────────────────────────────────────

/**
 * Idempotent upsert of the plan body (called by `PlanWrite`). Resets
 * `accepted_at` to NULL only when the content actually changed (re-accept on
 * edit); a same-content write preserves acceptance.
 *
 * ATOMIC enabled-guard: the conflict-update applies ONLY while the row is still
 * `enabled = true`. If plan-mode was disabled between the handler's read and
 * this write (a race), the WHERE misses → no update → returns null, so the
 * handler fails WITHOUT parking the run with a disabled, unaccepted plan. A
 * fresh INSERT (no row yet) marks `enabled = true` (plan-mode is on whenever
 * PlanWrite runs).
 */
export async function upsertPlan(
  sessionId: string,
  planMd: string,
  client?: PoolClient,
): Promise<SessionPlan | null> {
  return returningOne(
    `INSERT INTO session_plans (session_id, enabled, plan_md, accepted_at, updated_at)
     VALUES ($1, true, $2, NULL, NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       plan_md = EXCLUDED.plan_md,
       accepted_at = CASE
         WHEN session_plans.plan_md IS DISTINCT FROM EXCLUDED.plan_md THEN NULL
         ELSE session_plans.accepted_at
       END,
       updated_at = NOW()
     WHERE session_plans.enabled = true
     RETURNING *`,
    [sessionId, planMd],
    client,
  );
}

/**
 * ATOMIC guarded disable for an ACTIVE-run session. Flips `enabled = false`
 * ONLY if there is no enabled, non-empty, UNACCEPTED plan at update time — such
 * a plan would strand the (about-to-be / already) paused run. Returns null when
 * refused (the WHERE missed). Upsert form so disabling a never-existed plan
 * still succeeds (INSERT a disabled row) rather than returning an ambiguous
 * null.
 *
 * This + the `enabled = true` guard on `upsertPlan` make PlanWrite/disable
 * race-safe in BOTH orderings: disable-first makes the racing `PlanWrite`
 * return null (no park); write-first makes this disable refuse.
 */
export async function disableForActiveRun(
  sessionId: string,
  client?: PoolClient,
): Promise<SessionPlan | null> {
  return returningOne(
    `INSERT INTO session_plans (session_id, enabled, off_notice_pending, updated_at)
     VALUES ($1, false, false, NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       enabled = false,
       off_notice_pending = CASE WHEN session_plans.plan_md <> '' THEN true ELSE false END,
       updated_at = NOW()
     WHERE NOT (session_plans.enabled = true
                AND session_plans.plan_md <> ''
                AND session_plans.accepted_at IS NULL)
     RETURNING *`,
    [sessionId],
    client,
  );
}

/**
 * Toggle plan-mode for a session. Disabling while a non-empty plan exists arms
 * the one-shot off-notice; enabling (or disabling with no plan) clears it.
 *
 * NOTE: for an ACTIVE-run disable, callers use `disableForActiveRun` (atomic
 * strand-guard) instead — this is the plain path for enabling and for disabling
 * agent sessions / sessions with no active run.
 */
export async function setEnabled(
  sessionId: string,
  enabled: boolean,
  client?: PoolClient,
): Promise<SessionPlan> {
  const plan = await returningOne(
    `INSERT INTO session_plans (session_id, enabled, off_notice_pending, updated_at)
     VALUES ($1, $2, false, NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       off_notice_pending = CASE
         WHEN EXCLUDED.enabled = false AND session_plans.plan_md <> '' THEN true
         ELSE false
       END,
       updated_at = NOW()
     RETURNING *`,
    [sessionId, enabled],
    client,
  );
  return plan!;
}

/**
 * Mark the current plan as user-accepted — ONLY when the stored `plan_md` still
 * matches `expectedPlanMd` (the content the user actually reviewed). A
 * concurrent `PlanWrite` that changed the content makes the WHERE miss, so this
 * returns null (caller treats as stale) and the unreviewed version is NOT
 * accepted. Returns null if no plan row exists.
 */
export async function setAccepted(
  sessionId: string,
  expectedPlanMd: string,
  client?: PoolClient,
): Promise<SessionPlan | null> {
  return returningOne(
    `UPDATE session_plans SET accepted_at = NOW(), updated_at = NOW()
     WHERE session_id = $1 AND plan_md = $2 RETURNING *`,
    [sessionId, expectedPlanMd],
    client,
  );
}

/** Clear the one-shot off-notice flag once a prompt build has consumed it. */
export async function consumeOffNotice(
  sessionId: string,
  client?: PoolClient,
): Promise<void> {
  await returningOne(
    `UPDATE session_plans SET off_notice_pending = false, updated_at = NOW()
     WHERE session_id = $1 AND off_notice_pending = true RETURNING *`,
    [sessionId],
    client,
  );
}
