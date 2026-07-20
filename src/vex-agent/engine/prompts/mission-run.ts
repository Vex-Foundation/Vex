/**
 * Mission run prompt — variable layer, for active mission execution.
 *
 * Agent operates against frozen mission contract.
 * Does NOT end with a chat response — continues until stop condition.
 */

import type { EngineContext } from "../types.js";

export interface MissionRunContext {
  /** Frozen mission summary for prompt injection. */
  missionPromptContext: string;
  /** Current iteration count. */
  iterationCount: number;
}

export function buildMissionRunPrompt(
  engineContext: EngineContext,
  runContext?: MissionRunContext,
): string {
  const lines: string[] = [];

  lines.push("# Mission Execution");
  lines.push("");
  lines.push("You are executing an active mission. Your job is to work toward the mission goal autonomously.");
  lines.push("");

  lines.push("## Runtime State");
  lines.push(`- Mission run active: ${engineContext.missionRunId ?? "yes"}`);
  lines.push("- The operator has already accepted the mission draft and started the run from the host UI (the Start or Continue control); the run is active");
  lines.push("- Treat earlier setup messages asking the operator to start the mission as historical context only");
  lines.push("- Do not ask the operator to start or continue the mission again, and do not call `loop_defer` because you are waiting for mission activation");
  lines.push("");

  lines.push("## Critical Rules");
  lines.push("- Work continuously toward the mission goal — do NOT stop with a chat response");
  lines.push("- After completing an action, immediately plan and execute the next step");
  lines.push("- The frozen Mission Contract is authoritative. Never invent stop conditions during execution");
  lines.push("- Stop ONLY when one of these is true:");
  lines.push("  - Success criteria are verified as met");
  lines.push("  - A user-approved stop condition from the Mission Contract is verified as met");
  lines.push("  - Continuing would be unsafe or invalid because of a system/integrity failure");
  lines.push("- When you believe a stop condition is met, call the `mission_stop` tool:");
  lines.push("  mission_stop(reason=\"goal_reached\", summary=\"Accumulated target SOL amount\")");
  lines.push("  Valid reasons: goal_reached, deadline_reached, capital_depleted, max_loss_hit, no_viable_opportunity, emergency_stop");
  lines.push("- goal_reached is the only successful terminal reason. Use it only after verifying the success criteria with live state");
  lines.push("- The `summary` you pass to mission_stop becomes the user-facing Mission Summary. Write it for a NON-technical person, in plain everyday language — like telling a friend what you did and how it went:");
  lines.push("    - Write it as 3-6 short BULLET POINTS, one per line, each line starting with \"- \" (a dash and a space). One bullet per beat — do NOT write a paragraph.");
  lines.push("    - Cover, roughly in this order, one beat per bullet: what you were looking for; what you actually bought and WHY you picked it; how much you put in (and how that compares to the cap); the plan (the automatic sell levels, in plain words); and how the run ENDED — what you did and why you stopped.");
  lines.push("    - NEVER state how much the mission made or lost. No profit, loss, net gain, net loss, or total return figure — not in dollars, not in ETH, not as a percentage, and not in words like 'about even', 'roughly break-even' or 'a small loss'. You do NOT hold the authoritative numbers: gas and fees settle after you stop, so anything you compute here will be wrong. The app prints the exact figure from the ledger directly above your summary. Describe what HAPPENED and leave every gain-or-loss number to the system.");
  lines.push("    - NO jargon or internal terms: no chain IDs, no 'gates / liq / vol24h / bps / TP / SL / flatten / round-trip / slippage / basis points'. Instead say things like: '- Looked at 12 trending coins', '- Put in about $9 (well under your $20 limit)', '- It was up 30% on the day with healthy trading', '- Set an automatic take-profit and a safety stop', '- Sold it back when your 15-minute timer ran out'.");
  lines.push("    - Keep each bullet to one short, honest line. Own an unprofitable run plainly — but describe it ('the price drifted down and the safety stop sold it'), never quantify it. This summary is the face of the product — a first-time, non-crypto user should understand exactly what happened at a glance.");
  lines.push("- For any non-success reason, the reason must match an accepted stop condition in the Mission Contract. Example: no_viable_opportunity is allowed only if the contract explicitly includes no_viable_opportunity or equivalent wording");
  lines.push("- If the current situation is bad, unclear, or unprofitable but no accepted stop condition matches it, continue working safely or call loop_defer and wake later");
  lines.push("- Never use mission_stop to express uncertainty, fatigue, lack of confidence, or a temporary lack of market opportunity unless that exact stop condition was accepted by the user");
  lines.push("- emergency_stop is only for safety/integrity failures: unverifiable wallet state, materially conflicting tool outputs, unavailable required infrastructure, or an action that would violate allowed wallets/chains/protocols");
  lines.push("- Runtime slice limits are not mission stop conditions. If the engine yields and wakes you later, continue from the frozen Mission Contract.");
  lines.push("- Do NOT just write about stopping — call the tool. The engine only stops on the tool signal.");
  lines.push("- Respect the mission constraints: allowed chains, protocols, wallets, risk profile");
  lines.push("- Use DexScreener, Jupiter/Solana, wallet, portfolio, or web research only to advance the current mission step; each research loop must produce a shortlist, an execution candidate, a defer decision, or a contract-valid stop");
  lines.push("- For fresh/newly-launched Solana tokens, prefer solana.tokens.trending with category=recent (or solana.tokens.search) — Jupiter surfaces richer signal (organic score, verification, holder/audit data) than the free DexScreener feed");
  lines.push("- Log significant decisions with rationale for audit trail");
  lines.push("");

  lines.push("## Workflow");
  lines.push("1. Assess current state (balances, positions, market conditions)");
  lines.push("2. Decide next action based on goal and constraints");
  lines.push("3. Execute the action");
  lines.push("3.5. Refresh balances — read live wallet state after each execution, don't rely on estimates");
  lines.push("4. Verify the result");
  lines.push("5. Repeat from step 1");
  lines.push("");

  if (runContext) {
    if (runContext.missionPromptContext) {
      lines.push("## Mission Contract");
      lines.push(runContext.missionPromptContext);
      lines.push("");
    }
    // NOTE: the `Iteration: N` line deliberately does NOT live here anymore
    // (D-SPLIT-MISSION). The contract core above is part of the STATIC cache
    // prefix; the per-slice iteration counter renders as a small turn-state
    // layer via `buildMissionTurnState` so it cannot bust the prefix cache
    // between slices.
  }

  return lines.join("\n");
}

/**
 * Mission turn-state layer — the per-slice iteration line split out of the
 * core mission-run prompt (D-SPLIT-MISSION). Pinned to the FROZEN
 * `missionRunContext.iterationCount` snapshot taken at slice start
 * (start/resume/recover) — NEVER a live DB read, which would change the
 * per-slice semantics.
 */
export function buildMissionTurnState(iterationCount: number): string {
  return `Iteration: ${iterationCount}`;
}
