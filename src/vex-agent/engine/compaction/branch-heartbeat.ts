/**
 * Branch lease heartbeat + claim-loss flag, shared by both branch workers.
 *
 * The heartbeat is what tells stale recovery this worker is alive; the
 * claim-loss flag is what stops it spending money after recovery decided it
 * was not. Both workers need exactly this, so it lives in one named module
 * rather than being copied into each loop.
 *
 * A DB/network hiccup does NOT flip the flag — transient is not owner loss.
 * Only an owner-checked `false` from the repo does, and the flag never flips
 * back: a lease this worker lost cannot become its lease again.
 */

import {
  BRANCH_HEARTBEAT_INTERVAL_MS,
  branchHeartbeat,
  type Branch,
} from "../../db/repos/compaction-preparations/index.js";
import logger from "@utils/logger.js";

export interface BranchLeaseHeartbeat {
  /** True once the repo reported this worker no longer owns the branch lease. */
  isClaimLost(): boolean;
  stop(): void;
}

export function startBranchHeartbeat(
  preparationId: number,
  branch: Branch,
  workerId: string,
): BranchLeaseHeartbeat {
  let claimLost = false;
  let warnedFailure = false;

  const timer = setInterval(() => {
    void (async () => {
      try {
        const ok = await branchHeartbeat(preparationId, branch, workerId);
        if (!ok && !claimLost) {
          claimLost = true;
          logger.warn("compaction-prep.claim_lost", {
            preparationId,
            branch,
            workerId,
          });
        }
      } catch (err) {
        // One log per failure streak: a long DB outage would otherwise emit a
        // line every heartbeat interval and bury the real signal.
        if (warnedFailure) return;
        warnedFailure = true;
        logger.warn("compaction-prep.heartbeat_failed", {
          preparationId,
          branch,
          workerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, BRANCH_HEARTBEAT_INTERVAL_MS);

  return {
    isClaimLost: () => claimLost,
    stop: () => clearInterval(timer),
  };
}
