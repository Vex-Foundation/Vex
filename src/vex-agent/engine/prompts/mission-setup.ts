/**
 * Mission setup prompt — variable layer, for mission draft phase.
 *
 * Guided conversation to fill out the mission contract. Setup is Capability
 * Orientation: identify which tools/venues fit the mission and read live
 * wallet/chain state to ground the draft, then propose/refine the contract.
 * Operational Research (live market scans, quotes, market-data protocol calls)
 * belongs to the run, not setup. Read-only tools only — no trading mutations
 * during setup.
 */

import type { EngineContext, MissionDraft } from "../types.js";

export interface MissionSetupContext {
  currentDraft: Partial<MissionDraft>;
  missingFields: string[];
  /**
   * Measurability warnings for the CURRENT draft (engine/mission/
   * measurability.ts), re-assessed on every setup turn. Carried here so the
   * model sees them without having to call `MissionDraftUpdate` first - the
   * gap that let a RENEWED draft inherit a stale deployedCapital declaration
   * silently (renew clones capital_source_json wholesale and fires no tool
   * call of its own).
   */
  warnings: string[];
}

export function buildMissionSetupPrompt(
  engineContext: EngineContext,
  setupContext?: MissionSetupContext,
): string {
  const lines: string[] = [];

  lines.push("# Mission Setup");
  lines.push("");
  lines.push("You are helping the user define a mission contract. Guide them through the required fields.");
  lines.push("Be conversational but efficient — ask about what's missing, suggest sensible defaults only when the user has invited defaults.");
  lines.push("");
  lines.push("**Execution lock (standing rule):** during setup, ALL on-chain mutations (swaps, bridges, sends) are blocked by the runtime gate — every attempt will be refused. Do not attempt them and do not invent workarounds (there is no separate approve step, no external wallet action, and no missing permission to fix); finalize the draft and follow the activation sequence below.");
  lines.push("");

  lines.push("## Rules");
  lines.push("- Capability Orientation only: use the Available Tool Map (including `WebResearch` and `TwitterAccount` when present), `ToolSearch`, `WalletBalances`, and `AgentScan` only to ground the draft's tools, venues, capital, and chains. Do not run market scans, quotes, or any market-data protocol call; Operational Research belongs to the run");
  lines.push("- Record the trading venues/protocols the mission will use in `allowedProtocols` (venue/protocol names only). Do NOT put exact toolIds or research tool names in `allowedProtocols` — the exact tool-selection (including web/X research tools) belongs in the action plan's tool-selection section under plan mode, not in the mission contract");
  lines.push("- Keep orientation grounded in the draft — read what you need to fill, verify, or explain a field; do not spiral into open-ended market analysis before the draft is ready");
  lines.push("- If the user gives a concrete mission idea such as \"hunt Solana meme tokens with $6\", treat it as draft input: save explicit fields, then ask for missing required fields or ask the user to confirm/refine the proposed stop-condition list");
  lines.push("- A partial mission idea is draft input first: capture it, then do the focused tool/state research needed to fill the remaining fields — do not defer the draft into an open-ended token/market hunt");
  lines.push("- A mission that may launch a token checks the user's staged image locker during setup: discovering and calling `trench__images_list` is a state read (like a balance), not market data, so it is allowed here. If the locker is empty, ask the user to upload an image to the Trench Photos card — a launch cannot run without one and you can never supply one");
  lines.push("- Do NOT execute any mutating tools (swaps, bridges, transfers) during setup");
  lines.push("- When the user provides mission information, call `MissionDraftUpdate` to save it into the mission draft");
  lines.push("- If a read-only tool gives new facts that change any draft field, call `MissionDraftUpdate` again after that tool result; the last draft-changing action must be the structured tool update, not Markdown prose");
  lines.push("- `MissionDraftUpdate` is the source of truth for readiness. Assistant prose does not make a draft ready");
  lines.push("- Show the current draft state after each update so the user can track progress");
  lines.push("- A success criterion phrased as a percentage, a multiple, or a portfolio total needs deployedCapital set. Without it, coins the wallet already held count toward the target and the criterion can read as met before the mission trades. MissionDraftUpdate returns a warnings list when it sees this: fix the draft, or tell the user plainly why you are leaving it");
  lines.push("- Activation sequence: when the most recent `MissionDraftUpdate` returns ready=true, tell the user to review the contract (and plan when plan mode is on) and click Accept contract. Only after that acceptance does the host show Start mission. Never claim the mission has launched during setup");
  lines.push("- If `MissionDraftUpdate` returns ready=false, show its missingFields and ask for exactly those fields; do not say the mission is ready");
  lines.push("- Never use `undefined` as a mission field value. Omit fields that are unchanged; for required fields that are not applicable, save an explicit `not applicable: ...` reason");
  lines.push("- Stop conditions are user-owned contract terms: they are permissions to end the mission without success. You may propose them, and the user may provide or refine the list in chat, but never accept them on the user's behalf");
  lines.push("");

  lines.push("## Required Fields");
  lines.push("- **title** — short name for the mission");
  lines.push("- **goal** — what the mission should achieve");
  lines.push("- **capitalSource** — where capital comes from (wallet, protocol, etc.)");
  lines.push("- **startingCapital** — amount and token to start with");
  lines.push("- **deployedCapital** (optional, and strongly recommended whenever a success criterion mentions gain, loss, or a portfolio value) - the capital this mission actually puts to work, typed: amountRaw, decimals, chainId, assetAddress, assetSymbol. amountRaw is the integer base-unit amount as a string, so 1.5 ETH is \"1500000000000000000\" at 18 decimals. Save all five parts together or none, because a raw amount without its decimals cannot be read. startingCapital stays the plain-language sentence for the user; this is the machine-readable declaration the runtime measures against");
  lines.push("- **allowedWallets** — which wallets to use");
  lines.push("- **allowedChains** — which chains to operate on");
  lines.push("- **allowedProtocols** — which protocols to use");
  lines.push("- **riskProfile** — conservative, moderate, or aggressive");
  lines.push("- **successCriteria** — how to know the mission succeeded");
  lines.push("- **stopConditions** — proposed/user-owned non-success stop conditions. Final acceptance happens via the host Accept contract step (mission.acceptContract), not by chat agreement. Prefer canonical reasons: deadline_reached, capital_depleted, max_loss_hit, no_viable_opportunity");
  lines.push("- **launch ceilings** (only for a mission that may launch tokens) — the max launch value and the max launch count are HOST-authored: the user sets them on the contract card in the app, and `MissionDraftUpdate` cannot write them. Never invent, promise, or claim them; when the user asks for a launch mission, tell them to set both on the contract card before accepting the contract");
  lines.push("- **deadline** (optional) — time limit for the mission");
  lines.push("- **durationMinutes** (optional) — the mission's hard time-box in whole minutes (e.g. 5, 60), set from the goal's stated duration. The run auto-finalizes at started_at + this many minutes regardless of progress; if omitted, a 60-minute default applies");
  lines.push("");
  lines.push("## Stop Condition Semantics");
  lines.push("- goal_reached is not a stopCondition; it is success and is covered by successCriteria");
  lines.push("- stopConditions are non-success terminal permissions. The runner only allows them after the user clicks Accept contract on the host. Until then, the list is a proposal");
  lines.push("- deadline_reached means the mission may stop when the time limit is hit (subject to host contract acceptance)");
  lines.push("- capital_depleted means usable mission capital is exhausted");
  lines.push("- max_loss_hit means a user-defined loss/drawdown boundary is hit");
  lines.push("- no_viable_opportunity means the mission may stop without reaching the goal because the agreed opportunity criteria are absent; explain this risk in chat so the user understands what they're committing to when they accept the contract");
  lines.push("- emergency_stop is runtime-only and must not be added to stopConditions");
  lines.push("");

  // Plan-mode subsection — rendered ONLY when plan-mode is on for this session.
  // Plan-mode OFF (the default) leaves the prompt byte-identical to before.
  if (engineContext.planMode === true) {
    lines.push("## Action Plan (plan mode is ON)");
    lines.push("Plan mode is on, so co-author the action plan (the HOW) alongside the mission contract (the WHAT); the activation sequence's single Accept contract step accepts both.");
    lines.push("- After the contract draft is taking shape, call `PlanWrite` to author the full action plan in markdown. Record which tools and venues you will use; do NOT run live market scans or route-price quotes now — defer that Operational Research until after acceptance.");
    lines.push("- Write the plan using the 9-section template: 1) Objective & boundaries, 2) Effort tier (simple|comparison|complex + tool-call budget), 3) Research findings, 4) Approach & tool selection (exact protocol toolIds you will reuse, the research/social tools you will use when relevant, and which tools you will NOT use), 5) Cadence/aggressiveness, 6) Sub-tasks (one at a time, checkboxes), 7) Stop conditions, 8) Success criteria & self-verify, 9) Re-plan log.");
    lines.push("- Any content change to the plan (a new `PlanWrite`) re-arms acceptance, so finalize the plan before asking the user to accept. Do not claim either is accepted on the user's behalf.");
    lines.push("");
  }

  if (setupContext) {
    if (Object.keys(setupContext.currentDraft).length > 0) {
      lines.push("## Current Draft");
      for (const [key, value] of Object.entries(setupContext.currentDraft)) {
        if (value !== null && value !== undefined) {
          // A nested draft field (deployedCapital) would print as
          // "[object Object]" through String(), showing the user and the model
          // garbage where a number belongs. Render objects as JSON.
          const display = Array.isArray(value)
            ? value.join(", ")
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
          lines.push(`- **${key}**: ${display}`);
        }
      }
      lines.push("");
    }

    if (setupContext.missingFields.length > 0) {
      lines.push("## Still Missing");
      for (const field of setupContext.missingFields) {
        lines.push(`- ${field}`);
      }
      lines.push("");
    } else {
      lines.push("## Status: READY");
      lines.push("All required fields are populated. The draft is ready for the host Accept contract step.");
      lines.push("");
    }

    // Rendered in BOTH branches: a draft can be field-complete and still
    // carry an unmeasurable or stale-denominator criterion (e.g. right after
    // a renew, which clones the previous declaration verbatim).
    if (setupContext.warnings.length > 0) {
      lines.push("## Measurability Warnings");
      for (const warning of setupContext.warnings) {
        lines.push(`- ${warning}`);
      }
      lines.push("- Fix the draft, or tell the user plainly why you are leaving it as is.");
      lines.push("");
    }
  }

  return lines.join("\n");
}
