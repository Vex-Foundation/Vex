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
 *   6b. Start capital baseline (fallible IO, fail-open) - the last
 *      step before the transaction, for the same reason as #6.
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
  absentBaseline,
  buildMissionBaseline,
  type MissionBaseline,
} from "../../mission/baseline.js";
import {
  commitMissionStart,
  type CommitMissionStartOutcome,
} from "../../mission/commit-start.js";
import { missionToDraft } from "../../mission/mapper.js";
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
  | { readonly outcome: "provider_unavailable" }
  /**
   * A SESSION-scoped operator Stop was outstanding when the run-creation
   * transaction ran. The run was NOT created — a run committed after a Stop is
   * unreachable by that Stop, because the run-scoped gate matches on
   * `mission_run_id` and never finds a NULL-scoped request.
   *
   * The gate consumed the stop in the same transaction, so this is "your Stop
   * landed first, start again" and a retry proceeds normally.
   */
  | { readonly outcome: "session_stop_pending" };

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

    // 6b. START BASELINE (contract C3). The ONE sanctioned seam: fallible IO
    //     must precede `commitMissionStart`, which is DB-only under the session
    //     control lock (see step 7 and the `commit-start.ts` header). FAIL-OPEN
    //     by construction: `buildMissionBaseline` never throws and never returns
    //     a refusal, so a valuation problem records an absent baseline with a
    //     named reason instead of blocking a mission the user asked to start.
    //     The try/catch is suspenders to the module's belt: if that contract
    //     ever regresses, a balance read still cannot refuse a mission start.
    //
    //     Read from the UNLOCKED preflight row, which is safe because both
    //     inputs are canonical contract material: `allowedWallets` and
    //     `deployedCapital` are both hashed. If either drifted between this
    //     read and the commit, the commit's rehash refuses with
    //     `stale_acceptance` and this baseline is discarded unwritten.
    let baseline: MissionBaseline;
    try {
      baseline = await buildMissionBaseline({
        missionId: input.missionId,
        allowedWallets: preflight.allowedWallets,
        deployedCapital: missionToDraft(preflight).deployedCapital,
      });
    } catch (err) {
      logger.warn("engine.mission.baseline.build_rejected", {
        missionId: input.missionId,
        error: err instanceof Error ? err.name : "unknown",
      });
      baseline = absentBaseline("valuation_failed");
    }
    logger.info("engine.mission.baseline.captured", {
      missionId: input.missionId,
      runIdPending: true,
      status: baseline.status,
      reasons: baseline.reasons,
    });

    // 7. Atomic commitMissionStart. After this step, NO fallible IO
    //    before the prepared return.
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const commit: CommitMissionStartOutcome = await commitMissionStart({
      missionId: input.missionId,
      runId,
      baseline,
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
    case "session_stop_pending":
      return { outcome: "session_stop_pending" };
  }
}
