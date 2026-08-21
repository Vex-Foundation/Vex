/**
 * `PlanWrite` handler — idempotent upsert of the session's action plan.
 *
 * Defense-in-depth: re-checks plan-mode is enabled in the DB (the registry
 * `requiresPlanMode` gate is model-facing only). Length-caps the markdown on
 * write. In an ACTIVE mission run, a write that creates/changes an unaccepted
 * plan emits a `plan_pause` EngineSignal so the turn-loop parks the run in
 * `paused_plan_acceptance` (mission text does not break the loop, so we cannot
 * wait for the next execution attempt). In agent mode (one-shot) there is no run
 * to pause — the dispatcher execution gate enforces acceptance and the agent
 * replies asking the user to accept.
 */

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { fail } from "../types.js";
import { getActivePlan, upsertPlan } from "@vex-agent/db/repos/session-plans.js";

const PLAN_MD_MAX_CHARS = 4_000;
const PLAN_MD_MAX_LINES = 120;

/** Bound the stored plan so it cannot grow unbounded in the prompt (persona cap parity). */
function capPlanMarkdown(raw: string): string {
  let md = raw.trim();
  const lines = md.split("\n");
  if (lines.length > PLAN_MD_MAX_LINES) {
    md = lines.slice(0, PLAN_MD_MAX_LINES).join("\n");
  }
  if (md.length > PLAN_MD_MAX_CHARS) {
    md = md.slice(0, PLAN_MD_MAX_CHARS);
  }
  return md;
}

export async function handlePlanWrite(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  // Defense-in-depth: plan-mode must be enabled for this session.
  const existing = await getActivePlan(context.sessionId);
  if (!existing?.enabled) {
    return fail("Plan mode is not enabled for this session; PlanWrite is unavailable.");
  }

  const planMd = capPlanMarkdown(typeof args.plan_md === "string" ? args.plan_md : "");
  if (!planMd) {
    return fail("plan_md is required and must be non-empty markdown following the plan template.");
  }

  const contentChanged = existing.planMd !== planMd;
  const updated = await upsertPlan(context.sessionId, planMd);
  // Null = plan-mode was disabled between the read above and this write (race):
  // the atomic enabled-guard skipped the update. Fail WITHOUT emitting a pause
  // signal, so the run is never parked with a disabled, unaccepted plan.
  if (!updated) {
    return fail("Plan mode was turned off before the plan could be saved — re-enable plan mode and write the plan again.");
  }
  // `upsertPlan` resets accepted_at to NULL on a content change; a no-op write
  // preserves it. So `updated.accepted` is the authoritative post-write state.
  const acceptancePending = !updated.accepted;

  // Active mission run + acceptance pending → pause for acceptance now.
  if (context.missionRunId && acceptancePending) {
    return {
      success: true,
      output:
        "Action plan saved. The mission run is paused until you review and accept the plan; "
        + "execution resumes once the user accepts it.",
      data: { planSaved: true, acceptancePending: true, contentChanged },
      engineSignal: {
        type: "plan_pause",
        reason: "plan_acceptance_required",
        summary: "Action plan written/changed and awaiting user acceptance before execution.",
      },
    };
  }

  return {
    success: true,
    output: acceptancePending
      ? "Action plan saved. Ask the user to review and accept it before you execute any side-effecting actions."
      : "Action plan unchanged (same content); existing acceptance preserved.",
    data: { planSaved: true, acceptancePending, contentChanged },
  };
}
