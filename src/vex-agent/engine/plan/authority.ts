/**
 * Plan-mode engine authority — the server-side writers behind the session-scoped
 * `plan.setEnabled` / `plan.accept` IPC, plus a `plan.get` read. Authority lives
 * HERE (not the renderer): the renderer is untrusted UI.
 *
 * Plan-mode is session-scoped (works in agent AND mission sessions), so the
 * authorization is SESSION OWNERSHIP — the session must exist. (Unlike mission
 * auto-retry, there is no `permission === "full"` gate; plan-mode is advisory
 * style/behaviour and never widens permissions — the dispatcher execution gate,
 * not this writer, enforces acceptance.) Read-then-write for accept runs inside
 * one transaction so it serialises against a concurrent `PlanWrite` upsert.
 *
 * NEVER resumes a run — the IPC layer composes acceptance with the existing
 * `runResumeDispatch` primitive after this writer sets `accepted_at`.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import { getSession } from "@vex-agent/db/repos/sessions.js";
import * as sessionPlansRepo from "@vex-agent/db/repos/session-plans.js";
import type { SessionPlan } from "@vex-agent/db/repos/session-plans.js";

export type PlanAuthorityOutcome =
  | { readonly outcome: "ok"; readonly plan: SessionPlan }
  | { readonly outcome: "not_found" } // session does not exist
  | { readonly outcome: "no_plan" } // accept attempted with no enabled plan
  | { readonly outcome: "stale" } // plan content changed since the user reviewed it
  | { readonly outcome: "blocked_pending_acceptance" }; // can't disable: unaccepted plan would strand an active run

/** Toggle session-scoped plan-mode on/off. Creates the row on first enable. */
export async function setSessionPlanEnabled(
  sessionId: string,
  enabled: boolean,
): Promise<PlanAuthorityOutcome> {
  return withTransaction(async (client) => {
    const session = await getSession(sessionId);
    if (!session) return { outcome: "not_found" };
    const plan = await sessionPlansRepo.setEnabled(sessionId, enabled, client);
    return { outcome: "ok", plan };
  });
}

/**
 * Mark the current plan as user-accepted (unblocks the execution gate) — ONLY
 * if the stored plan still matches `expectedPlanMd` (the content the user
 * reviewed). A concurrent `PlanWrite` that changed the content yields `stale`,
 * so an unreviewed version is never accepted (optimistic-concurrency guard).
 */
export async function disableSessionPlanForActiveRun(
  sessionId: string,
): Promise<PlanAuthorityOutcome> {
  return withTransaction(async (client) => {
    const session = await getSession(sessionId);
    if (!session) return { outcome: "not_found" };
    // Atomic strand-guard lives in the repo UPDATE: refuses if an enabled,
    // non-empty, UNACCEPTED plan exists at update time (race-safe vs PlanWrite).
    const plan = await sessionPlansRepo.disableForActiveRun(sessionId, client);
    if (!plan) return { outcome: "blocked_pending_acceptance" };
    return { outcome: "ok", plan };
  });
}

export async function acceptSessionPlan(
  sessionId: string,
  expectedPlanMd: string,
): Promise<PlanAuthorityOutcome> {
  return withTransaction(async (client) => {
    const session = await getSession(sessionId);
    if (!session) return { outcome: "not_found" };
    const existing = await sessionPlansRepo.getActivePlan(sessionId, client);
    if (!existing || !existing.enabled || existing.planMd.length === 0) {
      return { outcome: "no_plan" };
    }
    const plan = await sessionPlansRepo.setAccepted(sessionId, expectedPlanMd, client);
    // Null here means the content changed since the user reviewed it (the
    // content-conditional UPDATE missed) — the row exists (checked above).
    if (!plan) return { outcome: "stale" };
    return { outcome: "ok", plan };
  });
}

/** Read the session plan state (null when plan-mode was never touched). */
export async function getSessionPlan(
  sessionId: string,
): Promise<SessionPlan | null> {
  return sessionPlansRepo.getActivePlan(sessionId);
}
