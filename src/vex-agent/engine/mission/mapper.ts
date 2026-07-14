/**
 * Mission mapper — domain ↔ DB row conversion + freeze + prompt context.
 *
 * MissionDraft (camelCase, typed) ↔ MissionDraftRow (snake_case, JSONB).
 * Parser produces Partial<MissionDraft>, mapper converts to Partial<MissionDraftRow>.
 */

import { hyperliquidMissionRiskSchema } from "../../../lib/hyperliquid-policy.js";
import type { MissionDraft } from "../types.js";
import type { Mission, MissionDraftRow } from "@vex-agent/db/repos/missions.js";

// ── Domain ↔ Row conversion ────────────────────────────────────

/** Convert a DB Mission row to domain MissionDraft. */
export function missionToDraft(m: Mission): MissionDraft {
  const src = m.capitalSourceJson as Record<string, unknown>;
  const constraints = m.constraintsJson as Record<string, unknown>;
  const risk = hyperliquidMissionRiskSchema.safeParse(constraints?.hyperliquidRisk);
  return {
    title: m.title,
    goal: m.goal,
    capitalSource: (src?.type as string) ?? null,
    startingCapital: (src?.amount as string) ?? (src?.startingCapital as string) ?? null,
    allowedWallets: m.allowedWallets.length > 0 ? m.allowedWallets : null,
    allowedChains: m.allowedChains.length > 0 ? m.allowedChains : null,
    allowedProtocols: m.allowedProtocols.length > 0 ? m.allowedProtocols : null,
    riskProfile: m.riskProfile,
    successCriteria: m.successCriteriaJson.length > 0 ? m.successCriteriaJson : null,
    stopConditions: m.stopConditionsJson.length > 0 ? m.stopConditionsJson : null,
    deadline: constraints?.deadline as string ?? null,
    hyperliquidRisk: risk.success ? risk.data : null,
  };
}

/** Convert a partial domain draft to DB row shape for updateDraft(). */
export function domainToRow(draft: Partial<MissionDraft>): MissionDraftRow {
  const row: MissionDraftRow = {};

  if (draft.title !== undefined) row.title = draft.title;
  if (draft.goal !== undefined) row.goal = draft.goal;
  if (draft.riskProfile !== undefined) row.risk_profile = draft.riskProfile;
  if (draft.allowedWallets !== undefined) row.allowed_wallets = draft.allowedWallets ?? [];
  if (draft.allowedChains !== undefined) row.allowed_chains = draft.allowedChains ?? [];
  if (draft.allowedProtocols !== undefined) row.allowed_protocols = draft.allowedProtocols ?? [];
  if (draft.successCriteria !== undefined) row.success_criteria_json = draft.successCriteria ?? [];
  if (draft.stopConditions !== undefined) row.stop_conditions_json = draft.stopConditions ?? [];

  // capitalSource + startingCapital → capital_source_json
  if (draft.capitalSource !== undefined || draft.startingCapital !== undefined) {
    row.capital_source_json = {
      ...(draft.capitalSource !== undefined ? { type: draft.capitalSource } : {}),
      ...(draft.startingCapital !== undefined ? { amount: draft.startingCapital } : {}),
    };
  }

  // setup metadata → constraints_json. Puzzle 04 dropped
  // `stopConditionsAccepted` — acceptance lives on
  // `missions.accepted_contract_hash` (mig 023) and is written by the
  // host-only acceptance path, never by the model/draft update flow.
  if (draft.deadline !== undefined || draft.hyperliquidRisk !== undefined) {
    row.constraints_json = {
      ...(draft.deadline !== undefined ? { deadline: draft.deadline } : {}),
      ...(draft.hyperliquidRisk !== undefined ? { hyperliquidRisk: draft.hyperliquidRisk } : {}),
    };
  }

  return row;
}

// ── Freeze ──────────────────────────────────────────────────────

/** Frozen mission snapshot — immutable after start. */
export interface FrozenMission {
  id: string;
  title: string;
  goal: string;
  draft: MissionDraft;
  approvedAt: string;
  /**
   * Raw constraints bag, frozen verbatim. `missionToDraft` only projects
   * `deadline`, so policy flags that live in constraints (Phase 4d
   * `autoRetryEnabled`, spend/loss caps) would otherwise be lost at freeze.
   * The engine reads the auto-retry opt-in from here at error time — an
   * immutable source that never drifts with a later draft edit.
   */
  constraintsJson: Record<string, unknown>;
}

/** Freeze a Mission row into an immutable snapshot for mission run. */
export function freezeDraft(m: Mission): FrozenMission {
  return {
    id: m.id,
    title: m.title ?? "Untitled Mission",
    goal: m.goal ?? "",
    draft: missionToDraft(m),
    approvedAt: m.approvedAt ?? new Date().toISOString(),
    constraintsJson: (m.constraintsJson as Record<string, unknown>) ?? {},
  };
}

// ── Prompt context ──────────────────────────────────────────────

/** Generate a human-readable summary for prompt injection. */
export function draftToPromptContext(m: Mission): string {
  const draft = missionToDraft(m);
  const lines: string[] = [];

  lines.push(`# Mission: ${draft.title ?? "(untitled)"}`);
  lines.push("");
  if (draft.goal) lines.push(`**Goal:** ${draft.goal}`);
  if (draft.capitalSource) lines.push(`**Capital:** ${draft.startingCapital ?? "?"} from ${draft.capitalSource}`);
  if (draft.riskProfile) lines.push(`**Risk:** ${draft.riskProfile}`);
  if (draft.allowedChains?.length) lines.push(`**Chains:** ${draft.allowedChains.join(", ")}`);
  if (draft.allowedProtocols?.length) lines.push(`**Protocols:** ${draft.allowedProtocols.join(", ")}`);
  if (draft.allowedWallets?.length) lines.push(`**Wallets:** ${draft.allowedWallets.join(", ")}`);
  if (draft.successCriteria?.length) {
    lines.push(`**Success criteria:**`);
    for (const c of draft.successCriteria) lines.push(`- ${c}`);
  }
  if (draft.stopConditions?.length) {
    lines.push(`**Stop conditions:**`);
    for (const s of draft.stopConditions) lines.push(`- ${s}`);
  }
  if (draft.deadline) lines.push(`**Deadline:** ${draft.deadline}`);
  if (draft.hyperliquidRisk) {
    lines.push(`**Hyperliquid risk:** ${draft.hyperliquidRisk.leverageCap}x leverage cap, ${draft.hyperliquidRisk.perOrderNotionalPct}% per order, ${draft.hyperliquidRisk.totalNotionalPct}% total`);
  }

  return lines.join("\n");
}
