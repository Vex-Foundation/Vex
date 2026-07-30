/**
 * `prepareMissionStart` — synchronous, durable, side-effect-bounded
 * preparation of a mission run start. Returns once the durable
 * `mission_runs` row exists at status `running`, OR a structured
 * rejection that the caller can map to an IPC outcome.
 *
 * The split between prepare (sync, durable) and run (long-running)
 * is the puzzle-04-phase-6 codex requirement: `mission.start` IPC
 * must not return `dispatched` until a durable run row exists.
 * Otherwise a hostile renderer could observe `dispatched` for a
 * run that never persisted.
 *
 * Order is **security-first**:
 *
 *   1. Mission ownership check (plain read of `missions`; reject
 *      cross-session). Hostile renderer cannot trigger provider /
 *      lease / commit paths for a mission it doesn't own.
 *   2. Session-level active/paused run gate (1st check, before
 *      provider).
 *   3. Provider + config resolution.
 *   4. Lease claim.
 *   5. Session-level active/paused run gate (2nd check, after lease
 *      claim — race window: a separate runner could have started +
 *      finished a run between #2 and lease claim, leaving paused_*
 *      without active lease).
 *   6. Session permission read (fallible — runs BEFORE the durable
 *      `commitMissionStart` so a missing session row doesn't orphan
 *      a `running` mission_runs row).
 *   7. `commitMissionStart` — atomic acceptance gate + readiness +
 *      no-overlapping-run + status flip + createRun. After this
 *      step, NO fallible IO before the prepared return.
 *   8. Pure construction of `PreparedMissionStart`.
 */

import { randomUUID } from "node:crypto";

import {
  type Mission,
  getMission,
} from "@vex-agent/db/repos/missions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import type { RunnerLease } from "@vex-agent/db/repos/runner-leases.js";
import { resolveProvider } from "@vex-agent/inference/registry.js";
import logger from "@utils/logger.js";

import {
  commitMissionStart,
  type CommitMissionStartOutcome,
} from "../../mission/commit-start.js";
import type { MissionRunContractSnapshot } from "../../mission/run-contract.js";
import {
  claimSessionLease,
} from "../../runtime/lease-and-status.js";
import {
  createLeaseHandle,
  type LeaseHandle,
} from "../../runtime/lease-handle.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";
import type { Permission } from "../../types.js";

const LEASE_TTL_MS = 5 * 60_000;

