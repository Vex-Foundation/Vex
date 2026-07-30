/**
 * `applyStopForEdit` — the ONE atomic transition behind "stop this run so the
 * operator can edit the mission contract".
 *
 * ## Why this module exists: a committed user Stop is FINAL
 *
 * Stop-for-edit and an ordinary operator Stop want the SAME run row state
 * (`stopped` / `user_stopped`) but DIFFERENT parent-mission state: ordinary
 * Stop cancels the mission, stop-for-edit demotes it to `draft` so a new draft
 * can be saved and a fresh run started. Owner decision: **Stop wins.** If an
 * ordinary Stop has already committed, a concurrent stop-for-edit must not
 * rewrite the run row and must not resurrect the mission from `cancelled` into
 * `draft` — that would silently re-open a mission the user ended.
 *
 * Both previous call sites (`core/runner/abort.ts#stopMissionRunForEdit` and
 * the edit arm of `core/runner/mission-finalize.ts`) read the run OUTSIDE a
 * transaction and then wrote unconditionally. An ordinary Stop committing in
 * that gap was overwritten by both.
 *
 * ## How "did I win?" is decided — NOT by reading the status back
 *
 * Both writers produce the identical `stopped` / `user_stopped` pair, so the
 * status VALUE after the fact identifies nobody. The distinguishing fact is
 * which writer committed the NON-TERMINAL → TERMINAL transition, and that is
 * observable in exactly one place: inside `applyUserStopWithClient`, which
 * reads the run row `FOR UPDATE` and re-checks `TERMINAL_RUN_STATUSES` in the
 * same transaction as the write. Because a terminal run row is immutable audit
 * history (see `db/repos/mission-runs.ts#updateStatus`), at most one
 * transaction can ever see the run non-terminal and move it. That transaction
 * gets `outcome: "stopped"`; every later one gets `already_terminal`.
 *
 * So the mission demotion is gated on `outcome === "stopped"` and runs in the
 * SAME transaction. A stop-for-edit that lost writes nothing at all.
 *
 * ## Distinguishing "an ordinary Stop beat me" from "my own edit already landed"
 *
 * `abort.ts` fires the in-process `AbortController` and then runs this
 * transaction, while the aborted loop unwinds and runs it too (via the
 * finalize edit arm). One of those two wins and the other legitimately loses —
 * but for the user the edit DID happen, and reporting `already_terminal` there
 * would be as untruthful as reporting success after losing to a real Stop.
 *
 * The mission row settles that without any extra bookkeeping: a mission on
 * `draft` (or `ready`, once `reconcileDraftReadiness` has promoted it) can only
 * have got there from a stop-for-edit demotion — an ordinary Stop writes
 * `cancelled`, and a business outcome writes `completed` / `failed`. So the
 * lost branch reads the mission status once and splits itself into
 * `already_edited` versus `lost_to_terminal`. Callers never re-derive this.
 *
 * Lock order is unchanged: everything here happens inside
 * `applyUserStopWithClient`'s canonical SESSION CONTROL LOCK → OPEN CONTROL
 * REQUESTS → RUN sequence. The mission read/write is unlocked, exactly as the
 * shared stop body already does it.
 */

import { queryOneWith, withTransaction } from "../../../db/client.js";
import type { MissionRunStatus, MissionStatus } from "../../types.js";
import * as missionsRepo from "../../../db/repos/missions.js";
import { applyUserStopWithClient, type UserStopPayload } from "./apply-user-stop.js";

/** Mission states that can only be the result of a stop-for-edit demotion. */
const EDITED_MISSION_STATUSES: ReadonlySet<string> = new Set(["draft", "ready"]);

export const STOP_FOR_EDIT_SUMMARY = "Mission stopped for operator edit";

export interface ApplyStopForEditInput {
  readonly sessionId: string;
  readonly missionRunId: string;
  readonly stopPayload?: UserStopPayload;
}

export type ApplyStopForEditOutcome =
  | {
    /** THIS transaction moved the run terminal and demoted the mission. */
    readonly outcome: "stopped_for_edit";
    readonly previousStatus: MissionRunStatus;
    readonly missionId: string;
    readonly rejectedApprovals: number;
  }
  | {
    /**
     * The run was already terminal AND the mission already carries a
     * stop-for-edit demotion — the sibling edit-stop path won. Nothing was
     * written; the user's edit is in effect.
     */
    readonly outcome: "already_edited";
    readonly missionId: string;
    readonly missionStatus: MissionStatus;
  }
  | {
    /**
     * The run was already terminal for some OTHER reason — an ordinary user
     * Stop (mission `cancelled`) or a business outcome. Nothing was written
     * and the mission was deliberately NOT demoted.
     */
    readonly outcome: "lost_to_terminal";
    readonly missionId: string;
    readonly currentRunStatus: MissionRunStatus;
    readonly missionStatus: MissionStatus;
  }
  | { readonly outcome: "run_not_found" };

export async function applyStopForEditTransaction(
  input: ApplyStopForEditInput,
): Promise<ApplyStopForEditOutcome> {
  return withTransaction(async (client): Promise<ApplyStopForEditOutcome> => {
    const applied = await applyUserStopWithClient(client, {
      sessionId: input.sessionId,
      missionRunId: input.missionRunId,
      stopPayload: input.stopPayload
        ?? { summary: STOP_FOR_EDIT_SUMMARY },
    });

    if (applied.outcome === "run_not_found") return { outcome: "run_not_found" };

    if (applied.outcome === "already_terminal") {
      const missionStatus = await readMissionStatus(client, applied.missionId);
      if (EDITED_MISSION_STATUSES.has(missionStatus)) {
        return {
          outcome: "already_edited",
          missionId: applied.missionId,
          missionStatus,
        };
      }
      return {
        outcome: "lost_to_terminal",
        missionId: applied.missionId,
        currentRunStatus: applied.currentStatus,
        missionStatus,
      };
    }

    // We won the transition, so — and ONLY so — the mission is demoted. The
    // shared stop body set it to `cancelled` a moment ago in this same
    // transaction; overwriting it here is safe precisely because no other
    // writer could have interleaved.
    await missionsRepo.clearApprovedAt(applied.missionId, client);
    await missionsRepo.setStatus(applied.missionId, "draft", client);

    return {
      outcome: "stopped_for_edit",
      previousStatus: applied.previousStatus,
      missionId: applied.missionId,
      rejectedApprovals: applied.rejectedApprovals,
    };
  });
}

/**
 * Read the parent mission's status. Unvalidated DB text is narrowed to the
 * `MissionStatus` union with an explicit membership check — an unrecognised
 * value is reported as `cancelled`, the conservative reading ("this mission is
 * not editable"), never cast blindly.
 */
async function readMissionStatus(
  client: Parameters<typeof queryOneWith>[0],
  missionId: string,
): Promise<MissionStatus> {
  const row = await queryOneWith<{ status: string }>(
    client,
    "SELECT status FROM missions WHERE id = $1",
    [missionId],
  );
  const raw = row?.status ?? "cancelled";
  return isMissionStatus(raw) ? raw : "cancelled";
}

const MISSION_STATUSES: ReadonlySet<string> = new Set<MissionStatus>([
  "draft",
  "ready",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

function isMissionStatus(value: string): value is MissionStatus {
  return MISSION_STATUSES.has(value);
}
