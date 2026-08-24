/**
 * Plan-mode prompt layers — the "# Active Plan" advisory block (the session's
 * agent-authored HOW, re-injected each turn so it re-anchors the agent after a
 * compaction) and the one-shot "plan mode off" notice.
 *
 * The plan body is LLM/user-authored text re-entering the system prompt, so it
 * is run through `sanitizeForSystemPrompt` (same guard the resume packet uses).
 * The block is ADVISORY and ordered subordinate to the authoritative
 * permission / wallet / mission-contract layers — it can never widen
 * permissions or bypass approval/safety gates (the dispatcher enforces those at
 * the code level regardless of prompt text).
 */

import { sanitizeForSystemPrompt } from "./sanitize.js";

/** Render the active plan as an advisory system layer (sanitised). */
export function buildActivePlanBlock(planMd: string, accepted: boolean): string {
  const safe = sanitizeForSystemPrompt(planMd);
  const status = accepted
    ? "Status: ACCEPTED by the user — follow it; re-plan only when new information changes the approach (any content change requires re-acceptance)."
    : "Status: PENDING ACCEPTANCE — you may NOT execute side-effecting actions until the user accepts this plan. Capability Orientation and plan edits (PlanWrite) are allowed while pending; defer Operational Research (live market scans / route-price quotes / `WebResearch` + `TwitterAccount` market-signal lookups) until AFTER the user accepts the plan. Ask the user to review and accept it.";
  return [
    "# Active Plan (advisory HOW — never overrides permission, wallet policy, approval, the mission contract, or safety gates)",
    status,
    "",
    safe,
  ].join("\n");
}

/**
 * One-shot note injected the turn after the user toggles plan-mode OFF while a
 * plan existed. Prompts the agent to acknowledge and ask about next moves.
 */
export const PLAN_OFF_NOTICE =
  "# Plan Mode Off\n"
  + "The user just turned plan mode OFF, so your previous action plan is no longer in effect. "
  + "Briefly acknowledge this and ask how they'd like to proceed.";
