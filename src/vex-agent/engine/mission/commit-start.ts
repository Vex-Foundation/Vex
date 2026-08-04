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

import { queryOneWith, withTransaction } from "../../db/client.js";
import {
  getMissionForUpdate,
  setApprovedAt,
  setStatus,
  type Mission,
} from "../../db/repos/missions.js";
import * as missionRunsRepo from "../../db/repos/mission-runs.js";
import * as sessionPlansRepo from "../../db/repos/session-plans.js";

import {
  LEGACY_V2_CONTRACT_HASH_VERSION,
  computeContractHash,
  isKnownContractHashVersion,
} from "./contract-hash.js";
import { extractLegacyHyperliquidRiskV2, missionToDraft } from "./mapper.js";
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
  }
  /**
   * The operator had a SESSION-scoped Stop outstanding when this start tried
   * to commit. Starting anyway would create a run the stop could never reach:
   * the run-scoped gate matches on `mission_run_id`, so a NULL-scoped request
   * is never found for a run.
   *
   * The gate that detected it also APPLIED and consumed it, so the session is
   * now clean — this is "your Stop landed first, start again", not a dead end.
   */
  | { readonly outcome: "session_stop_pending" };

/**
 * The mission's session, read without a lock so it can precede the session
 * control lock. `root_session_id` is immutable for the life of a mission.
 */
async function readMissionRootSessionId(
  client: PoolClient,
  missionId: string,
): Promise<string | null> {
  const row = await queryOneWith<{ readonly root_session_id: string }>(
    client,
    "SELECT root_session_id FROM missions WHERE id = $1",
    [missionId],
  );
  return row === null ? null : row.root_session_id;
}

/**
 * Atomic: gate → readiness → no-active-run → status flip → run create.
 * COMMIT releases the row lock; the run is durable and ready for
 * `runTurnLoop`.
 */
export async function commitMissionStart(
  input: CommitMissionStartInput,
): Promise<CommitMissionStartOutcome> {
  return withTransaction(async (client: PoolClient): Promise<CommitMissionStartOutcome> => {
    // 0. SESSION CONTROL LOCK — FIRST, per the canonical global lock order, so
    //    RUN CREATION and the operator's Stop are strictly ordered rather than
    //    interleaved. Without it, a Stop that read "no active run" could commit
    //    a SESSION-scoped `stop_terminal` while this transaction was creating
    //    the run; the run-scoped gate matches on `mission_run_id` and would
    //    never find a NULL-scoped row, so the run would proceed and the
    //    operator's Stop on money-moving work would do nothing. With the lock,
    //    the stop transaction either SEES this run (and reroutes to the
    //    run-scoped path) or committed before this one began.
    //
    //    The session id is read WITHOUT a lock because it must precede the
    //    lock, and it is immutable for the life of a mission: `root_session_id`
    //    is set at creation and never updated. The authoritative, locked read
    //    follows in step 1.
    const sessionId = await readMissionRootSessionId(client, input.missionId);
    if (sessionId === null) return { outcome: "mission_not_found" };
    const { acquireSessionControlLock, gateOnOperatorStopWithClient } =
      await import("../runtime/lease-and-status.js");
    await acquireSessionControlLock(client, sessionId);

    // 0b. STOP-FIRST refusal, under the lock we just took. The lock alone makes
    //     creation and Stop strictly ORDERED; this is what makes the
    //     stop-committed-first ordering SAFE. The gate applies and consumes the
    //     session stop in this same transaction, so the refusal leaves nothing
    //     parked for later work to trip over.
    const stopGate = await gateOnOperatorStopWithClient(client, {
      sessionId,
      missionRunId: null,
    });
    if (stopGate.kind === "stopped") {
      return { outcome: "session_stop_pending" };
    }

    // 1. row-lock
    const mission = await getMissionForUpdate(client, input.missionId);
    if (!mission) {
      return { outcome: "mission_not_found" };
    }

    // 2. acceptance four-tuple + exact version match. v2 stays accepted here
    //    (frozen historical shape, see contract-hash.ts) so a mission accepted
    //    while Hyperliquid mutations were live can still start.
    if (
      mission.acceptedContractHash === null
      || !isKnownContractHashVersion(mission.contractHashVersion)
    ) {
      return { outcome: "not_accepted", missionId: mission.id };
    }

    // 3. recompute canonical hash on the locked draft. The legacy v2 risk
    //    material (if any) is sourced directly off the row — MissionDraft no
    //    longer carries it — and is a no-op for any other version.
    const currentHash = computeContractHash(
      missionToDraft(mission),
      mission.contractHashVersion,
      mission.contractHashVersion === LEGACY_V2_CONTRACT_HASH_VERSION
        ? extractLegacyHyperliquidRiskV2(mission)
        : undefined,
    );
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
