/**
 * Missions DB normalisation helpers (puzzle 04 phase 7 extract).
 *
 * Extracted from `missions-db.ts` so the parent file can host both
 * `getDraftForSession` and the new `getRenewableSourceForSession`
 * resolver without breaking the 350-LOC per-file budget (codex
 * phase 7 review §Q2).
 *
 * Behaviorally a no-op: every helper here lived in `missions-db.ts`
 * before this move. Existing mapper tests cover the same surface, no
 * test changes required for the extraction itself. The acceptance
 * fixture suite + the new renewable-source suite call into these
 * helpers via the public `toDraftDto` / `getDraftForSession` paths.
 */

import {
  MISSION_DRAFT_LIST_ITEM_MAX,
  MISSION_DRAFT_LIST_MAX,
  missionConstraintsSchema,
  missionListEntrySchema,
  missionStatusSchema,
  type MissionAcceptance,
  type MissionConstraints,
  type MissionStatus,
  hyperliquidMissionRiskTransportSchema,
  type HyperliquidMissionRiskTransport,
} from "@shared/schemas/mission.js";
import { log } from "../logger/index.js";

export const EMPTY_CONSTRAINTS: MissionConstraints = {};

/** Allowlisted mission risk projection; malformed JSONB never reaches the renderer. */
export function normaliseHyperliquidMissionRisk(
  raw: unknown,
): HyperliquidMissionRiskTransport | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const candidate = (raw as Record<string, unknown>)["hyperliquidRisk"];
  const parsed = hyperliquidMissionRiskTransportSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Allow-listed projection of a `missions` row. Every column the
 * `getDraftForSession` + `getRenewableSourceForSession` callers read
 * is enumerated here; nothing else flows through the mapper.
 */
export interface MissionRow {
  readonly id: string;
  readonly root_session_id: string;
  readonly status: string;
  readonly title: string | null;
  readonly goal: string | null;
  readonly constraints_json: unknown;
  readonly success_criteria_json: unknown;
  readonly stop_conditions_json: unknown;
  readonly risk_profile: string | null;
  readonly allowed_protocols: unknown;
  readonly allowed_chains: unknown;
  readonly allowed_wallets: unknown;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
  readonly approved_at: string | Date | null;
  // Puzzle 04 phase 6 — acceptance four-tuple from mig 023. DB CHECK
  // (`chk_missions_acceptance_atomicity`) guarantees all-null or
  // all-non-null; the mapper still defends against partial state by
  // collapsing any leak into `acceptance: null` + a warn log.
  readonly accepted_contract_hash: string | null;
  readonly accepted_contract_at: string | Date | null;
  readonly accepted_contract_by: string | null;
  readonly contract_hash_version: number | null;
  /** `/mission-renew` lineage — id of the mission this one was renewed from. */
  readonly renewed_from_mission_id: string | null;
}

export const MISSION_ROW_COLUMNS =
  "id, root_session_id, status, title, goal, constraints_json, success_criteria_json, stop_conditions_json, risk_profile, allowed_protocols, allowed_chains, allowed_wallets, created_at, updated_at, approved_at, accepted_contract_hash, accepted_contract_at, accepted_contract_by, contract_hash_version, renewed_from_mission_id";

export function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

export function normaliseStatus(raw: string): MissionStatus {
  const parsed = missionStatusSchema.safeParse(raw);
  // An exotic status collapses to `draft` so the read-only handler
  // still returns something renderable. The structural log on the
  // unexpected value will surface in the dispatcher's logs.
  if (!parsed.success) {
    log.warn(`[missions-db] unknown mission status: ${raw}`);
    return "draft";
  }
  return parsed.data;
}

/**
 * Allowlist + Zod parse `constraints_json`. Falls back to `{}` on any
 * failure (column null, not object, fails strict schema). Unknown keys
 * are silently dropped — schema is `.strict()`.
 *
 * The projection path is allowlist-only: each constraint key is copied
 * over only when the source has a value of the expected primitive type.
 * Missing or wrong-typed inputs result in the key being absent from
 * the DTO (not `null`-padded) so the renderer's "Show optional fields"
 * affordance can rely on key presence as a signal.
 */
