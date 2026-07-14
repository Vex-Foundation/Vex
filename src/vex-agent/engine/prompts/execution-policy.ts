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

export interface PermissionPromptArgs {
  mode: SessionKind;
  permission: Permission;
}

export function buildPermissionPrompt(args: PermissionPromptArgs): string {
  if (args.mode === "agent") {
    return args.permission === "full" ? AGENT_FULL : AGENT_RESTRICTED;
  }
  return args.permission === "full" ? MISSION_FULL : MISSION_RESTRICTED;
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
  policies always apply; Hyperliquid mutations fail closed without an active
  policy, and foreign egress always requires approval.
- Full permission does NOT waive the \`# Safety Contract\` — every mutating
  action still obeys gas reserve, fresh balances, quote/preview, and token
  verification.
- Do NOT loop indefinitely — agent mode is one-shot. When the user's
  request is satisfied, return a final text reply.`;

const MISSION_RESTRICTED = `# Execution Policy: MISSION / RESTRICTED

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

const MISSION_FULL = `# Execution Policy: MISSION / FULL

You are in mission mode (goal-driven loop) with full permission. Rules:
- Full permission bypasses only the generic session approval gate. Per-tool
  policies always apply; Hyperliquid mutations fail closed without an active
  policy, and foreign egress always requires approval.
- Stop only when the frozen mission contract allows it.
- Log significant decisions and their rationale.
- If you encounter an error, diagnose and adapt — don't stop unless the
  error is unrecoverable.
- Full permission does NOT waive the \`# Safety Contract\` — every mutating
  action still obeys gas reserve, fresh balances, quote/preview, and token
  verification.
- Use \`loop_defer\` to schedule the next wake-up when waiting for
  external conditions (price movement, on-chain state, time delays).`;
