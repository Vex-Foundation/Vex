/**
 * `agent_activity` reads that exist for the `LoopDefer` WATCH surface.
 *
 * Own module, not another function on `swap-lifecycle/reads.ts`: this file
 * changes when a wake-watch condition needs to resolve a model-supplied
 * identifier to a row, which is a different reason to change than the repair
 * sweep's candidate sets or the Agent Scan feed page.
 *
 * These are strictly READ-ONLY lookups used at watch-VALIDATION time. The watch
 * TRIGGER path never reads the DB at all — the canonical condition carries the
 * resolved row id, and the pending-activity bus already carries that id, so a
 * resolved row promotes its wake without a query.
 */

import { queryOne } from "../../client.js";
import { mapRow } from "./mappers.js";
import type { AgentActivityEvent } from "./types.js";

/**
 * Resolve the provider order id the model holds (it is what `BridgeStatus`
 * takes and what the bridge execute tools return) to its `agent_activity` row.
 *
 * Deliberately NOT filtered to `status = 'pending'`: a caller that must
 * distinguish "unknown order" from "already settled" cannot do so once the
 * query has collapsed both to `null`, and telling the model "that bridge is
 * already resolved — read it now" is a materially different instruction from
 * "that order id does not exist".
 */
export async function findActivityByProviderOrderId(
  providerOrderId: string,
): Promise<AgentActivityEvent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE provider_order_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [providerOrderId],
  );
  return row ? mapRow(row) : null;
}
