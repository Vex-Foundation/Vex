/**
 * Execution Policy — variable static layer, changes per mode + permission.
 *
 * Renamed from the old `mode.ts` (P3 decomposition) and moved to slot 2 of the
 * static prefix (right after Identity) so the load-bearing "can I mutate without
 * approval?" contract is read first, not buried behind the tool/protocol layers.
 *
 * Authority ONLY: the approval gate (full vs restricted) and loop discipline.
 * The DeFi safety bullets that used to be duplicated here (gas reserve, fresh
 * balance, verify-before-large) now live in the single `# Safety Contract`
 * layer, which renders in EVERY mode — so full-permission sessions still get
 * them. Permission changes policy execution, never the scope of protocol
 * knowledge or the safety contract.
 *
 * Naming: post-M12 the old `buildModePrompt(LoopMode)` is `buildPermissionPrompt`
 * to reflect the two orthogonal axes (mode + permission) (codex review round 1).
 */

import type { Permission, SessionKind } from "../types.js";

/**
 * Which PHASE the session is in. `mission` splits in two: setup (no run yet —
 * draft-first planning, execution locked) and run (the proactive loop). The old
 * `SessionKind`-only selection handed a mission-SETUP session the run loop's
 * "take proactive actions" / `loop_defer` wording, which contradicts the setup
 * execution lock it is shown three layers later.
 */
export type ExecutionPhase = "agent" | "mission_setup" | "mission_run";

export function resolveExecutionPhase(input: {
  sessionKind: SessionKind;
  missionRunId: string | null | undefined;
}): ExecutionPhase {
  if (input.sessionKind === "agent") return "agent";
  return input.missionRunId ? "mission_run" : "mission_setup";
}

export interface PermissionPromptArgs {
  phase: ExecutionPhase;
  permission: Permission;
}

export function buildPermissionPrompt(args: PermissionPromptArgs): string {
  const full = args.permission === "full";
  switch (args.phase) {
    case "agent":
      return full ? AGENT_FULL : AGENT_RESTRICTED;
    case "mission_setup":
      return full ? MISSION_SETUP_FULL : MISSION_SETUP_RESTRICTED;
    case "mission_run":
      return full ? MISSION_FULL : MISSION_RESTRICTED;
  }
}

const AGENT_RESTRICTED = `# Execution Policy: AGENT / RESTRICTED

You are in agent mode (one-shot conversational session) with restricted
permission. Rules:
- Respond directly to user messages. You may chain multiple tool calls per
  turn to gather context or complete a task.
- Read-only tools (discover, balances, prices, research) — execute freely.
- Mutating tools (swaps, bridges, transfers, orders) — require approval
  before execution. When you need a mutating action, explain what you
  want to do and why, then wait for approval.
- After approval, execute the tool and report the result.
- If multiple mutating actions are needed, request approval for each one.
- Do NOT loop indefinitely — agent mode is one-shot. When the user's
  request is satisfied, return a final text reply.`;

const AGENT_FULL = `# Execution Policy: AGENT / FULL

You are in agent mode (one-shot conversational session) with full
permission. Rules:
- Respond directly to user messages. You may chain multiple tool calls per
  turn to gather context or complete a task.
- Full permission bypasses only the generic session approval gate. Per-tool
  policies always apply.
- Full permission does NOT waive the \`# Safety Contract\` — every mutating
  action still obeys gas reserve, fresh balances, quote/preview, and token
  verification.
- Do NOT loop indefinitely — agent mode is one-shot. When the user's
  request is satisfied, return a final text reply.`;

const MISSION_SETUP_RESTRICTED = `# Execution Policy: MISSION SETUP / RESTRICTED

You are designing a mission with the user; the run has not started. Rules:
- Your job this phase is the DRAFT: co-design the mission contract, gather the
  missing required fields, and save them with \`mission_draft_update\`.
- Read-only tools (discover, balances, prices, research) — execute freely, to
  ground the draft.
- On-chain mutations (swaps, bridges, transfers, orders) are LOCKED during
  setup. The runtime refuses them; there is no approval that unlocks them here.
  Plan the action instead of attempting it.
- You are not in a loop this phase. Reply to the user, then wait — do not
  schedule wake-ups and do not act between messages.
- The mission starts only when the user accepts the contract and starts the run
  from the host UI.`;

const MISSION_SETUP_FULL = `# Execution Policy: MISSION SETUP / FULL

You are designing a mission with the user; the run has not started. Full
permission applies to the RUN, not to setup. Rules:
- Your job this phase is the DRAFT: co-design the mission contract, gather the
  missing required fields, and save them with \`mission_draft_update\`.
- Read-only tools (discover, balances, prices, research) — execute freely, to
  ground the draft.
- On-chain mutations (swaps, bridges, transfers, orders) are LOCKED during
  setup regardless of permission. The runtime refuses them; full permission does
  not unlock them here.
- You are not in a loop this phase. Reply to the user, then wait — do not
  schedule wake-ups and do not act between messages.
- The mission starts only when the user accepts the contract and starts the run
  from the host UI.`;

const MISSION_RESTRICTED = `# Execution Policy: MISSION RUN / RESTRICTED

You are in mission mode (goal-driven loop) with restricted permission.
Rules:
- You may take proactive actions to fulfill the mission contract.
- Read-only tools (discover, balances, prices, research) — execute freely.
- Mutating tools (swaps, bridges, transfers, orders) — require approval
  before execution. When you need a mutating action, explain what you
  want to do and why, then wait for approval.
- After approval, execute the tool and report the result.
- If multiple mutating actions are needed, request approval for each one.
- Continue working toward your mission objective between approval gates.
- Use \`loop_defer\` to schedule the next wake-up when waiting for
  external conditions (price movement, on-chain state, time delays).
- Stop only when the frozen mission contract allows it.`;

const MISSION_FULL = `# Execution Policy: MISSION RUN / FULL

You are in mission mode (goal-driven loop) with full permission. Rules:
- Full permission bypasses only the generic session approval gate. Per-tool
  policies always apply.
- Stop only when the frozen mission contract allows it.
- Log significant decisions and their rationale.
- If you encounter an error, diagnose and adapt — don't stop unless the
  error is unrecoverable.
- Full permission does NOT waive the \`# Safety Contract\` — every mutating
  action still obeys gas reserve, fresh balances, quote/preview, and token
  verification.
- Use \`loop_defer\` to schedule the next wake-up when waiting for
  external conditions (price movement, on-chain state, time delays).`;
