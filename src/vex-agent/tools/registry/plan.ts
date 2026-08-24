/**
 * Plan-mode tool — a single idempotent `PlanWrite` (per Anthropic "fewer,
 * better tools"; no read tool because the active plan is auto-injected into the
 * prompt every turn, so a read would only re-surface in-context content).
 *
 * Visible whenever session-scoped plan-mode is ON (`requiresPlanMode`) — i.e.
 * agent sessions, mission setup (so the plan is co-authored alongside the
 * contract and accepted together), and active mission runs.
 *
 * `mutating: false` (co-authoring the plan must not deadlock on per-call
 * approval — mirrors `MissionDraftUpdate`). The real safety
 * gate is the dispatcher's execution gate: while plan-mode is on and the plan
 * is unaccepted, side-effecting tools are blocked until the user accepts.
 */

import type { ToolDef } from "../types.js";

export const PLAN_TOOLS: readonly ToolDef[] = [
  {
    name: "PlanWrite", kind: "internal", mutating: false, pressureSafety: "safe_at_barrier", actionKind: "local_write",
    visibility: { requiresPlanMode: true, hiddenInMissionSetup: false },
    description:
      "Create or replace your current action plan (idempotent — overwrites the prior plan). "
      + "Plan authoring is Capability Orientation, not market operation: orient on capabilities FIRST (WHICH tools/venues you will use), "
      + "then write the FULL plan. Do NOT run live market scans or route-price quotes now — defer that Operational Research until AFTER the user accepts the plan. "
      + "Write the plan in markdown using these sections: "
      + "1) Objective & boundaries, 2) Effort tier (simple|comparison|complex + tool-call budget), "
      + "3) Research findings, 4) Approach & tool selection (list the exact protocol toolIds you will reuse, the research/social tools you will use when relevant — e.g. `WebResearch`, `TwitterAccount` — and which tools you will NOT use), "
      + "5) Cadence/aggressiveness, 6) Sub-tasks (one at a time, checkboxes), "
      + "7) Stop conditions, 8) Success criteria & self-verify, 9) Re-plan log. "
      + "Rewrite the plan whenever research or new market/on-chain info changes the approach (any content change requires re-acceptance). "
      + "The user must ACCEPT the plan before you may execute side-effecting actions - after writing, ask the user to review and accept it. "
      + "It returns one confirmation sentence rather than a result object: the plan was saved and acceptance is pending, or the content was identical and nothing changed. "
      + "The plan is stored for this session and shown to the user in the plan view, capped at 4,000 characters and 120 lines; anything past that is cut WITHOUT a warning, so keep the plan inside that bound rather than relying on the tool to tell you.",
    parameters: { type: "object", properties: {
      plan_md: { type: "string", description: "The full action plan as markdown, following the 9-section template. Length-capped on save." },
    }, required: ["plan_md"], additionalProperties: false },
  },
];
