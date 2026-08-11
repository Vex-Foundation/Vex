/**
 * Mission mapper — domain ↔ DB row conversion + freeze + prompt context.
 *
 * MissionDraft (camelCase, typed) ↔ MissionDraftRow (snake_case, JSONB).
 * Parser produces Partial<MissionDraft>, mapper converts to Partial<MissionDraftRow>.
 */

import type { MissionDraft } from "../types.js";
import { normalizeDeployedCapital } from "./deployed-capital.js";
import { formatRawAmount } from "@vex-agent/tools/protocols/amount-display.js";
import type { Mission, MissionDraftRow } from "@vex-agent/db/repos/missions.js";

// ── Domain ↔ Row conversion ────────────────────────────────────

/** Convert a DB Mission row to domain MissionDraft. */
export function missionToDraft(m: Mission): MissionDraft {
  const src = m.capitalSourceJson as Record<string, unknown>;
  const constraints = m.constraintsJson as Record<string, unknown>;
  return {
    title: m.title,
    goal: m.goal,
    capitalSource: (src?.type as string) ?? null,
    startingCapital: (src?.amount as string) ?? (src?.startingCapital as string) ?? null,
    // C3 declaration - read through the ONE shared normalizer, the same one the
    // contract hash and the patch parser use. Hand-mirroring it here (as the C6
    // pair below had to be) is what would let a draft hash as one thing and
    // read back as another. A partial or malformed blob reads as absent.
    deployedCapital: normalizeDeployedCapital(src?.deployedCapital),
    allowedWallets: m.allowedWallets.length > 0 ? m.allowedWallets : null,
    allowedChains: m.allowedChains.length > 0 ? m.allowedChains : null,
    allowedProtocols: m.allowedProtocols.length > 0 ? m.allowedProtocols : null,
    riskProfile: m.riskProfile,
    successCriteria: m.successCriteriaJson.length > 0 ? m.successCriteriaJson : null,
    stopConditions: m.stopConditionsJson.length > 0 ? m.stopConditionsJson : null,
    deadline: constraints?.deadline as string ?? null,
    durationMinutes:
      typeof constraints?.durationMinutes === "number" ? constraints.durationMinutes : null,
    // C6 ceiling — read as a PAIR. A half-populated pair is unreadable (a raw
    // amount with no decimals cannot be compared to anything), so either both
    // are present and well-typed or the ceiling is absent and fails closed.
    maxLaunchValueRaw:
      typeof constraints?.maxLaunchValueRaw === "string" &&
      typeof constraints?.maxLaunchValueDecimals === "number"
        ? constraints.maxLaunchValueRaw
        : null,
    maxLaunchValueDecimals:
      typeof constraints?.maxLaunchValueRaw === "string" &&
      typeof constraints?.maxLaunchValueDecimals === "number"
        ? constraints.maxLaunchValueDecimals
        : null,
    // C6b count ceiling — independent of the value pair (a mission may have
    // authored one and not the other; an autonomous launch requires BOTH, and
    // `launch-ceiling.ts` is the place that refuses). Only a non-negative
    // integer reads as a cap; anything else is absent, never coerced.
    maxLaunchCount:
      typeof constraints?.maxLaunchCount === "number" &&
      Number.isInteger(constraints.maxLaunchCount) &&
      constraints.maxLaunchCount >= 0
        ? constraints.maxLaunchCount
        : null,
  };
}

/**
 * Raw (unvalidated) legacy `hyperliquidRisk` off a mission row's
 * `constraints_json` — read directly off the DB row rather than through
 * `MissionDraft`, which no longer carries this field (Hyperliquid was
 * removed from the live agent, Agent Scan Phase 3). The ONLY consumer is
 * `computeContractHash`'s frozen v2 legacy path
 * (`contract-hash-legacy-v2.ts`): a mission accepted while
 * `CONTRACT_HASH_VERSION` was 2 may still have a non-null value here, and
 * its hash can only be reproduced by re-normalizing this exact raw material.
 * Never wire this into any mission-WRITING path.
 */
