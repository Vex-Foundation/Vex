/**
 * Session-scoped plan-mode IPC — `plan.get` / `plan.setEnabled` / `plan.accept`.
 *
 * Authority is server-side (engine `plan/authority.ts`): a missing/cross session
 * collapses to `not_found`. `plan.accept` sets `accepted_at` then resumes a
 * plan-acceptance-paused mission run via the SHARED resume dispatcher (guarded
 * to `paused_plan_acceptance` so it never resumes a wake/user pause). The engine
 * is dynamically imported (renderer never touches it); only the type is imported.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  planGetInputSchema,
  planGetResultSchema,
  planSetEnabledInputSchema,
  planSetEnabledResultSchema,
  planAcceptInputSchema,
  planAcceptResultSchema,
  type PlanState,
  type PlanGetResult,
  type PlanSetEnabledResult,
  type PlanAcceptResult,
} from "@shared/schemas/session-plan.js";
import type { SessionPlan } from "@vex-agent/db/repos/session-plans.js";
import { getActiveRunForSession } from "../../database/mission-runs-db.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { runResumeDispatch } from "../_shared/runtime-resume-dispatch.js";

function toPlanState(plan: SessionPlan): PlanState {
  return {
    enabled: plan.enabled,
    planMd: plan.planMd,
    accepted: plan.accepted,
    acceptedAt: plan.acceptedAt,
    updatedAt: plan.updatedAt,
  };
}

function registerPlanGetHandler(): () => void {
  return registerHandler({
    channel: CH.sessions.planGet,
    domain: "internal",
    inputSchema: planGetInputSchema,
    outputSchema: planGetResultSchema,
    handle: async (input, ctx): Promise<Result<PlanGetResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { getSessionPlan } = await import("@vex-agent/engine/plan/authority.js");
        const plan = await getSessionPlan(input.sessionId);
        return ok(plan ? toPlanState(plan) : null);
      } catch (cause) {
        log.warn(`[ipc:vex:sessions:planGet] failed correlationId=${ctx.requestId}`, cause);
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}

function registerPlanSetEnabledHandler(): () => void {
  return registerHandler({
    channel: CH.sessions.planSetEnabled,
    domain: "internal",
    inputSchema: planSetEnabledInputSchema,
    outputSchema: planSetEnabledResultSchema,
    handle: async (input, ctx): Promise<Result<PlanSetEnabledResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        // Refuse turning plan-mode OFF while a run is paused awaiting acceptance
        // — else the run is stranded (generic resume refuses it, and accept
        // would no longer apply). The user must accept the plan or stop first.
        if (!input.enabled) {
          const runState = await getActiveRunForSession(
            input.sessionId,
            ctx.requestId,
          );
          // Fail closed: if we cannot read the run state, do NOT flip the flag
          // (else we might strand a paused-for-acceptance run we couldn't see).
          if (!runState.ok) return runState;
          if (runState.data.hasActiveRun) {
            // ATOMIC guarded disable: refuses (blocked_pending_acceptance) if an
            // enabled, non-empty, UNACCEPTED plan exists at update time. The
            // strand-guard lives in the repo UPDATE, so it is race-safe vs a
            // concurrent plan_write in BOTH orderings (disable-first → plan_write
            // returns null; write-first → this refuses). The user must accept the
            // plan or stop the mission.
            const { disableSessionPlanForActiveRun } = await import(
              "@vex-agent/engine/plan/authority.js"
            );
            const outcome = await disableSessionPlanForActiveRun(input.sessionId);
            log.info(
              `[ipc:vex:sessions:planSetEnabled] disable outcome=${outcome.outcome} ` +
                `correlationId=${ctx.requestId}`,
            );
            if (outcome.outcome === "blocked_pending_acceptance") {
              return ok({ outcome: "blocked_pending_acceptance" });
            }
            if (outcome.outcome !== "ok") return ok({ outcome: "not_found" });
            return ok({ outcome: "updated", state: toPlanState(outcome.plan) });
          }
        }
        const { setSessionPlanEnabled } = await import("@vex-agent/engine/plan/authority.js");
        const outcome = await setSessionPlanEnabled(input.sessionId, input.enabled);
        log.info(
          `[ipc:vex:sessions:planSetEnabled] outcome=${outcome.outcome} ` +
            `enabled=${input.enabled} correlationId=${ctx.requestId}`,
        );
        if (outcome.outcome !== "ok") return ok({ outcome: "not_found" });
        return ok({ outcome: "updated", state: toPlanState(outcome.plan) });
      } catch (cause) {
        log.warn(`[ipc:vex:sessions:planSetEnabled] failed correlationId=${ctx.requestId}`, cause);
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}

function registerPlanAcceptHandler(): () => void {
  return registerHandler({
    channel: CH.sessions.planAccept,
    domain: "internal",
    inputSchema: planAcceptInputSchema,
    outputSchema: planAcceptResultSchema,
    handle: async (input, ctx): Promise<Result<PlanAcceptResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        // Fail closed: read the run state BEFORE persisting acceptance, so we
        // never accept a plan we cannot then resume/track.
        const runState = await getActiveRunForSession(
          input.sessionId,
          ctx.requestId,
        );
        if (!runState.ok) return runState;

        const { acceptSessionPlan } = await import("@vex-agent/engine/plan/authority.js");
        const outcome = await acceptSessionPlan(input.sessionId, input.expectedPlanMd);
        if (outcome.outcome === "not_found") return ok({ outcome: "not_found" });
        if (outcome.outcome === "no_plan") return ok({ outcome: "no_plan" });
        if (outcome.outcome === "stale") return ok({ outcome: "stale" });

        // Resume a plan-acceptance-paused run. The plan is now accepted, so the
        // generic dispatcher allows it (no special flag). If the resume does NOT
        // launch (resumed:false), the run stays paused but is recoverable: the
        // accepted plan makes it resumable via the Resume affordance.
        let resumed = false;
        if (
          runState.data.hasActiveRun
          && runState.data.status === "paused_plan_acceptance"
        ) {
          const resume = await runResumeDispatch(
            { sessionId: input.sessionId },
            { requestId: ctx.requestId, channelLabel: "vex:sessions:planAccept" },
          );
          resumed = resume.ok && resume.data.outcome === "resumed";
        }
        log.info(
          `[ipc:vex:sessions:planAccept] accepted resumed=${resumed} ` +
            `correlationId=${ctx.requestId}`,
        );
        return ok({ outcome: "accepted", state: toPlanState(outcome.plan), resumed });
      } catch (cause) {
        log.warn(`[ipc:vex:sessions:planAccept] failed correlationId=${ctx.requestId}`, cause);
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}

export function registerSessionPlanHandlers(): Array<() => void> {
  return [
    registerPlanGetHandler(),
    registerPlanSetEnabledHandler(),
    registerPlanAcceptHandler(),
  ];
}
