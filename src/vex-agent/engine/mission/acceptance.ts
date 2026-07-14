/**
 * Host-only mission contract acceptance.
 *
 * The user clicks "Accept contract" in the renderer. The
 * `mission.acceptContract` IPC handler (phase 6) calls this engine
 * helper with the contract hash the UI computed and showed. We:
 *
 *   1. open a tx and SELECT FOR UPDATE the missions row so any
 *      concurrent `updateDraft` / `startMission` sees a serialized
 *      view of acceptance state;
 *   2. recompute the canonical hash from the (locked) row so the user
 *      cannot accept a contract that drifted between view and click;
 *   3. validate the mission status is in {draft, ready} (you don't
 *      accept a running / completed / failed / cancelled mission —
 *      the contract is either already live or no longer relevant);
 *   4. validate no active/paused mission_run exists for this mission
 *      (acceptance after run started would be sketchy — a fresh
 *      acceptance via `/mission-renew` is the right path);
 *   5. write the four acceptance columns atomically via
 *      `updateAcceptance` (the CHECK constraint
 *      `chk_missions_acceptance_atomicity` rejects partial state at
 *      the DB level too).
 *
 * No engine event is emitted yet — phase 6 wires the IPC layer's
 * TanStack onSuccess invalidation. A cross-window
 * `engine.mission.accepted` topic lands with the right-rail
 * subscriber in puzzle 10 (per the plan).
 */