export function extractLegacyHyperliquidRiskV2(m: Mission): unknown {
  const constraints = m.constraintsJson as Record<string, unknown> | null | undefined;
  return constraints?.hyperliquidRisk;
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
  if (
    draft.capitalSource !== undefined ||
    draft.startingCapital !== undefined ||
    draft.deployedCapital !== undefined
  ) {
    row.capital_source_json = {
      ...(draft.capitalSource !== undefined ? { type: draft.capitalSource } : {}),
      ...(draft.startingCapital !== undefined ? { amount: draft.startingCapital } : {}),
      // `setup.ts` read-merge-writes `capital_source_json` under the row lock,
      // so a deployed-capital-only patch keeps `type`/`amount`, and an explicit
      // `null` correctly clears the declaration.
      ...(draft.deployedCapital !== undefined ? { deployedCapital: draft.deployedCapital } : {}),
    };
  }

  // setup metadata → constraints_json. Puzzle 04 dropped
  // `stopConditionsAccepted` — acceptance lives on
  // `missions.accepted_contract_hash` (mig 023) and is written by the
  // host-only acceptance path, never by the model/draft update flow.
  if (
    draft.deadline !== undefined ||
    draft.durationMinutes !== undefined ||
    draft.maxLaunchValueRaw !== undefined ||
    draft.maxLaunchValueDecimals !== undefined ||
    draft.maxLaunchCount !== undefined
  ) {
    row.constraints_json = {
      ...(draft.deadline !== undefined ? { deadline: draft.deadline } : {}),
      ...(draft.durationMinutes !== undefined
        ? { durationMinutes: draft.durationMinutes }
        : {}),
      // C6 — written only by the host-side ceiling writer. `patch-parser.ts`
      // never yields these keys, so a model draft update cannot reach here.
      ...(draft.maxLaunchValueRaw !== undefined
        ? { maxLaunchValueRaw: draft.maxLaunchValueRaw }
        : {}),
      ...(draft.maxLaunchValueDecimals !== undefined
        ? { maxLaunchValueDecimals: draft.maxLaunchValueDecimals }
        : {}),
      ...(draft.maxLaunchCount !== undefined
        ? { maxLaunchCount: draft.maxLaunchCount }
        : {}),
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
  // C3 - the typed declaration the runtime measures against. The human figure
  // comes from `formatRawAmount`, the repo's single owner for raw-to-human
  // display; when it cannot read the pair we render the raw pair ONLY and never
  // guess a figure, because a wrong amount next to money is worse than none.
  if (draft.deployedCapital !== null) {
    const { amountRaw, decimals, chainId, assetAddress, assetSymbol } = draft.deployedCapital;
    const human = formatRawAmount(amountRaw, decimals);
    const figure = human === null ? `${assetSymbol}` : `${human} ${assetSymbol}`;
    lines.push(
      `**Deployed capital:** ${figure} (raw ${amountRaw} at ${decimals} decimals) on chain ${chainId}, ` +
        `asset ${assetAddress}. This is the declared measurement base, not a spend limit.`,
    );
  }
  if (draft.riskProfile) lines.push(`**Risk:** ${draft.riskProfile}`);
  // C6 — the model READS its ceiling (it can never write it) so it chooses an
  // amount up to the limit instead of discovering the refusal at signing time.
  if (draft.maxLaunchValueRaw !== null && draft.maxLaunchValueDecimals !== null) {
    lines.push(
      `**Max launch value:** ${draft.maxLaunchValueRaw} raw @ ${draft.maxLaunchValueDecimals} decimals — ` +
        "hard ceiling on creation fee + prebuy for an autonomous token launch. Exceeding it is refused, not clamped.",
    );
  }
  // C6b — the same read-only disclosure for the count cap. Both ceilings must
  // be set for an autonomous launch; the model can write neither.
  if (draft.maxLaunchCount !== null) {
    lines.push(
      `**Max launch count:** ${draft.maxLaunchCount} — the most tokens this mission may create. ` +
        "Launches still settling count. Exceeding it is refused, not queued.",
    );
  }
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
  if (draft.durationMinutes) lines.push(`**Time-box:** ${draft.durationMinutes} min (run auto-finalizes at start + this)`);

  return lines.join("\n");
}