export interface PreparedMissionStart {
  readonly runId: string;
  readonly missionId: string;
  readonly sessionId: string;
  readonly mission: Mission;
  readonly contractSnapshot: MissionRunContractSnapshot;
  readonly permission: Permission;
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

export type PrepareMissionStartOutcome =
  | { readonly outcome: "prepared"; readonly prepared: PreparedMissionStart }
  | { readonly outcome: "mission_not_found" }
  | {
    readonly outcome: "session_mismatch";
    readonly expectedSessionId: string;
  }
  | {
    readonly outcome: "session_has_active_run";
    readonly missionRunId: string;
    readonly runStatus: string;
  }
  | { readonly outcome: "session_not_found" }
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
  | {
    readonly outcome: "lease_busy";
    readonly currentLease: RunnerLease;
  }
  | { readonly outcome: "provider_unavailable" };

export interface PrepareMissionStartInput {
  readonly missionId: string;
  /**
   * Host-supplied session id. IPC callers MUST pass this; engine
   * rejects with `session_mismatch` if it doesn't match the mission
   * row's `rootSessionId`. Non-IPC callers (tests / direct
   * engine consumers) may omit it — engine then uses the row's
   * `rootSessionId` as the canonical session id and skips the
   * cross-session ownership check (there is no foreign id to compare
   * against).
   */
  readonly sessionId?: string;
}

export async function prepareMissionStart(
  input: PrepareMissionStartInput,
): Promise<PrepareMissionStartOutcome> {
  // 1. Mission ownership check — plain read first. Cross-session
  //    rejection only applies when the caller passes a `sessionId`
  //    (hostile-renderer path). Non-IPC callers without a session id
  //    take the mission row's own `rootSessionId` as canonical.
  const preflight = await getMission(input.missionId);
  if (!preflight) return { outcome: "mission_not_found" };
  if (
    input.sessionId !== undefined
    && preflight.rootSessionId !== input.sessionId
  ) {
    return {
      outcome: "session_mismatch",
      expectedSessionId: preflight.rootSessionId,
    };
  }
  const sessionId = preflight.rootSessionId;

  // 2. Session-level active/paused run gate (1st, before provider).
  const active1 = await missionRunsRepo.getActiveRunBySession(sessionId);
  if (active1 !== null) {
    return {
      outcome: "session_has_active_run",
      missionRunId: active1.id,
      runStatus: active1.status,
    };
  }

  // 3. Provider/config.
  const provider = await resolveProvider();
  if (!provider) return { outcome: "provider_unavailable" };
  const config = await provider.loadConfig();
  if (!config) return { outcome: "provider_unavailable" };

  // 4. Lease claim.
  const ownerId = `start-mission-${input.missionId}-${randomUUID().slice(0, 8)}`;
  const claim = await claimSessionLease({
    sessionId: sessionId,
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

  // ── LEASE OWNERSHIP BOUNDARY ─────────────────────────────────────
  //
  // `createLeaseHandle` above armed a RENEWING heartbeat. From here on the
  // handle has exactly one owner at every instant, and the `finally` below is
  // what guarantees it: unless ownership is explicitly transferred to the
  // prepared continuation, the lease is released on the way out — return AND
  // throw alike.
  //
  // Before this guard the refusal paths released but a THROW did not, and a
  // leaked heartbeat is worse than a leaked lease: the interval keeps renewing
  // `expires_at`, so the row never lapses, no TTL sweep can reclaim it, and the
  // session stays blocked for the life of the process. Two fallible reads and
  // the commit sat in that window. Same defect class as the operator-stop
  // continuation leak.
  //
  // Do NOT add fallible IO after the transfer flag is set.
  let leaseOwnershipTransferred = false;
  try {
    // 5. Session-level active/paused run gate (2nd, post-claim race window).
    const active2 = await missionRunsRepo.getActiveRunBySession(sessionId);
    if (active2 !== null) {
      return {
        outcome: "session_has_active_run",
        missionRunId: active2.id,
        runStatus: active2.status,
      };
    }

    // 6. Session permission read (fallible — must run BEFORE commit).
    const session = await sessionsRepo.getSession(sessionId);
    if (!session) {
      return { outcome: "session_not_found" };
    }
    const permission = session.permission;

    // 7. Atomic commitMissionStart. After this step, NO fallible IO
    //    before the prepared return.
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const commit: CommitMissionStartOutcome = await commitMissionStart({
      missionId: input.missionId,
      runId,
    });
    if (commit.outcome !== "committed") {
      return mapCommitOutcomeToPrepareOutcome(commit);
    }

    logger.info("engine.mission.prepare_start.committed", {
      missionId: input.missionId,
      sessionId,
      runId: commit.runId,
    });

    // 8. Pure construction. The transfer flag is set LAST, immediately before
    //    the return, so nothing between here and the caller can throw with
    //    ownership already surrendered.
    const prepared: PreparedMissionStart = {
      runId: commit.runId,
      missionId: input.missionId,
      sessionId,
      mission: commit.mission,
      contractSnapshot: commit.contractSnapshot,
      permission,
      sessionLease,
      provider,
      config,
    };
    leaseOwnershipTransferred = true;
    return { outcome: "prepared", prepared };
  } finally {
    if (!leaseOwnershipTransferred) {
      // Best-effort: a failing release must not mask the original throw, and
      // the handle's own `release()` is idempotent and already swallows its
      // DB errors — the heartbeat is stopped either way.
      await releaseLeaseAndEmitControlState(sessionLease, sessionId, {
        missionRunId: null,
      }).catch(() => undefined);
    }
  }
}

function mapCommitOutcomeToPrepareOutcome(
  commit: Exclude<CommitMissionStartOutcome, { outcome: "committed" }>,
): PrepareMissionStartOutcome {
  switch (commit.outcome) {
    case "mission_not_found":
      return { outcome: "mission_not_found" };
    case "not_accepted":
      return { outcome: "not_accepted", missionId: commit.missionId };
    case "stale_acceptance":
      return {
        outcome: "stale_acceptance",
        currentHash: commit.currentHash,
        acceptedHash: commit.acceptedHash,
      };
    case "plan_not_accepted":
      return { outcome: "plan_not_accepted", missionId: commit.missionId };
    case "not_ready":
      return {
        outcome: "not_ready",
        missingFields: commit.missingFields,
      };
    case "active_run_exists":
      return {
        outcome: "active_run_exists",
        missionRunId: commit.missionRunId,
        runStatus: commit.runStatus,
      };
  }
}
