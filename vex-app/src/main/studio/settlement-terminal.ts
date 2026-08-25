/**
 * Main-side wrapper over the engine's single terminal-state predicate.
 *
 * The definition itself lives in
 * `src/vex-agent/engine/core/approval-runtime/studio/terminal-state.ts` and is
 * imported from that module directly, not through the approval-runtime barrel:
 * the barrel pulls the database client into main's static graph, and this file
 * is loaded by the broker, which must stay free of it.
 */

import type { StudioSettlementRow } from "@vex-agent/db/repos/approval-intents.js";
import { isTerminalStudioState } from "@vex-agent/engine/core/approval-runtime/studio/terminal-state.js";

/**
 * `true` when nothing can still run for this row, so an answer may be given to
 * a blocked external call. `approved/not_started` and `approved/dispatching`
 * are deliberately NOT terminal - see the engine module's header.
 */
export function isTerminalStudioRow(row: StudioSettlementRow): boolean {
  return isTerminalStudioState({
    decision: row.decision,
    executionStatus: row.executionStatus,
  });
}
