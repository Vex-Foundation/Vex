/**
 * Knowledge repo — lineage browse (read-only).
 *
 * getLineageChain(id): walk the version chain in BOTH directions from any
 * id (down via supersedes_id to root, up via reverse self-join to head)
 * and return ordered metadata plus head info. One round-trip via two
 * recursive CTEs combined into a single ordered result set.
 *
 * Does not return content_md, embedding, or content_hash — payload is
 * deliberately compact so chains stay cheap. Callers that need the full
 * body fall back to `getById` (which is what `MemoryGet` exposes).
 */

import { query } from "../../client.js";
import type {
  KnowledgeLineageItem,
  KnowledgeLineageResult,
} from "./types.js";
import type { KnowledgeStatus } from "@vex-agent/knowledge/policy.js";

// Hard cap on recursion depth. Real chains will be <10 in practice; this is a
// safety net so a malformed cycle (shouldn't be possible — supersedes_id is a
// FK with the partial unique index — but defense in depth) cannot blow up
// with an unbounded recursion.
const MAX_LINEAGE_HOPS = 100;

interface LineageRow {
  id: number;
  kind: string;
  title: string;
  status: string;
  supersedes_id: number | null;
  status_reason: string | null;
  change_summary: string | null;
  what_failed: string | null;
  valid_from: string;
  valid_until: string | null;
  updated_at: string;
  pos: number;
}

/**
 * Return the full version chain (root → head) for the entry referenced by `id`,
 * regardless of where in the chain `id` sits. Returns null if no entry with
 * that id exists.
 *
 * The ordered chain is built in a single SQL round-trip via two recursive
 * CTEs — one walking predecessors via `supersedes_id`, one walking successors
 * via the reverse self-join enabled by `idx_ke_supersedes_id` (partial unique).
 * A `pos` column lets us sort the union into root-first order without a
 * second pass in TS.
 */
export async function getLineageChain(id: number): Promise<KnowledgeLineageResult | null> {
  if (!Number.isFinite(id) || id <= 0) return null;

  const rows = await query<LineageRow>(
    `WITH RECURSIVE
       down AS (
         SELECT k.id, k.kind, k.title, k.status, k.supersedes_id, k.status_reason,
                k.change_summary, k.what_failed, k.valid_from, k.valid_until, k.updated_at,
                0 AS hop
         FROM knowledge_entries k WHERE k.id = $1
         UNION ALL
         SELECT k.id, k.kind, k.title, k.status, k.supersedes_id, k.status_reason,
                k.change_summary, k.what_failed, k.valid_from, k.valid_until, k.updated_at,
                d.hop + 1
         FROM knowledge_entries k
         JOIN down d ON k.id = d.supersedes_id
         WHERE d.hop < $2
       ),
       up AS (
         SELECT k.id, k.kind, k.title, k.status, k.supersedes_id, k.status_reason,
                k.change_summary, k.what_failed, k.valid_from, k.valid_until, k.updated_at,
                0 AS hop
         FROM knowledge_entries k WHERE k.id = $1
         UNION ALL
         SELECT k.id, k.kind, k.title, k.status, k.supersedes_id, k.status_reason,
                k.change_summary, k.what_failed, k.valid_from, k.valid_until, k.updated_at,
                u.hop + 1
         FROM knowledge_entries k
         JOIN up u ON k.supersedes_id = u.id
         WHERE u.hop < $2
       )
     SELECT id, kind, title, status, supersedes_id, status_reason,
            change_summary, what_failed, valid_from, valid_until, updated_at,
            -hop AS pos
     FROM down WHERE hop > 0
     UNION ALL
     SELECT id, kind, title, status, supersedes_id, status_reason,
            change_summary, what_failed, valid_from, valid_until, updated_at,
            hop AS pos
     FROM up
     ORDER BY pos ASC`,
    [id, MAX_LINEAGE_HOPS],
  );

  if (rows.length === 0) return null;

  const chain: KnowledgeLineageItem[] = rows.map(toLineageItem);
  const head = chain[chain.length - 1]!;
  return {
    requestedId: id,
    headId: head.id,
    headStatus: head.status,
    chain,
  };
}

function toLineageItem(r: Omit<LineageRow, "pos">): KnowledgeLineageItem {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    status: r.status as KnowledgeStatus,
    supersedesId: r.supersedes_id,
    statusReason: r.status_reason,
    changeSummary: r.change_summary,
    whatFailed: r.what_failed,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    updatedAt: r.updated_at,
  };
}

// Re-export the constant used by tests that need to reason about the same
// cap without duplicating it.
export { MAX_LINEAGE_HOPS };
