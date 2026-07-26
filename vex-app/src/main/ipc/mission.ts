/**
 * Thin facade — mission IPC handlers (puzzle 04 phase 6).
 *
 * Implementation lives under `./mission/` with one module per
 * handler, mirroring `./runtime/` layout. This shim preserves the
 * existing `./mission.js` import path used by `register-all.ts` and
 * the puzzle-1 handlers tests — Node ESM `NodeNext` does NOT
 * auto-resolve a `.js` import to a sibling directory's `index.ts`,
 * so the shim is required.
 *
 * Phase 6 ships:
 *   - get-draft.ts         (read-only DB)
 *   - accept-contract.ts   (engine acceptContract)
 *   - get-diff.ts          (engine getContractStatus)
 *   - renew.ts             (engine renewMission)
 *   - start.ts             (prepareMissionStart + fire-and-forget)
 *   - continue.ts          (shared resume dispatcher)
 *   - recover.ts           (prepareMissionRecover + fire-and-forget)
 *   - stop.ts              (shared stop dispatcher)
 *   - update-draft.ts      (fail-closed, lands with the form in phase 7+)
 */

export { registerMissionHandlers } from "./mission/index.js";
