/**
 * Internals for `renew.ts` — the SQL clone helper lives here so the
 * main file stays focused on policy + outcome shaping.
 */

import type { PoolClient } from "pg";

import { executeWith } from "../../db/client.js";

/**
 * `INSERT INTO missions SELECT FROM missions WHERE id = $source`
 * with the renewal-specific overrides. All four acceptance columns
 * land NULL together (CHECK constraint `chk_missions_acceptance_atomicity`
 * is satisfied because either-all-or-none holds: all four are NULL on
 * the clone). `renewed_from_mission_id` is stamped with the source id.
 *
 * The new row's `root_session_id` is explicitly passed by the caller
 * rather than copied — the caller already verified session ownership
 * of the source, but passing the target session id keeps the SQL
 * self-explanatory.
 *
 * `constraints_json` strips the legacy `hyperliquidRisk` key (jsonb `-`
 * operator) rather than copying it verbatim. A source mission accepted
 * while `CONTRACT_HASH_VERSION` was 2 may still carry a historical
 * Hyperliquid risk envelope there; the clone is always a fresh
 * `contract_hash_version = NULL` draft that will next be hashed at v3
 * (`contract-hash.ts`), which has no Hyperliquid field. The frozen v2
 * material (`contract-hash-legacy-v2.ts`) is verify-only — reproducing the
 * SOURCE mission's original hash — and must never be carried forward into a
 * new draft's live `constraints_json`.
 */
export async function cloneMissionAsDraft(
  client: PoolClient,
  sourceMissionId: string,
  newMissionId: string,
  targetSessionId: string,
): Promise<void> {
  await executeWith(
    client,
    `INSERT INTO missions (
       id,
       root_session_id,
       status,
       title,
       goal,
       constraints_json,
       success_criteria_json,
       stop_conditions_json,
       risk_profile,
       capital_source_json,
       allowed_protocols,
       allowed_chains,
       allowed_wallets,
       created_at,
       updated_at,
       approved_at,
       accepted_contract_hash,
       accepted_contract_at,
       accepted_contract_by,
       contract_hash_version,
       renewed_from_mission_id
     )
     SELECT
       $2 AS id,
       $3 AS root_session_id,
       'draft' AS status,
       title,
       goal,
       constraints_json - 'hyperliquidRisk' AS constraints_json,
       success_criteria_json,
       stop_conditions_json,
       risk_profile,
       capital_source_json,
       allowed_protocols,
       allowed_chains,
       allowed_wallets,
       NOW() AS created_at,
       NOW() AS updated_at,
       NULL AS approved_at,
       NULL AS accepted_contract_hash,
       NULL AS accepted_contract_at,
       NULL AS accepted_contract_by,
       NULL AS contract_hash_version,
       $1 AS renewed_from_mission_id
     FROM missions
     WHERE id = $1`,
    [sourceMissionId, newMissionId, targetSessionId],
  );
}
