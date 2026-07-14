/**
 * Mission renewal — clone a completed/accepted mission into a fresh
 * draft for the same session.
 *
 * Codex direction: `renewMission` REQUIRES an explicit
 * `previousMissionId`. The renderer's Renew control is the only place
 * that's allowed to auto-resolve "latest terminal accepted mission" →
 * explicit id (via `mission.getRenewableSource`) before calling this
 * engine helper. Engine never auto-finds.
 *
 * Semantics:
 *
 *   - source mission must belong to the same session (no
 *     cross-session renewal)
 *   - source must have `accepted_contract_hash IS NOT NULL` (you can
 *     only renew a contract that the user actually accepted)
 *   - source's last `mission_run` must be in a terminal status
 *     (`completed`, `failed`, `stopped`, `cancelled`). A still-active
 *     run means the contract is live; the user should stop it first.
 *   - target session must have no active/paused mission run (renewal
 *     adds a fresh draft; one mission per session at a time)
 *   - the new row clones every contract field (goal, constraints,
 *     stop conditions, allow-lists, capital, risk, success criteria)
 *     but resets:
 *       - id (new uuid)
 *       - status → 'draft'
 *       - acceptance four-tuple → NULL
 *       - approved_at → NULL
 *       - timestamps → NOW()
 *       - renewed_from_mission_id → source mission id
 *
 *   - NEVER starts a run. Phase 4's `startMission` requires the user
 *     to click `Accept contract` first.
 *
 * Idempotency: renew is intentionally NOT idempotent — clicking the
 * button twice creates two separate draft rows. The renderer should
 * gate the action (button disables after first click + invalidates
 * the mission query); engine-side dedup would require a token the
 * UI doesn't carry today.
 */

import { randomUUID } from "node:crypto";

import { withTransaction } from "../../db/client.js";
import {
  type Mission,
  getMissionForUpdate,
} from "../../db/repos/missions.js";
import * as missionRunsRepo from "../../db/repos/mission-runs.js";
import { cloneMissionAsDraft } from "./renew-internals.js";
import { CONTRACT_HASH_VERSION, LEGACY_CONTRACT_HASH_VERSION, computeContractHash } from "./contract-hash.js";
import { missionToDraft } from "./mapper.js";

export interface RenewMissionInput {
  readonly sessionId: string;
  readonly previousMissionId: string;
}

export type RenewMissionOutcome =
  | {
    readonly outcome: "renewed";
    readonly newMissionId: string;
    readonly sourceMissionId: string;
  }
  | { readonly outcome: "previous_mission_not_found" }
  | {
    readonly outcome: "session_mismatch";
    readonly expectedSessionId: string;
  }
  | {
    readonly outcome: "not_accepted";
    readonly sourceMissionId: string;
  }
  | {
    readonly outcome: "not_terminal_yet";
    readonly sourceMissionId: string;
    readonly missionRunId: string;
    readonly runStatus: string;
  }
  | {
    readonly outcome: "session_has_active_run";
    readonly missionRunId: string;
    readonly runStatus: string;
  };

/** Clone an accepted + terminal mission into a fresh draft row. */
export async function renewMission(
  input: RenewMissionInput,
): Promise<RenewMissionOutcome> {
  return withTransaction(async (client): Promise<RenewMissionOutcome> => {
    // 1. Row-locked read of the source mission.
    const source: Mission | null = await getMissionForUpdate(
      client,
      input.previousMissionId,
    );
    if (!source) {
      return { outcome: "previous_mission_not_found" };
    }

    // 2. Session ownership check.
    if (source.rootSessionId !== input.sessionId) {
      return {
        outcome: "session_mismatch",
        expectedSessionId: source.rootSessionId,
      };
    }

    // 3. Acceptance gate — only accepted contracts can be renewed.
    if (
      source.acceptedContractHash === null
      || source.contractHashVersion === null
      || (source.contractHashVersion !== LEGACY_CONTRACT_HASH_VERSION
        && source.contractHashVersion !== CONTRACT_HASH_VERSION)
    ) {
      return {
        outcome: "not_accepted",
        sourceMissionId: source.id,
      };
    }

    // Renewal must not clone an acceptance that has drifted. Verify with the
    // source row's recorded version so a v1 contract is never reinterpreted
    // as v2 merely because the current app understands new material.
    if (computeContractHash(missionToDraft(source), source.contractHashVersion) !== source.acceptedContractHash) {
      return {
        outcome: "not_accepted",
        sourceMissionId: source.id,
      };
    }

    // 4. Last run must be terminal. Use `getActiveRun` (which filters
    //    to ACTIVE_OR_PAUSED) — any hit means the contract is still
    //    live. If no row, treat as terminal-or-never-run, both OK.
    const liveSourceRun = await missionRunsRepo.getActiveRun(
      source.id,
      client,
    );
    if (liveSourceRun !== null) {
      return {
        outcome: "not_terminal_yet",
        sourceMissionId: source.id,
        missionRunId: liveSourceRun.id,
        runStatus: liveSourceRun.status,
      };
    }

    // 5. Target session must have no active mission run (any mission,
    //    not just this one). One mission per session at a time.
    const sessionActiveRun = await missionRunsRepo.getActiveRunBySession(
      input.sessionId,
      client,
    );
    if (sessionActiveRun !== null) {
      return {
        outcome: "session_has_active_run",
        missionRunId: sessionActiveRun.id,
        runStatus: sessionActiveRun.status,
      };
    }

    // 6. Clone via dedicated repo helper. The clone:
    //      - copies every contract field
    //      - resets status to 'draft', acceptance + approved_at to NULL
    //      - stamps renewed_from_mission_id = source.id
    const newId = `mission-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await cloneMissionAsDraft(client, source.id, newId, input.sessionId);

    return {
      outcome: "renewed",
      newMissionId: newId,
      sourceMissionId: source.id,
    };
  });
}
