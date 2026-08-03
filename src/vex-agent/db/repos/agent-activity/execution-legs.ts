/**
 * `agent_activity` reads that answer "what did VEX do for this execution?".
 *
 * Own module, not another function on `swap-lifecycle/reads.ts` or
 * `watch-reads.ts`: this file changes when a READ SURFACE needs to show the
 * agent Vex's own view of a provider-tracked operation, which is a different
 * reason to change than the repair sweep's candidate sets or a wake-watch
 * identifier resolution.
 *
 * Read-only. Every row of an execution is returned, in `event_index` order —
 * that ordering IS the leg sequence (allowance → deposit → fee → expected
 * fill), so a caller can render it without re-deriving the order.
 */

import { query } from "../../client.js";
import { mapRow } from "./mappers.js";
import type { AgentActivityEvent } from "./types.js";

export async function listActivityLegsByExecutionId(
  protocolExecutionId: number,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE protocol_execution_id = $1
      ORDER BY event_index ASC`,
    [protocolExecutionId],
  );
  return rows.map(mapRow);
}
