/**
 * Approvals IPC handlers — pending/get/history are read-only (allow-listed
 * DTOs only, raw `tool_call` JSONB never crosses the boundary).
 *
 * Puzzle 5 phase 3 — `approve` and `reject` are now wired. Each handler:
 *
 *   1. Calls `ensureEngineDbUrl(ctx.requestId)` so the lazy `pg` pool used
 *      by the engine reaches the same Postgres the read handlers'
 *      `withClient` paths already use (mission/start.ts pattern).
 *   2. Runs the bounded prepare path (`prepareApprove` / `prepareReject`):
 *      decision tx + post-tx side effects (dispatch / tool-result /
 *      lease+flip) + an opaque `PreparedContinuation` if a mission-run
 *      resume needs to happen in the background.
 *   3. Fires the continuation via `dispatchPreparedMission` (background)
 *      so the IPC handler returns immediately — Codex puzzle-5 phase-3
 *      review point 5: no blocking the renderer on a full resumed loop.
 *
 * A 5-minute scheduled cycle runs TWO passes (one timer, not two): the TTL
 * sweep auto-rejects expired approvals even without operator action, and the
 * lifecycle reconciler finishes anything a crash or a lost lease race left
 * half-done. The first cycle fires right after registration so a fresh app boot
 * doesn't display a stale-pending card.
 *
 * Submodules:
 *   - `./approvals/read.ts`           — list/get/history handler registrations.
 *   - `./approvals/decision.ts`       — approve/reject handler registrations.
 *   - `./approvals/_errors.ts`        — phase-3 `VexError` builders.
 *   - `./approvals/_map-outcomes.ts`  — outcome union → `Result` mapping.
 *   - `./approvals/_sweep.ts`         — scheduled TTL sweep + reconciler pass.
 */

import {
  registerGetHandler,
  registerGetHistoryHandler,
  registerListPendingAllHandler,
  registerListPendingHandler,
} from "./approvals/read.js";
import {
  registerApproveHandler,
  registerRejectHandler,
} from "./approvals/decision.js";
import { runScheduledSweep } from "./approvals/_sweep.js";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function registerApprovalsHandlers(): ReadonlyArray<() => void> {
  const cleanups: Array<() => void> = [
    registerListPendingHandler(),
    registerListPendingAllHandler(),
    registerGetHandler(),
    registerGetHistoryHandler(),
    registerApproveHandler(),
    registerRejectHandler(),
  ];

  // Phase 3 scheduled TTL sweep — first cycle fires right after
  // registration (background, doesn't block boot), then every
  // SWEEP_INTERVAL_MS. Cleanup function on the handlers array clears the
  // interval on disposal.
  void runScheduledSweep();
  const sweepIntervalId = setInterval(() => {
    void runScheduledSweep();
  }, SWEEP_INTERVAL_MS);
  cleanups.push(() => clearInterval(sweepIntervalId));

  return cleanups;
}
