/**
 * Atomic mission-start transition (puzzle 04 phase 4).
 *
 * Codex blocker: the standalone `assertAcceptedContract` gate releases
 * its row lock on COMMIT, but `startMission` then does several more
 * statements (status flip, approved_at, createRun, snapshot build).
 * A concurrent `updateDraft` between gate and flip could stale the
 * acceptance and let an out-of-date contract reach the runtime.
 *
 * `commitMissionStart` closes the window by running EVERY check + the
 * state mutations inside one `withTransaction`, with `SELECT FOR
 * UPDATE` on the missions row held for the duration:
 *
 *   1. row-lock missions
 *   2. validate `accepted_contract_hash`, `contract_hash_version ===
 *      CONTRACT_HASH_VERSION`
 *   3. recompute the canonical hash on the locked draft; reject on
 *      drift
 *   4. `isReadyToStart` against the locked row
 *   5. `getActiveRun(_, client)` — no overlapping run for this
 *      mission, riding the same tx so a concurrent run create can't
 *      slip in
 *   6. flip status → "running", set approved_at
 *   7. build `contractSnapshotJson` from the locked draft
 *   8. createRun with the snapshot, in the same tx
 *
 * On COMMIT, the run is durable + the snapshot reflects the exact
 * draft that the host accepted. `startMission` then drops the lock
 * and proceeds to the long-running `runTurnLoop` outside any DB tx,
 * which is fine — the run is created and the snapshot is frozen.
 *
 * `updateDraft` / `clearAcceptance` from phase 6 will use the same
 * `SELECT FOR UPDATE` on `missions`, so concurrent edit attempts
 * serialize behind this tx.
 */

import type { PoolClient } from "pg";

import { withTransaction } from "../../db/client.js";
import {
  getMissionForUpdate,
  setApprovedAt,
  setStatus,
  type Mission,
} from "../../db/repos/missions.js";
import * as missionRunsRepo from "../../db/repos/mission-runs.js";
import * as sessionPlansRepo from "../../db/repos/session-plans.js";

import {
  CONTRACT_HASH_VERSION,
  LEGACY_CONTRACT_HASH_VERSION,
  computeContractHash,
} from "./contract-hash.js";
import { missionToDraft } from "./mapper.js";
import {
  buildMissionRunContractSnapshot,
  type MissionRunContractSnapshot,
} from "./run-contract.js";
import { isReadyToStart } from "./validator.js";

export interface CommitMissionStartInput {
  readonly missionId: string;
  /** Caller supplies the run id so the lease handle + cleanup paths
   *  can address the run before this tx commits. */
  readonly runId: string;
}

export type CommitMissionStartOutcome =
  | {
    readonly outcome: "committed";
    readonly mission: Mission;
    readonly runId: string;
    readonly contractSnapshot: MissionRunContractSnapshot;
  }
  | { readonly outcome: "mission_not_found" }
  | {
    readonly outcome: "not_accepted";
    readonly missionId: string;
  }
  | {
    readonly outcome: "stale_acceptance";
    readonly currentHash: string;
    readonly acceptedHash: string;
  }
  | {
    /**
     * Plan-mode is on for this mission session but the action plan is not
     * accepted (a `plan_write` / `setEnabled` re-armed acceptance between the
     * unified Accept step and Start). Fail closed — starting would
     * immediately pause on the runtime plan-acceptance gate.
     */
    readonly outcome: "plan_not_accepted";
    readonly missionId: string;
  }
  | {
    readonly outcome: "not_ready";
    readonly missingFields: ReadonlyArray<string>;
  }
  | {
    readonly outcome: "active_run_exists";
    readonly missionRunId: string;
    readonly runStatus: string;
  };

/**
 * Atomic: gate → readiness → no-active-run → status flip → run create.
 * COMMIT releases the row lock; the run is durable and ready for
 * `runTurnLoop`.
 */
export async function commitMissionStart(
  input: CommitMissionStartInput,
): Promise<CommitMissionStartOutcome> {
  return withTransaction(async (client: PoolClient): Promise<CommitMissionStartOutcome> => {
    // 1. row-lock
    const mission = await getMissionForUpdate(client, input.missionId);
    if (!mission) {
      return { outcome: "mission_not_found" };
    }

    // 2. acceptance four-tuple + exact version match
    if (
      mission.acceptedContractHash === null
      || mission.contractHashVersion === null
      || (mission.contractHashVersion !== LEGACY_CONTRACT_HASH_VERSION
        && mission.contractHashVersion !== CONTRACT_HASH_VERSION)
    ) {
      return { outcome: "not_accepted", missionId: mission.id };
    }

    // 3. recompute canonical hash on the locked draft
    const currentHash = computeContractHash(missionToDraft(mission), mission.contractHashVersion);
    if (currentHash !== mission.acceptedContractHash) {
      return {
        outcome: "stale_acceptance",
        currentHash,
        acceptedHash: mission.acceptedContractHash,
      };
    }

    // 3b. plan-acceptance start-gate (MANDATORY). The unified accept step
    //     guarantees plan acceptance at accept-time, but a `plan_write` /
    //     `setEnabled` between Accept and Start re-arms the gate. Fail closed
    //     here so the run never starts and immediately pauses on the runtime
    //     plan-acceptance gate. Same `enabled && !accepted` condition as that
    //     gate (no `planMd.length` — an enabled-but-empty plan is also "not
    //     ready"). Plan-mode off / no plan row → branch skipped (unchanged).
    const plan = await sessionPlansRepo.getActivePlan(mission.rootSessionId, client);
    if (plan?.enabled && !plan.accepted) {
      return { outcome: "plan_not_accepted", missionId: mission.id };
    }

    // 4. readiness against the locked row (missing fields after
    //    acceptance would be an `updateDraft` racing past the
    //    `clearAcceptance` invariant — fail closed)
    if (!isReadyToStart(mission)) {
      const { getMissingFields } = await import("./validator.js");
      return {
        outcome: "not_ready",
        missingFields: getMissingFields(mission),
      };
    }

    // 5. no overlapping active run for this mission, in the same tx
    const existingRun = await missionRunsRepo.getActiveRun(input.missionId, client);
    if (existingRun !== null) {
      return {
        outcome: "active_run_exists",
        missionRunId: existingRun.id,
        runStatus: existingRun.status,
      };
    }

    // 6. flip status + approved_at (tx-aware overloads from phase 3)
    await setStatus(input.missionId, "running", client);
    await setApprovedAt(input.missionId, client);

    // 7. build snapshot from the locked draft so the run captures
    //    exactly what the host accepted (and what step 3 just
    //    rehashed). The snapshot is the source of truth for resumed
    //    runs even if the mission row later moves back to draft.
    const contractSnapshot = buildMissionRunContractSnapshot(mission);

    // 8. createRun inside the same tx; the FK on `mission_runs.mission_id`
    //    references the row we just flipped.
    await missionRunsRepo.createRun(
      input.runId,
      input.missionId,
      mission.rootSessionId,
      { contractSnapshotJson: contractSnapshot },
      client,
    );

    return {
      outcome: "committed",
      mission,
      runId: input.runId,
      contractSnapshot,
    };
  });
}
