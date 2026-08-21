/**
 * MemoryHistory handler (S3) — the supersession/lineage chain for a
 * long-term memory entry COMBINED with its reinforcement timeline.
 *
 * R1-#7: the lineage repo (`getLineageChain`) returns compact lineage only, so
 * the handler ALSO fetches the entry (`getById`) and merges its reinforcement
 * fields (`firstPromotedAt` / `lastReinforcedAt` / `outcomeVersion`) into the
 * S3 history DTO — NO repo change. One round-trip each; both are indexed lookups.
 *
 * Read-only. Does NOT inject into loadedDocuments (metadata navigation, not a
 * content load). Does NOT require the embeddings service.
 */

import * as knowledgeRepo from "@vex-agent/db/repos/knowledge.js";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { num, ok, fail, missingOrWrongTypeMessage } from "../types.js";

export async function handleLongMemoryHistory(
  params: Record<string, unknown>,
  _context: InternalToolContext,
): Promise<ToolResult> {
  const id = num(params, "id");
  if (id === undefined) {
    return fail(missingOrWrongTypeMessage(params, "id", "a number (the entry id from MemorySearch)"));
  }

  const lineage = await knowledgeRepo.getLineageChain(id);
  if (!lineage) {
    return fail(
      `long-term memory entry ${id} not found. Re-run MemorySearch to find a valid id.`,
    );
  }

  // R1-#7: merge the entry's reinforcement timeline. Fetch the requested id (not
  // the head) so the reinforcement fields belong to the entry the agent asked
  // about; null when the row vanished between the two reads (concurrent delete).
  const entry = await knowledgeRepo.getById(id);
  const reinforcement = entry
    ? {
        firstPromotedAt: entry.firstPromotedAt,
        lastReinforcedAt: entry.lastReinforcedAt,
        outcomeVersion: entry.outcomeVersion,
        maturityState: entry.maturityState,
      }
    : null;

  return ok({
    requestedId: lineage.requestedId,
    headId: lineage.headId,
    headStatus: lineage.headStatus,
    chainLength: lineage.chain.length,
    chain: lineage.chain,
    reinforcement,
  });
}
