/**
 * Missions repo — pure CRUD persistence for mission drafts and lifecycle.
 *
 * Zero validation logic — draft completeness lives in engine/mission/validator.ts.
 * This repo is the DB boundary: it writes MissionDraftRow (snake_case, JSONB)
 * and reads it back. Domain ↔ row conversion is mapper's responsibility.
 */

import type { PoolClient } from "pg";

import { query, queryOne, execute, queryOneWith, executeWith } from "../client.js";
import { jsonb, jsonbPlaceholder } from "../params.js";

const MISSION_DRAFT_COLUMN_KINDS = {
  title: "scalar",
  goal: "scalar",
  constraints_json: "jsonb",
  success_criteria_json: "jsonb",
  stop_conditions_json: "jsonb",
  risk_profile: "scalar",
  capital_source_json: "jsonb",
  allowed_protocols: "scalar",
  allowed_chains: "scalar",
  allowed_wallets: "scalar",
} satisfies Record<keyof MissionDraftRow, "jsonb" | "scalar">;

// ── Row types (DB shape) ────────────────────────────────────────

export interface MissionRow {
  id: string;
  root_session_id: string;
  status: string;
  title: string | null;
  goal: string | null;
  constraints_json: Record<string, unknown>;
  success_criteria_json: string[];
  stop_conditions_json: string[];
  risk_profile: string | null;
  capital_source_json: Record<string, unknown>;
  allowed_protocols: string[];
  allowed_chains: string[];
  allowed_wallets: string[];
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  // Host-only acceptance metadata (mig 023). All four are either set
  // together (CHECK chk_missions_acceptance_atomicity) or all NULL.
  accepted_contract_hash: string | null;
  accepted_contract_at: string | null;
  accepted_contract_by: string | null;
  contract_hash_version: number | null;
  // Mission-level lineage for /mission-renew (mig 023).
  renewed_from_mission_id: string | null;
}

export interface Mission {
  id: string;
  rootSessionId: string;
  status: string;
  title: string | null;
  goal: string | null;
  constraintsJson: Record<string, unknown>;
  successCriteriaJson: string[];
  stopConditionsJson: string[];
  riskProfile: string | null;
  capitalSourceJson: Record<string, unknown>;
  allowedProtocols: string[];
  allowedChains: string[];
  allowedWallets: string[];
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  /** Host-set acceptance hash (mig 023). `null` = unaccepted draft. */
  acceptedContractHash: string | null;
  acceptedContractAt: string | null;
  acceptedContractBy: string | null;
  contractHashVersion: number | null;
  /** Mission-level lineage for /mission-renew (mig 023). */
  renewedFromMissionId: string | null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

function mapRow(r: Record<string, unknown>): Mission {
  return {
    id: r.id as string,
    rootSessionId: r.root_session_id as string,
    status: r.status as string,
    title: r.title as string | null,
    goal: r.goal as string | null,
    constraintsJson: (typeof r.constraints_json === "string" ? JSON.parse(r.constraints_json) : r.constraints_json ?? {}) as Record<string, unknown>,
    successCriteriaJson: (typeof r.success_criteria_json === "string" ? JSON.parse(r.success_criteria_json) : r.success_criteria_json ?? []) as string[],
    stopConditionsJson: (typeof r.stop_conditions_json === "string" ? JSON.parse(r.stop_conditions_json) : r.stop_conditions_json ?? []) as string[],
    riskProfile: r.risk_profile as string | null,
    capitalSourceJson: (typeof r.capital_source_json === "string" ? JSON.parse(r.capital_source_json) : r.capital_source_json ?? {}) as Record<string, unknown>,
    allowedProtocols: (r.allowed_protocols ?? []) as string[],
    allowedChains: (r.allowed_chains ?? []) as string[],
    allowedWallets: (r.allowed_wallets ?? []) as string[],
    createdAt: (r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at as string),
    updatedAt: (r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at as string),
    approvedAt: toIsoOrNull(r.approved_at),
    acceptedContractHash: (r.accepted_contract_hash ?? null) as string | null,
    acceptedContractAt: toIsoOrNull(r.accepted_contract_at),
    acceptedContractBy: (r.accepted_contract_by ?? null) as string | null,
    contractHashVersion: (r.contract_hash_version ?? null) as number | null,
    renewedFromMissionId: (r.renewed_from_mission_id ?? null) as string | null,
  };
}

// ── Partial row for updates (snake_case DB columns) ─────────────

export interface MissionDraftRow {
  title?: string | null;
  goal?: string | null;
  constraints_json?: Record<string, unknown>;
  success_criteria_json?: string[];
  stop_conditions_json?: string[];
  risk_profile?: string | null;
  capital_source_json?: Record<string, unknown>;
  allowed_protocols?: string[];
  allowed_chains?: string[];
  allowed_wallets?: string[];
}

// ── CRUD ────────────────────────────────────────────────────────

export async function createDraft(id: string, rootSessionId: string): Promise<void> {
  await execute(
    "INSERT INTO missions (id, root_session_id, status) VALUES ($1, $2, 'draft')",
    [id, rootSessionId],
  );
}

export async function updateDraft(
  id: string,
  fields: MissionDraftRow,
  client?: PoolClient,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const columnKind = MISSION_DRAFT_COLUMN_KINDS[key as keyof MissionDraftRow];
    if (!columnKind) continue;
    const placeholder = columnKind === "jsonb" ? jsonbPlaceholder(idx) : `$${idx}`;
    const dbValue = columnKind === "jsonb" ? jsonb(value) : value;
    sets.push(`${key} = ${placeholder}`);
    params.push(dbValue);
    idx++;
  }

