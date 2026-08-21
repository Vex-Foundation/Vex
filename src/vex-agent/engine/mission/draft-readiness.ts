/**
 * Draft readiness reconciler — the ONE-WAY `draft` → `ready` promotion.
 *
 * Before this module, the only draft→ready transition was the model-patch
 * path (`applyMissionPatch` in `./setup.ts`), which fires only when the
 * model sends a `MissionDraftUpdate` patch. A renewed clone or an
 * edited-and-resaved mission that is ALREADY complete produces no patch,
 * so it never promotes — the badge shows "Preparing" forever (issue #41).
 * This is the reconciliation call every draft-producing write site makes
 * right after it writes `status = 'draft'`.
 *
 * One-way and status-guarded: NEVER demotes `ready` → `draft` (that stays
 * `setup.ts`'s job — an edit can clear a previously-ready field) and
 * NEVER promotes an invalid draft. Status is not a security gate:
 * `ACCEPTABLE_MISSION_STATUSES` (`acceptance.ts`) already accepts
 * `'draft'` for contract acceptance, so promoting a complete draft to
 * `'ready'` only changes what the operator sees, not what they can do.
 */

import type { PoolClient } from "pg";

import { withTransaction } from "@vex-agent/db/client.js";
import { getMissionForUpdate, setStatus } from "@vex-agent/db/repos/missions.js";
import { validateDraft } from "./validator.js";

export interface ReconcileDraftReadinessResult {
  readonly promoted: boolean;
}

/**
 * Row-locked draft → ready reconciliation for `missionId`.
 *
 * Pass `client` when the caller already holds the row lock (or is inside
 * a wider transaction) — e.g. `renewMission`'s session-locked tx, so the
 * clone insert and the readiness check commit atomically. Omit it to have
 * this function open its own transaction and lock the row itself — the
 * shape every call site outside an existing tx needs (`abort.ts`,
 * `mission-finalize.ts`).
 */
export async function reconcileDraftReadiness(
  missionId: string,
  client?: PoolClient,
): Promise<ReconcileDraftReadinessResult> {
  if (client) {
    return reconcileLocked(client, missionId);
  }
  return withTransaction((tx) => reconcileLocked(tx, missionId));
}

async function reconcileLocked(
  client: PoolClient,
  missionId: string,
): Promise<ReconcileDraftReadinessResult> {
  const mission = await getMissionForUpdate(client, missionId);
  if (!mission || mission.status !== "draft") {
    return { promoted: false };
  }

  const validation = validateDraft(mission);
  if (!validation.valid) {
    return { promoted: false };
  }

  await setStatus(missionId, "ready", client);
  return { promoted: true };
}