import { withTransaction } from "../../db/client.js";
import {
  getMissionForUpdate,
  updateAcceptance,
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

const ACCEPTABLE_MISSION_STATUSES = new Set<string>(["draft", "ready"]);
/**
 * Puzzle 04 MVP invariant: acceptance is host-only. A future
 * delegated-approver flow would widen this to a typed enum; for now
 * we pin the literal so the IPC schema layer in phase 6 can rely on
 * `accepted_contract_by === "host"` without any runtime branching.
 */
const ACCEPTANCE_ACTOR = "host" as const;

/**
 * Private rollback sentinels for the unified accept-contract-and-plan path
 * (Approach A). When plan-mode is on and the session has an enabled,
 * unaccepted plan, the contract and the plan must be accepted both-or-neither
 * inside the single `withTransaction`.
 *
 * `withTransaction` COMMITs on a normal return and only ROLLs BACK on a throw
 * (`db/client.ts`), so the rollback paths MUST throw — a `return { outcome }`
 * from inside the TX would commit the contract acceptance while leaving the
 * plan unaccepted. These are caught immediately OUTSIDE the TX and mapped to
 * the `plan_missing` / `plan_stale` outcomes.
 */
class PlanStaleError extends Error {}
class PlanMissingError extends Error {}

// ── Acceptance gate (used by startMission) ───────────────────────

export interface AcceptanceGateInput {
  readonly missionId: string;
}

export type AcceptanceGateOutcome =
  | {
    readonly outcome: "accepted";
    readonly contractHash: string;
    readonly contractHashVersion: number;
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
  };

/**
 * Read-only row-locked acceptance check.
 *
 * `startMission` itself uses the larger `commitMissionStart` helper
 * (`./commit-start.ts`), which holds the row lock across the entire
 * gate → flip → createRun pipeline. `assertAcceptedContract` is the
 * narrower read-only version for callers that only need to answer
 * "is this contract currently accepted?" without mutating state —
 * e.g. the phase 6 IPC layer can use it to decide whether to expose
 * the Start button.
 *
 * Opens its own short tx, locks the missions row via SELECT FOR
 * UPDATE, recomputes the canonical hash from the locked draft, and
 * confirms the prior `acceptContract` four-tuple still matches.
 * Releases the lock on COMMIT.
 */
export async function assertAcceptedContract(
  input: AcceptanceGateInput,
): Promise<AcceptanceGateOutcome> {
  return withTransaction(async (client): Promise<AcceptanceGateOutcome> => {
    const mission = await getMissionForUpdate(client, input.missionId);
    if (!mission) {
      return { outcome: "mission_not_found" };
    }
    // Legacy v1 contracts remain immutable and valid forever. Recompute with
    // the version stored at acceptance; unknown versions fail closed.
    if (
      mission.acceptedContractHash === null
      || mission.contractHashVersion === null
      || !isKnownContractHashVersion(mission.contractHashVersion)
    ) {
      return { outcome: "not_accepted", missionId: mission.id };
    }
    const currentHash = computeContractHash(missionToDraft(mission), mission.contractHashVersion);
    if (currentHash !== mission.acceptedContractHash) {
      return {
        outcome: "stale_acceptance",
        currentHash,
        acceptedHash: mission.acceptedContractHash,
      };
    }
    return {
      outcome: "accepted",
      contractHash: mission.acceptedContractHash,
      contractHashVersion: mission.contractHashVersion,
    };
  });
}

export interface AcceptContractInput {
  readonly sessionId: string;
  readonly missionId: string;
  /** Hash that the renderer computed + showed to the user. */
  readonly contractHash: string;
  /**
   * Optimistic-concurrency guard for the reviewed action plan (plan-mode
   * only). The host obtains this from the same `plan.get` read that rendered
   * the plan for review; it is the plan row's `updatedAt` (ISO string), NOT
   * plan content — the engine accepts the locked row's own `planMd`. Required
   * when the session has an enabled, non-empty, unaccepted plan; mismatching
   * or absent values yield `plan_stale` so an unreviewed plan is never
   * accepted. Omitted entirely when plan-mode is off (default).
   */
  readonly planUpdatedAt?: string;
}

export type AcceptContractOutcome =
  | {
    readonly outcome: "accepted";
    readonly missionId: string;
    readonly acceptedContractHash: string;
    readonly acceptedAt: string;
    readonly acceptedBy: string;
    readonly contractHashVersion: number;
    /**
     * ISO acceptance timestamp of the co-accepted action plan, when plan-mode
     * was on and a plan was accepted in the same TX. Undefined when no plan
     * branch ran (plan-mode off / no enabled-unaccepted plan).
     */
    readonly planAcceptedAt?: string;
  }
  | { readonly outcome: "mission_not_found" }
  | {
    /**
     * Plan-mode is on but the session has an enabled plan with empty body —
     * nothing was authored, so there is nothing to accept. The host must
     * author a plan (via `plan_write`) before accepting.
     */
    readonly outcome: "plan_missing";
  }
  | {
    /**
     * The reviewed plan changed (or `planUpdatedAt` was absent/mismatched)
     * between review and accept. The whole TX rolled back — neither contract
     * nor plan was accepted. The host must re-review the current plan.
     */
    readonly outcome: "plan_stale";
  }
  | {
    readonly outcome: "session_mismatch";
    /** Mission's `root_session_id`, surfaced for diagnostics only. */
    readonly expectedSessionId: string;
  }
  | {
    readonly outcome: "hash_mismatch";
    readonly providedHash: string;
    readonly currentHash: string;
  }
  | {
    readonly outcome: "status_blocked";
    readonly currentStatus: string;
  }
  | {
    readonly outcome: "run_active";
    readonly missionRunId: string;
    readonly runStatus: string;
  };

/** Host-only acceptance of the current mission contract. */
export async function acceptContract(
  input: AcceptContractInput,
): Promise<AcceptContractOutcome> {
  try {
    return await withTransaction(async (client): Promise<AcceptContractOutcome> => {
    // 1. Row-locked read.
    const mission: Mission | null = await getMissionForUpdate(client, input.missionId);
    if (!mission) {
      return { outcome: "mission_not_found" } as const;
    }

    // 2. Session ownership sanity check — the renderer always passes
    //    the session id; mismatching means a stale UI / hostile call.
    if (mission.rootSessionId !== input.sessionId) {
      return {
        outcome: "session_mismatch",
        expectedSessionId: mission.rootSessionId,
      } as const;
    }

    // 3. Recompute the canonical hash from the locked row. If the
    //    UI showed an older draft, the hash won't match and the user
    //    must re-view + re-accept.
    // New acceptance always emits v2 material. A legacy v1 draft that somehow
    // carries Hyperliquid risk cannot be accepted under the old hash shape.
    const currentHash = computeContractHash(missionToDraft(mission), CONTRACT_HASH_VERSION);
    if (currentHash !== input.contractHash) {
      return {
        outcome: "hash_mismatch",
        providedHash: input.contractHash,
        currentHash,
      } as const;
    }

    // 4. Status gate.
    if (!ACCEPTABLE_MISSION_STATUSES.has(mission.status)) {
      return {
        outcome: "status_blocked",
        currentStatus: mission.status,
      } as const;
    }

    // 5. No active/paused mission_run — acceptance is a pre-run gate.
    //    A run already started means the contract is live (the run
    //    captured a contract snapshot via `buildMissionRunContractSnapshot`).
    const activeRun = await missionRunsRepo.getActiveRun(
      input.missionId,
      client,
    );
    if (activeRun !== null) {
      return {
        outcome: "run_active",
        missionRunId: activeRun.id,
        runStatus: activeRun.status,
      } as const;
    }

    // 6. Co-accept the session action plan (Approach A, plan-mode only).
    //    The plan branch runs ONLY for an enabled, unaccepted plan — the
    //    same `enabled && !accepted` condition the runtime dispatcher gate
    //    uses (no `planMd.length` condition), so an enabled-but-empty plan
    //    fails accept (PlanMissingError) instead of slipping through to a
    //    mid-run pause. Plan-mode off / no plan row → branch skipped, behaves
    //    byte-for-byte as before. A throw here rolls back the WHOLE TX,
    //    including the contract acceptance below (both-or-neither).
    let planAcceptedAt: string | undefined;
    const plan = await sessionPlansRepo.getActivePlan(input.sessionId, client);
    if (plan?.enabled && !plan.accepted) {
      if (plan.planMd.length === 0) {
        throw new PlanMissingError();
      }
      // Reviewed-plan guard: the host must echo the exact `updatedAt` it
      // reviewed. `updatedAt` is already an ISO string on the mapped row.
      if (!input.planUpdatedAt || plan.updatedAt !== input.planUpdatedAt) {
        throw new PlanStaleError();
      }
      // Accept the locked row's OWN `planMd` (engine-derived, never
      // renderer-supplied). A concurrent content-changing `plan_write`
      // makes `setAccepted` miss its WHERE → null → stale → rollback.
      const acceptedPlan = await sessionPlansRepo.setAccepted(
        input.sessionId,
        plan.planMd,
        client,
      );
      if (!acceptedPlan) {
        throw new PlanStaleError();
      }
      planAcceptedAt = acceptedPlan.acceptedAt ?? undefined;
    }

    // 7. Commit the acceptance four-tuple atomically.
    await updateAcceptance(
      client,
      input.missionId,
      currentHash,
      ACCEPTANCE_ACTOR,
      CONTRACT_HASH_VERSION,
    );

    // 8. Re-read so the returned timestamp matches the row we wrote.
    const updated = await getMissionForUpdate(client, input.missionId);
    if (!updated || updated.acceptedContractHash === null || updated.acceptedContractAt === null) {
      throw new Error(
        "acceptContract: acceptance row vanished or wrote NULL despite a successful UPDATE",
      );
    }

    return {
      outcome: "accepted",
      missionId: input.missionId,
      acceptedContractHash: updated.acceptedContractHash,
      acceptedAt: updated.acceptedContractAt,
      acceptedBy: updated.acceptedContractBy ?? ACCEPTANCE_ACTOR,
      contractHashVersion: updated.contractHashVersion ?? CONTRACT_HASH_VERSION,
      ...(planAcceptedAt !== undefined ? { planAcceptedAt } : {}),
    } as const;
    });
  } catch (err) {
    // Rollback sentinels caught OUTSIDE the TX → the TX already rolled back
    // (neither contract nor plan accepted). Map to the structured outcomes;
    // rethrow anything else (real errors must surface).
    if (err instanceof PlanMissingError) {
      return { outcome: "plan_missing" } as const;
    }
    if (err instanceof PlanStaleError) {
      return { outcome: "plan_stale" } as const;
    }
    throw err;
  }
}

function isKnownContractHashVersion(version: number): version is typeof LEGACY_CONTRACT_HASH_VERSION | typeof CONTRACT_HASH_VERSION {
  return version === LEGACY_CONTRACT_HASH_VERSION || version === CONTRACT_HASH_VERSION;
}