  if (sets.length === 0) return;

  sets.push(`updated_at = NOW()`);
  params.push(id);

  // Client-aware so `applyMissionPatch` can run the read-merge-write of
  // JSONB partial-update fields inside one row-locked transaction (mirrors
  // setStatus / setApprovedAt). The overwrite semantics are unchanged.
  const sql = `UPDATE missions SET ${sets.join(", ")} WHERE id = $${idx}`;
  if (client) {
    await executeWith(client, sql, params);
  } else {
    await execute(sql, params);
  }
}

export async function setStatus(
  id: string,
  status: string,
  client?: PoolClient,
): Promise<void> {
  const sql = "UPDATE missions SET status = $1, updated_at = NOW() WHERE id = $2";
  if (client) {
    await executeWith(client, sql, [status, id]);
  } else {
    await execute(sql, [status, id]);
  }
}

export async function setApprovedAt(
  id: string,
  client?: PoolClient,
): Promise<void> {
  const sql = "UPDATE missions SET approved_at = NOW(), updated_at = NOW() WHERE id = $1";
  if (client) {
    await executeWith(client, sql, [id]);
  } else {
    await execute(sql, [id]);
  }
}

export async function clearApprovedAt(
  id: string,
  client?: PoolClient,
): Promise<void> {
  const sql =
    "UPDATE missions SET approved_at = NULL, updated_at = NOW() WHERE id = $1";
  if (client) {
    await executeWith(client, sql, [id]);
  } else {
    await execute(sql, [id]);
  }
}

export async function getMission(id: string): Promise<Mission | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM missions WHERE id = $1",
    [id],
  );
  return row ? mapRow(row) : null;
}

export async function getMissionBySession(rootSessionId: string): Promise<Mission | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM missions WHERE root_session_id = $1 ORDER BY created_at DESC LIMIT 1",
    [rootSessionId],
  );
  return row ? mapRow(row) : null;
}

export async function getActiveMission(rootSessionId: string): Promise<Mission | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM missions WHERE root_session_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at DESC LIMIT 1",
    [rootSessionId],
  );
  return row ? mapRow(row) : null;
}

// ── Tx-aware helpers (puzzle 04) ────────────────────────────────
// These accept an explicit PoolClient so the engine acceptance flow
// can lock the missions row and recompute the contract hash inside
// a single transaction. All four acceptance columns are touched
// together per the CHECK constraint `chk_missions_acceptance_atomicity`
// added in migration 023.

/** Row-locked read of a mission inside an existing tx. */
export async function getMissionForUpdate(
  client: PoolClient,
  id: string,
): Promise<Mission | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    "SELECT * FROM missions WHERE id = $1 FOR UPDATE",
    [id],
  );
  return row ? mapRow(row) : null;
}

/**
 * Session-scoped transactional advisory lock — serializes ALL concurrent
 * `renewMission` calls for the same session so the pending-draft check in
 * `getPendingDraftForSession` and the clone insert commit as one atomic
 * decision (closes the duplicate-draft storm race; a schema unique index
 * is not viable because production data already contains duplicate drafts
 * from before this fix). `hashtext` folds the session id into the 32-bit
 * key `pg_advisory_xact_lock` needs. Xact-scoped: Postgres releases it
 * automatically at COMMIT/ROLLBACK, so there is no matching unlock call.
 */
export async function lockSessionForRenew(
  client: PoolClient,
  sessionId: string,
): Promise<void> {
  await executeWith(
    client,
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [sessionId],
  );
}

