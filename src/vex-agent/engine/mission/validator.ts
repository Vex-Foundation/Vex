/**
 * Mission validator — sole source of truth for draft completeness.
 *
 * Repo is pure CRUD. This module decides if a draft has all required
 * fields to transition from draft → ready. No DB access.
 *
 * Puzzle 04: completeness is now decoupled from acceptance. A draft is
 * `ready` once every required field has a non-empty value. Acceptance
 * (host-only `mission.acceptContract` → `missions.accepted_contract_hash`,
 * mig 023) is enforced by `startMission` as a separate gate, not by
 * draft validation. This lets the UI show the contract diff +
 * "Accept contract" button BEFORE acceptance is granted, instead of
 * pretending the draft is still incomplete.
 */

import type { Mission } from "@vex-agent/db/repos/missions.js";
import { MISSION_DRAFT_REQUIRED_FIELDS } from "../types.js";

/**
 * The draft values the completeness predicate reads, decoupled from ANY
 * particular row shape.
 *
 * Two adapters feed it and there must never be a third predicate: the engine's
 * `getMissingFields(Mission)` below, and the Electron main process's
 * `mission.getDraft` mapper (`vex-app/src/main/database/missions-db.ts`), which
 * projects the same list onto `MissionDraftDto.missingFields` so the renderer
 * can NAME what is still missing instead of re-deriving readiness. Keeping the
 * predicate here (rather than mirroring it main-side) is what makes the host UI
 * structurally unable to contradict the engine's `draft → ready` decision.
 */
export interface MissionDraftFieldValues {
  readonly title: string | null;
  readonly goal: string | null;
  /** Raw `capital_source_json` blob; `capitalSource` + `startingCapital` both read it. */
  readonly capitalSourceJson: Record<string, unknown> | null;
  readonly allowedWallets: readonly string[];
  readonly allowedChains: readonly string[];
  readonly allowedProtocols: readonly string[];
  readonly riskProfile: string | null;
  readonly successCriteria: readonly unknown[];
  readonly stopConditions: readonly unknown[];
}

type FieldAccessor = (v: MissionDraftFieldValues) => unknown;

const FIELD_ACCESSORS: Record<string, FieldAccessor> = {
  title: v => v.title,
  goal: v => v.goal,
  capitalSource: v => {
    const src = v.capitalSourceJson;
    return src && Object.keys(src).length > 0 ? src : null;
  },
  startingCapital: v => {
    const src = v.capitalSourceJson;
    return src?.amount ?? src?.startingCapital ?? null;
  },
  allowedWallets: v => v.allowedWallets.length > 0 ? v.allowedWallets : null,
  allowedChains: v => v.allowedChains.length > 0 ? v.allowedChains : null,
  allowedProtocols: v => v.allowedProtocols.length > 0 ? v.allowedProtocols : null,
  riskProfile: v => v.riskProfile,
  successCriteria: v => v.successCriteria.length > 0 ? v.successCriteria : null,
  stopConditions: v => v.stopConditions.length > 0 ? v.stopConditions : null,
};

/** Adapt an engine mission row to the shape-agnostic predicate input. */
function toFieldValues(mission: Mission): MissionDraftFieldValues {
  return {
    title: mission.title,
    goal: mission.goal,
    capitalSourceJson: (mission.capitalSourceJson ?? null) as Record<string, unknown> | null,
    allowedWallets: mission.allowedWallets,
    allowedChains: mission.allowedChains,
    allowedProtocols: mission.allowedProtocols,
    riskProfile: mission.riskProfile,
    successCriteria: mission.successCriteriaJson,
    stopConditions: mission.stopConditionsJson,
  };
}

// ── Public API ──────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  missing: string[];
}

/**
 * Validate a mission's draft fields against required field set.
 * Returns which fields are missing (null, empty string, empty array).
 */
export function validateDraft(mission: Mission): ValidationResult {
  const missing = getMissingFields(mission);
  return { valid: missing.length === 0, missing };
}

/** Get list of required fields that are not yet populated. */
export function getMissingFields(mission: Mission): string[] {
  return getMissingDraftFields(toFieldValues(mission));
}

/**
 * THE completeness predicate, over the row-shape-agnostic view. Everything that
 * needs to know "what is still missing" - the engine's `draft → ready`
 * transition and the host's `mission.getDraft` projection - goes through here.
 */
export function getMissingDraftFields(values: MissionDraftFieldValues): string[] {
  const missing: string[] = [];

  for (const field of MISSION_DRAFT_REQUIRED_FIELDS) {
    const accessor = FIELD_ACCESSORS[field];
    if (!accessor) {
      missing.push(field);
      continue;
    }

    const value = accessor(values);
    if (value === null || value === undefined || value === "") {
      missing.push(field);
    }
  }

  return missing;
}

/** Whether the draft has all required fields for transition to ready. */
export function isReadyToStart(mission: Mission): boolean {
  return getMissingFields(mission).length === 0;
}