export function normaliseConstraints(raw: unknown): MissionConstraints {
  if (raw === null || raw === undefined) return EMPTY_CONSTRAINTS;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    log.warn("[missions-db] constraints_json not an object — using empty");
    return EMPTY_CONSTRAINTS;
  }
  const parsed = missionConstraintsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Allow-listed projection: a single offending key shouldn't drop the
  // whole constraint set. We copy each key over only when the source
  // value's type matches the schema; everything else is omitted so the
  // DTO stays compact and `undefined`-fields don't leak as `null`.
  const rec = raw as Record<string, unknown>;
  const projection: Partial<MissionConstraints> = {};
  if (typeof rec["maxSpendUsd"] === "number") {
    projection.maxSpendUsd = rec["maxSpendUsd"];
  }
  if (typeof rec["maxLossUsd"] === "number") {
    projection.maxLossUsd = rec["maxLossUsd"];
  }
  if (typeof rec["maxIterations"] === "number") {
    projection.maxIterations = rec["maxIterations"];
  }
  if (typeof rec["deadlineAt"] === "string") {
    projection.deadlineAt = rec["deadlineAt"];
  }
  if (typeof rec["notes"] === "string") {
    projection.notes = rec["notes"];
  }
  // Phase 4d-5 — host-only auto-retry opt-in. Boolean-only; absent/wrong
  // type leaves the key off the DTO (the renderer treats absence as off).
  if (typeof rec["autoRetryEnabled"] === "boolean") {
    projection.autoRetryEnabled = rec["autoRetryEnabled"];
  }
  const reparsed = missionConstraintsSchema.safeParse(projection);
  if (reparsed.success) return reparsed.data;
  log.warn("[missions-db] constraints_json projection failed Zod parse");
  return EMPTY_CONSTRAINTS;
}

export function normaliseStringList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) {
      log.warn(`[missions-db] ${label} not an array — using empty`);
    }
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= MISSION_DRAFT_LIST_MAX) break;
    if (typeof entry !== "string") continue;
    const parsed = missionListEntrySchema.safeParse(entry);
    if (parsed.success) {
      out.push(parsed.data);
    } else if (entry.length <= MISSION_DRAFT_LIST_ITEM_MAX) {
      // Loose recovery: trimmed non-empty strings still pass through.
      const trimmed = entry.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

export function normalisePgArray(
  raw: unknown,
  label: string,
  maxLen: number,
): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    log.warn(`[missions-db] ${label} not an array — using empty`);
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= MISSION_DRAFT_LIST_MAX) break;
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > maxLen) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Project the acceptance four-tuple from a missions row. Strict
 * 4-of-4 — any partial state (which `chk_missions_acceptance_atomicity`
 * rejects at the DB level but might slip in via a manual SQL edit)
 * collapses to `acceptance: null` plus a warn log so the renderer
 * never shows a partial "accepted" badge.
 *
 * Puzzle 04 phase 6 codex review #4.
 */
export function projectAcceptance(
  row: MissionRow,
): MissionAcceptance | null {
  // Coerce undefined → null so a missing column (e.g. fixture row in
  // tests, or pre-mig 023 row read against a fresh schema during a
  // partial rollout) collapses to the unaccepted branch.
  const h = row.accepted_contract_hash ?? null;
  const at = row.accepted_contract_at ?? null;
  const by = row.accepted_contract_by ?? null;
  const v = row.contract_hash_version ?? null;
  // All four null → unaccepted (canonical empty state).
  if (h === null && at === null && by === null && v === null) return null;
  // All four set → accepted (project a typed block).
  if (h !== null && at !== null && by !== null && v !== null) {
    return {
      contractHash: h,
      acceptedAt: toIso(at),
      acceptedBy: by,
      contractHashVersion: v,
    };
  }
  // Partial (defensive — DB CHECK should prevent this). Refuse to
  // surface a malformed acceptance object to the renderer.
  log.warn(
    `[missions-db] partial acceptance row for mission ${row.id} ` +
      `(hash=${h !== null} at=${at !== null} by=${by !== null} v=${v !== null}) ` +
      `— projecting null`,
  );
  return null;
}