/**
 * Does the session already hold an un-started (`draft`/`ready`) mission?
 * Called INSIDE the same locked transaction as `lockSessionForRenew` above
 * so a second concurrent renew (racing before the first commits) cannot
 * both pass this check — the root cause of the duplicate-draft storm.
 */
export async function getPendingDraftForSession(
  client: PoolClient,
  rootSessionId: string,
): Promise<Mission | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `SELECT * FROM missions
      WHERE root_session_id = $1
        AND status IN ('draft', 'ready')
      LIMIT 1`,
    [rootSessionId],
  );
  return row ? mapRow(row) : null;
}

/**
 * Stamp acceptance metadata on a mission. The caller MUST hold a row
 * lock (via `getMissionForUpdate`) so concurrent `clearAcceptance`
 * / `startMission` see the freshly-committed state.
 *
 * `by` is free-form host identifier; MVP writes `'host'`. A future
 * multi-actor world (delegated approver, mission template owner)
 * would widen this without a schema change.
 *
 * `contractHashVersion` mirrors `CONTRACT_HASH_VERSION` from
 * `engine/mission/contract-hash.ts` at the moment of acceptance.
 */
export async function updateAcceptance(
  client: PoolClient,
  id: string,
  hash: string,
  by: string,
  contractHashVersion: number,
): Promise<void> {
  await executeWith(
    client,
    `UPDATE missions
        SET accepted_contract_hash = $2,
            accepted_contract_at = NOW(),
            accepted_contract_by = $3,
            contract_hash_version = $4,
            updated_at = NOW()
      WHERE id = $1`,
    [id, hash, by, contractHashVersion],
  );
}

/**
 * Clear acceptance metadata back to the unaccepted state. Called by
 * the host `updateDraft` path (phase 6) so any mission-relevant field
 * change forces re-acceptance.
 *
 * Writes all four columns to NULL together — partial state is
 * rejected by the DB CHECK constraint.
 */
export async function clearAcceptance(
  client: PoolClient,
  id: string,
): Promise<void> {
  await executeWith(
    client,
    `UPDATE missions
        SET accepted_contract_hash = NULL,
            accepted_contract_at = NULL,
            accepted_contract_by = NULL,
            contract_hash_version = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [id],
  );
}

/**
 * Merge a single `autoRetryEnabled` flag into `constraints_json`
 * without clobbering sibling keys (SQL-side JSONB `||`). The caller
 * MUST hold the missions row lock (via `getMissionForUpdate`) so the
 * status/permission decision and this write commit atomically and
 * serialize against `applyMissionPatch`'s read-merge-write.
 *
 * Phase 4d-5 — the host-only auto-retry opt-in toggle. `autoRetryEnabled`
 * is NOT part of the contract hash (see engine/mission/contract-hash.ts),
 * so toggling it never dirties an accepted contract.
 */
export async function mergeConstraintAutoRetry(
  client: PoolClient,
  id: string,
  enabled: boolean,
): Promise<void> {
  await executeWith(
    client,
    `UPDATE missions
        SET constraints_json =
              COALESCE(constraints_json, '{}'::jsonb)
              || jsonb_build_object('autoRetryEnabled', $2::boolean),
            updated_at = NOW()
      WHERE id = $1`,
    [id, enabled],
  );
}

/**
 * Merge the three §C6/§C6b launch-ceiling keys into `constraints_json` without
 * clobbering siblings, same lock contract as {@link mergeConstraintAutoRetry}.
 *
 * All three keys are written TOGETHER, including their `null`s: the value pair
 * is meaningless half-written, and "clear the ceiling" must actually clear it
 * rather than leave a stale number behind. Unlike `autoRetryEnabled`, these ARE
 * contract-hash material (v5), so the caller must also invalidate acceptance —
 * see `engine/mission/set-launch-ceilings.ts`, the only caller.
 */
export async function mergeConstraintLaunchCeilings(
  client: PoolClient,
  id: string,
  ceilings: {
    maxLaunchValueRaw: string | null;
    maxLaunchValueDecimals: number | null;
    maxLaunchCount: number | null;
  },
): Promise<void> {
  await executeWith(
    client,
    `UPDATE missions
        SET constraints_json =
              COALESCE(constraints_json, '{}'::jsonb)
              || jsonb_build_object(
                   'maxLaunchValueRaw', $2::text,
                   'maxLaunchValueDecimals', $3::int,
                   'maxLaunchCount', $4::int
                 ),
            updated_at = NOW()
      WHERE id = $1`,
    [id, ceilings.maxLaunchValueRaw, ceilings.maxLaunchValueDecimals, ceilings.maxLaunchCount],
  );
}
