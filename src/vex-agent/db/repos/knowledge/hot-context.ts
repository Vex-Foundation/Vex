/**
 * Knowledge repo — hot-context listings for prompt composition.
 *
 * Small, non-vector SELECTs used by the engine to hydrate the system prompt
 * with a tail of currently-active entries (by recency / pinned-first) and the
 * set of `kind` values that actually exist in the DB. Neither touches
 * embeddings or ranking — those live in recall.ts.
 */

import type { PoolClient } from "pg";

import { getPool, query, queryWith, type Executor } from "../../client.js";
import type {
  ActiveKnowledgeListItem,
  KnownKind,
  ListActiveOptions,
  ListKnownKindsOptions,
} from "./types.js";

/**
 * Hot-context filter: only `observed` + `user_confirmed` entries are eligible
 * for Active Memory auto-injection. `inferred` + `hypothesis` remain
 * recallable via `MemorySearch` but never enter the always-on prompt.
 * See migration 018 for the partial index supporting this filter.
 *
 * Maturity gate (S4/§949 + S6a/§11.6): a freshly-promoted lesson starts
 * `probationary` and is NEVER hot-context — it must mature (S6) before it can
 * auto-inject; a `decayed` lesson has eroded out of the always-on prompt and must
 * NOT dominate hot context (genesis §725). Both are excluded here. The source
 * filter alone is insufficient: a probationary/decayed entry promoted with
 * `source='observed'` would otherwise pass the source check and leak into the
 * always-on prompt. Recurrence reactivation (S6a) lifts a `decayed` entry back to
 * `established` → it becomes hot-context-eligible again. Excluding both states
 * enforces the genesis invariant that probationary / decayed / inferred-hypothesis
 * knowledge stays out of hot context.
 */
const HOT_CONTEXT_SOURCE_SQL =
  "source IN ('observed', 'user_confirmed') AND maturity_state NOT IN ('probationary', 'decayed')";

export async function listActiveForHotContext(
  opts: ListActiveOptions,
): Promise<ActiveKnowledgeListItem[]> {
  const rows = await query<{
    id: number;
    kind: string;
    title: string;
    summary: string;
    pinned: boolean;
    valid_until: string | null;
    updated_at: string;
  }>(
    `SELECT id, kind, title, summary, pinned, valid_until, updated_at
     FROM knowledge_entries
     WHERE status = 'active'
       AND ${HOT_CONTEXT_SOURCE_SQL}
       AND (pinned = TRUE OR valid_until > now())
     ORDER BY pinned DESC, updated_at DESC
     LIMIT $1`,
    [opts.limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    pinned: r.pinned,
    validUntil: r.valid_until,
    updatedAt: r.updated_at,
  }));
}

export async function listKnownKinds(opts: ListKnownKindsOptions): Promise<KnownKind[]> {
  const rows = await query<{ kind: string; n: string }>(
    `SELECT kind, count(*) AS n
     FROM knowledge_entries
     WHERE status = 'active'
       AND ${HOT_CONTEXT_SOURCE_SQL}
     GROUP BY kind
     ORDER BY n DESC
     LIMIT $1`,
    [opts.limit],
  );
  return rows.map((r) => ({ kind: r.kind, count: parseInt(r.n, 10) }));
}

/**
 * Judge Context v2 (§10.6): the FULL active-kind census for the judge prompt.
 * Deliberately NOT filtered by `HOT_CONTEXT_SOURCE_SQL` — the judge needs to
 * see every kind in use (including probationary / hypothesis-tier lessons) to
 * keep the kind taxonomy converging instead of forking near-synonyms.
 * Separate from `listKnownKinds`, whose hot-context consumer must stay
 * source/maturity-filtered. Ties broken alphabetically for stable rendering.
 */
export async function listActiveKindCounts(
  limit: number,
  client?: PoolClient,
): Promise<KnownKind[]> {
  const exec: Executor = client ?? getPool();
  const rows = await queryWith<{ kind: string; n: number }>(
    exec,
    `SELECT kind, count(*)::int AS n
     FROM knowledge_entries
     WHERE status = 'active'
     GROUP BY kind
     ORDER BY n DESC, kind ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ kind: r.kind, count: r.n }));
}

/** Active count for system prompt banner. Excludes non-hot sources. */
export async function countActiveHotContextEntries(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n
     FROM knowledge_entries
     WHERE status = 'active'
       AND ${HOT_CONTEXT_SOURCE_SQL}`,
  );
  return rows[0] ? parseInt(rows[0].n, 10) : 0;
}
