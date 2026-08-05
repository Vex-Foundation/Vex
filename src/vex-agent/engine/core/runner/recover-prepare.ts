/**
 * `prepareMissionRecover` — synchronous, durable preparation of a
 * failed-run recovery. Same shape as `prepareMissionStart`:
 *
 *   1. Session-level active/paused gate (1st check)
 *   2. Find latest failed run + mission preflight (plain reads)
 *   3. Session permission read (BEFORE lease/tx)
 *   4. Provider/config resolution
 *   5. Lease claim
 *   6. Session-level active/paused gate (2nd check, post-claim race)
 *   7. Durable atomic tx — setStatus(running) + setApprovedAt +
 *      createRun(newRunId, recoveredFromRunId) + getRun (readback)
 *   8. Pure construction of `PreparedMissionRecover`
 *
 * Banner append moves OUT of durable tx (best-effort; lives in
 * `runPreparedMissionRecover`).
 */

import { randomUUID } from "node:crypto";

import { withTransaction } from "@vex-agent/db/client.js";
import {
  type Mission,
  getMission,
  setApprovedAt,
  setStatus,
} from "@vex-agent/db/repos/missions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import type { MissionRun } from "@vex-agent/db/repos/mission-runs.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import type { RunnerLease } from "@vex-agent/db/repos/runner-leases.js";
import { resolveProvider } from "@vex-agent/inference/registry.js";
import logger from "@utils/logger.js";

import { requireMissionPromptContextFromSnapshot } from "../../mission/run-contract.js";
import {
  claimSessionLease,
} from "../../runtime/lease-and-status.js";
import {
  createLeaseHandle,
  type LeaseHandle,
} from "../../runtime/lease-handle.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";

const LEASE_TTL_MS = 5 * 60_000;

export interface PreparedMissionRecover {
  readonly newRunId: string;
  readonly recoveredFromRunId: string;
  readonly missionId: string;
  readonly sessionId: string;
  readonly mission: Mission;
  readonly run: MissionRun;
  readonly sessionLease: LeaseHandle;
  readonly provider: NonNullable<Awaited<ReturnType<typeof resolveProvider>>>;
  readonly config: NonNullable<
    Awaited<
      ReturnType<
        NonNullable<Awaited<ReturnType<typeof resolveProvider>>>["loadConfig"]
      >
    >
  >;
}

export type PrepareMissionRecoverOutcome =
  | {
    readonly outcome: "prepared";
    readonly prepared: PreparedMissionRecover;
  }
  | { readonly outcome: "no_failed_run" }
  | {
    readonly outcome: "session_has_active_run";
    readonly missionRunId: string;
    readonly runStatus: string;
  }
  | { readonly outcome: "session_not_found" }
  | {
    readonly outcome: "lease_busy";
    readonly currentLease: RunnerLease;
  }
  | { readonly outcome: "provider_unavailable" }
  /**
   * A SESSION-scoped operator Stop was outstanding when the run-creation
   * transaction ran. No run was created: a run committed after a Stop is
   * unreachable by that Stop, because the run-scoped gate matches on
   * `mission_run_id` and never finds a NULL-scoped request.
   *
   * The gate consumed the stop in the same transaction, so a retry proceeds.
   */
  | { readonly outcome: "session_stop_pending" };

export interface PrepareMissionRecoverInput {
  readonly sessionId: string;
}

export async function prepareMissionRecover(
  input: PrepareMissionRecoverInput,
): Promise<PrepareMissionRecoverOutcome> {
  // 1. Session-level active/paused gate.
  const active1 = await missionRunsRepo.getActiveRunBySession(input.sessionId);
  if (active1 !== null) {
    return {
      outcome: "session_has_active_run",
      missionRunId: active1.id,
      runStatus: active1.status,
    };
  }

  // 2. Find latest failed run + mission preflight (plain reads).
  const failed = await missionRunsRepo.getLatestFailedRunBySession(
    input.sessionId,
  );
  if (!failed) return { outcome: "no_failed_run" };
  requireMissionPromptContextFromSnapshot(failed.contractSnapshotJson);
  const mission = await getMission(failed.missionId);
  if (!mission) return { outcome: "no_failed_run" };

  // 3. Session existence check (permission itself is read inside
  //    `resumePreparedMissionRun` via hydrated context so the fallible
  //    permission lookup lands in the protected try/catch).
  const session = await sessionsRepo.getSession(input.sessionId);
  if (!session) return { outcome: "session_not_found" };

  // 4. Provider/config.
  const provider = await resolveProvider();
  if (!provider) return { outcome: "provider_unavailable" };
  const config = await provider.loadConfig();
  if (!config) return { outcome: "provider_unavailable" };

  // 5. Lease claim.
  const ownerId = `recover-${failed.id}`;
  const claim = await claimSessionLease({
    sessionId: input.sessionId,
    ownerId,
    processKind: "electron_main",
    ttlMs: LEASE_TTL_MS,
  });
  if (claim.outcome === "lease_busy") {
    return { outcome: "lease_busy", currentLease: claim.currentLease };
  }
  const sessionLease = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });

  // 6. Session-level active/paused gate (2nd, post-claim race window).
  const active2 = await missionRunsRepo.getActiveRunBySession(input.sessionId);
  if (active2 !== null) {
    await releaseLeaseAndEmitControlState(sessionLease, input.sessionId, {
      missionRunId: null,
    }).catch(() => undefined);
    return {
      outcome: "session_has_active_run",
      missionRunId: active2.id,
      runStatus: active2.status,
    };
  }

  // 7. Durable atomic tx — setStatus + setApprovedAt + createRun +
  //    getRun (same client, readback inside the tx).
  const newRunId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let created: MissionRun | "session_stop_pending";
  try {
    created = await withTransaction(async (client) => {
      // SESSION CONTROL LOCK FIRST, per the canonical global lock order. Same
      // reason as `commitMissionStart`: run CREATION and the operator's Stop
      // must be strictly ordered, or a Stop that read "no active run" commits a
      // SESSION-scoped `stop_terminal` the run-scoped gate can never find, and
      // the recovered run proceeds unstoppable. The lock gives the ORDER; the
      // gate below is what makes the stop-committed-first ordering safe. It
      // applies and consumes the stop in this same transaction, so the refusal
      // parks nothing for later work to trip over.
      const { acquireSessionControlLock, gateOnOperatorStopWithClient } =
        await import("../../runtime/lease-and-status.js");
      await acquireSessionControlLock(client, input.sessionId);
      const stopGate = await gateOnOperatorStopWithClient(client, {
        sessionId: input.sessionId,
        missionRunId: null,
      });
      if (stopGate.kind === "stopped") return "session_stop_pending" as const;
      await setStatus(mission.id, "running", client);
      await setApprovedAt(mission.id, client);
      await missionRunsRepo.createRun(
        newRunId,
        mission.id,
        input.sessionId,
        {
          contractSnapshotJson: failed.contractSnapshotJson,
          recoveredFromRunId: failed.id,
        },
        client,
      );
      const run = await missionRunsRepo.getRun(newRunId, client);
      if (!run) {
        throw new Error(
          `prepareMissionRecover: createRun did not persist ${newRunId}`,
        );
      }
      return run;
    });
  } catch (err) {
    await releaseLeaseAndEmitControlState(sessionLease, input.sessionId, {
      missionRunId: null,
    }).catch(() => undefined);
    throw err;
  }

  if (created === "session_stop_pending") {
    // Nothing was committed, so the lease this prepare claimed is ours to
    // release — the same rule every other refusal path here follows.
    await releaseLeaseAndEmitControlState(sessionLease, input.sessionId, {
      missionRunId: null,
    }).catch(() => undefined);
    return { outcome: "session_stop_pending" };
  }
  const createdRun: MissionRun = created;

  logger.info("engine.mission.prepare_recover.committed", {
    missionId: mission.id,
    sessionId: input.sessionId,
    newRunId,
    recoveredFromRunId: failed.id,
  });

  // 8. Pure construction.
  return {
    outcome: "prepared",
    prepared: {
      newRunId,
      recoveredFromRunId: failed.id,
      missionId: mission.id,
      sessionId: input.sessionId,
      mission,
      run: createdRun,
      sessionLease,
      provider,
      config,
    },
  };
}
