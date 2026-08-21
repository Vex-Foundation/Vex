/**
 * Knowledge repo — CRUD core (insert, fetch, reconcile status writes).
 *
 * Portability contract (also enforced in recall.ts):
 * - The vector column has NO typmod, so the type accepts any dim. Per-row
 *   `embedding_dim` and `embedding_model` are authoritative.
 * - `content_hash` is the UNIQUE idempotency key. `insertEntry` returns
 *   `{ entry, inserted }` so callers can distinguish a new write from a
 *   no-op duplicate. Metadata is NEVER silently merged on conflict — the
 *   existing row is returned untouched.
 *
 * Transaction coordination (PR4 Fase I.b):
 * - `insertEntry` accepts an optional `PoolClient`. When provided, the
 *   INSERT runs inside the caller's transaction instead of on the shared
 *   pool. `withLeaseSharedLock` (PR4 Fase II) uses this to run the write
 *   under the maintenance-lease SHARE lock so it coordinates cleanly with
 *   the reembed FOR UPDATE gate.
 * - Backward compatible: callers that don't pass a client keep the
 *   pre-PR4 behaviour (pool-backed single-query insert).
 */

import type { PoolClient } from "pg";
import {
  executeWith,
  getPool,
  queryOne,
  queryOneWith,
  queryWith,
  type Executor,
} from "../../client.js";
import { jsonb } from "../../params.js";
import type { KnowledgeStatus } from "@vex-agent/knowledge/policy.js";
import type { KnowledgeSource } from "@vex-agent/memory/long-memory-source-policy.js";
import type { DecayPolicy, MaturityState } from "@vex-agent/memory/schema/long-memory-enums.js";
import {
  type InsertEntryInput,
  type InsertEntryResult,
  type KnowledgeEntry,
  type KnowledgeEntryWithLineage,
  type KnowledgeRow,
  type KnowledgeRowWithInsertFlag,
  mapRow,
  toIsoOrNull,
  vectorLiteral,
} from "./types.js";

// ── Insert (idempotent upsert by content_hash) ───────────────────

/**
 * Insert a knowledge entry, idempotent on `content_hash`.
 *
 * - If no row with this `content_hash` exists, INSERT it and return
 *   `{ entry, inserted: true }`.
 * - If a row with this `content_hash` already exists, return
 *   `{ entry: <existing row>, inserted: false }` — the existing row is
 *   NOT modified. Metadata is intentionally immutable on conflict; callers
 *   that want to change tags/pinned/etc. must use a separate update tool.
 *
 * Optional audit fields (`status`, `validFrom`, `createdAt`, `updatedAt`) let
 * the import script preserve roundtrip exactness. The promotion path does not
 * pass them, so defaults (`'active'`, `NOW()`) apply.
 *
 * Implementation note: a CTE (rather than the xmax trick) is used to detect
 * insert vs. existing. ON CONFLICT DO NOTHING + RETURNING returns rows only
 * for inserts; the second branch SELECTs the existing row.
 */
export async function insertEntry(
  input: InsertEntryInput,
  client?: PoolClient,
): Promise<InsertEntryResult> {
  if (input.embedding.length !== input.embeddingDim) {
    throw new Error(
      `insertEntry: embedding length ${input.embedding.length} does not match embeddingDim ${input.embeddingDim} ` +
        `(content_hash=${input.contentHash}). The DB CHECK constraint would reject this.`,
    );
  }

  const exec: Executor = client ?? getPool();
  const row = await queryOneWith<KnowledgeRowWithInsertFlag>(
    exec,
    `WITH ins AS (
       INSERT INTO knowledge_entries (
         kind, title, summary, content_md, tags, source_refs,
         confidence, status, pinned, valid_from, valid_until,
         content_hash, embedding_model, embedding_dim, embedding,
         source_surface, source_session,
         supersedes_id, status_reason, change_summary, what_failed,
         source,
         created_at, updated_at,
         maturity_state, activation_strength, influence_scope, decay_policy,
         regime_tags, first_promoted_at, last_reinforced_at, next_review_at,
         outcome_version
       )
       VALUES (
         $1, $2, $3, $4, $5, $6::jsonb,
         $7, COALESCE($8::text, 'active'), $9, COALESCE($10::timestamptz, NOW()), $11,
         $12, $13, $14, $15::vector,
         COALESCE($16::text, 'vex_agent'), $17,
         $18, $19, $20, $21,
         COALESCE($22::text, 'observed'),
         COALESCE($23::timestamptz, NOW()), COALESCE($24::timestamptz, NOW()),
         $25, $26, $27, $28,
         $29, $30::timestamptz, $31::timestamptz, $32::timestamptz,
         $33
       )
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING *
     )
     SELECT *, true AS inserted FROM ins
     UNION ALL
     SELECT k.*, false AS inserted FROM knowledge_entries k
       WHERE k.content_hash = $12 AND NOT EXISTS (SELECT 1 FROM ins)`,
    [
      input.kind,
      input.title,
      input.summary,
      input.contentMd,
      input.tags,
      jsonb(input.sourceRefs),
      input.confidence,
      input.status ?? null,
      input.pinned,
      toIsoOrNull(input.validFrom),
      input.validUntil ? input.validUntil.toISOString() : null,
      input.contentHash,
      input.embeddingModel,
      input.embeddingDim,
      vectorLiteral(input.embedding),
      input.sourceSurface ?? null,
      input.sourceSession ?? null,
      input.supersedesId ?? null,
      input.statusReason ?? null,
      input.changeSummary ?? null,
      input.whatFailed ?? null,
      input.source ?? null,
      toIsoOrNull(input.createdAt),
      toIsoOrNull(input.updatedAt),
      // ── Memory v2: default in TS to the SAME values as the DB column defaults
      // so callers that omit these are byte-for-byte behavior-neutral.
      input.maturityState ?? "established",
      input.activationStrength ?? 1.0,
      input.influenceScope ?? "advisory",
      input.decayPolicy ?? "none",
      input.regimeTags ?? [],
      input.firstPromotedAt ? input.firstPromotedAt.toISOString() : null,
      input.lastReinforcedAt ? input.lastReinforcedAt.toISOString() : null,
      input.nextReviewAt ? input.nextReviewAt.toISOString() : null,
      input.outcomeVersion ?? 0,
    ],
  );
  if (!row) throw new Error("knowledge_entries upsert returned no row");
  const { inserted, ...rest } = row;
  return { entry: mapRow(rest as KnowledgeRow), inserted };
}

// ── Get by ID ────────────────────────────────────────────────────

/**
 * Fetch an entry by id together with the reverse lineage link (`supersededBy`).
 *
 * The reverse link is resolved via a LEFT JOIN on the partial unique index
 * `idx_ke_supersedes_id` — one extra indexed lookup, single round-trip. Returns
 * `supersededBy: null` when no successor exists (i.e. this row is current or
 * terminal — `active`, `invalidated`, `archived`, or a leaf of a superseded chain).
 */
export async function getById(id: number): Promise<KnowledgeEntryWithLineage | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = await queryOne<KnowledgeRow & { superseded_by: number | null }>(
    `SELECT k.*, succ.id AS superseded_by
     FROM knowledge_entries k
     LEFT JOIN knowledge_entries succ ON succ.supersedes_id = k.id
     WHERE k.id = $1`,
    [id],
  );
  if (!row) return null;
  const { superseded_by, ...baseRow } = row;
  return { ...mapRow(baseRow as KnowledgeRow), supersededBy: superseded_by };
}

// ── Find by content hash ─────────────────────────────────────────

export async function findByContentHash(hash: string): Promise<KnowledgeEntry | null> {
  if (!hash) return null;
  const row = await queryOne<KnowledgeRow>(
    "SELECT * FROM knowledge_entries WHERE content_hash = $1",
    [hash],
  );
  return row ? mapRow(row) : null;
}

// ── Maturity FSM transition (S6a/S6b) ────────────────────────────

/** Active-entry row needed by the maturity manager (decay sweep / reinforcement input). */
export interface MaturityEntryRow {
  id: number;
  maturityState: MaturityState;
  activationStrength: number;
  decayPolicy: DecayPolicy;
  /** Closed-vocab regime tags (S6b — `ke_regime_tags_valid`); drive match/mismatch decay. */
  regimeTags: string[];
  firstPromotedAt: string | null;
  lastReinforcedAt: string | null;
  /**
   * When a decay step was last APPLIED — the INCREMENTAL decay anchor (S6b).
   * Each decay erodes only the quantum since max(lastReinforcedAt,
   * lastDecayedAt); without it a sweep re-run would re-apply the FULL
   * since-reinforcement factor to the already-decayed value (compounding).
   */
  lastDecayedAt: string | null;
}

// Shared row shape + mapper for the three maturity reads below (rules/10 §17:
// 3 uses → one source of truth; adding a column means editing ONE list).
interface MaturityRow {
  id: number;
  maturity_state: string;
  activation_strength: number;
  decay_policy: string;
  regime_tags: string[] | null;
  first_promoted_at: string | null;
  last_reinforced_at: string | null;
  last_decayed_at: string | null;
}

const MATURITY_ENTRY_COLUMNS = `id, maturity_state, activation_strength, decay_policy,
            regime_tags, first_promoted_at, last_reinforced_at, last_decayed_at`;

function mapMaturityRow(row: MaturityRow): MaturityEntryRow {
  return {
    id: row.id,
    maturityState: row.maturity_state as MaturityState,
    activationStrength: row.activation_strength,
    decayPolicy: row.decay_policy as DecayPolicy,
    regimeTags: row.regime_tags ?? [],
    firstPromotedAt: row.first_promoted_at,
    lastReinforcedAt: row.last_reinforced_at,
    lastDecayedAt: row.last_decayed_at,
  };
}

/**
 * Apply a maturity/activation transition to ONE knowledge entry (S6a/S6b).
 * Updates `activation_strength` + `maturity_state`, optionally bumps
 * `last_reinforced_at` (reinforcement / reactivation — NEVER on plain decay or
 * recall) and/or `last_decayed_at` (an APPLIED decay step — the incremental
 * decay anchor; never on reinforcement), and stamps `updated_at`. Guarded on
 * `status = 'active'` (the FSM only touches live lessons)
 * AND on the CURRENT maturity/activation values so a concurrent transition is a
 * no-op precondition miss, never a lost update. The maturity FSM NEVER deletes a
 * row — decay floors activation > 0. Runs in the caller's tx when a client is
 * passed (reinforcement records its audit row in the SAME tx).
 *
 * Returns `true` iff the row transitioned (matched id+status+precondition);
 * `false` means the precondition no longer holds (already transitioned / not
 * active) — the caller must NOT then write an audit row.
 */
export async function applyMaturityTransition(
  args: {
    entryId: number;
    expectedMaturityState: MaturityState;
    expectedActivation: number;
    nextMaturityState: MaturityState;
    nextActivation: number;
    bumpLastReinforcedAt: boolean;
    bumpLastDecayedAt: boolean;
  },
  client?: PoolClient,
): Promise<boolean> {
  if (!Number.isFinite(args.entryId) || args.entryId <= 0) return false;
  const exec: Executor = client ?? getPool();
  const setReinforced = args.bumpLastReinforcedAt ? ", last_reinforced_at = NOW()" : "";
  const setDecayed = args.bumpLastDecayedAt ? ", last_decayed_at = NOW()" : "";
  const count = await executeWith(
    exec,
    `UPDATE knowledge_entries
        SET activation_strength = $1,
            maturity_state = $2,
            updated_at = NOW()${setReinforced}${setDecayed}
      WHERE id = $3
        AND status = 'active'
        AND maturity_state = $4
        AND activation_strength = $5`,
    [
      args.nextActivation,
      args.nextMaturityState,
      args.entryId,
      args.expectedMaturityState,
      args.expectedActivation,
    ],
  );
  return count === 1;
}

/**
 * Fetch ONE active entry's maturity inputs by id (FOR UPDATE-lockable via the
 * caller's tx). Returns null when the row is absent or non-active. Used by the
 * reinforcement seam to resolve the current FSM state of the entry a candidate
 * confirms.
 */
export async function getMaturityEntry(
  entryId: number,
  client?: PoolClient,
): Promise<MaturityEntryRow | null> {
  if (!Number.isFinite(entryId) || entryId <= 0) return null;
  const exec: Executor = client ?? getPool();
  const row = await queryOneWith<MaturityRow>(
    exec,
    `SELECT ${MATURITY_ENTRY_COLUMNS}
       FROM knowledge_entries
      WHERE id = $1 AND status = 'active'`,
    [entryId],
  );
  return row ? mapMaturityRow(row) : null;
}

/**
 * Batch of active, decayable entries for the S6a decay sweep: `status='active'`
 * AND `decay_policy <> 'none'` (pinned/legacy are frozen). Ordered by id for a
 * stable, resumable scan; `afterId` pages forward (id > afterId). Read-only
 * snapshot — the sweep applies each transition with its own precondition guard,
 * so a stale read is harmless (the guarded update is the source of truth).
 */
export async function listDecayableEntries(
  args: { afterId: number; limit: number },
  client?: PoolClient,
): Promise<MaturityEntryRow[]> {
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 0;
  if (limit === 0) return [];
  const afterId = Number.isFinite(args.afterId) && args.afterId > 0 ? Math.floor(args.afterId) : 0;
  const exec: Executor = client ?? getPool();
  const rows = await queryWith<MaturityRow>(
    exec,
    `SELECT ${MATURITY_ENTRY_COLUMNS}
       FROM knowledge_entries
      WHERE status = 'active'
        AND decay_policy <> 'none'
        AND id > $1
      ORDER BY id ASC
      LIMIT $2`,
    [afterId, limit],
  );
  return rows.map(mapMaturityRow);
}

/**
 * Find the ACTIVE knowledge entry with this content_hash (reinforcement seam): a
 * candidate that is an EXACT duplicate of an active entry confirms it. Returns the
 * entry id + maturity inputs, or null when no ACTIVE row matches (a superseded /
 * archived duplicate is NOT reinforced). `idx_ke_content_hash` makes this a single
 * indexed lookup.
 */
export async function findActiveByContentHash(
  hash: string,
  client?: PoolClient,
): Promise<MaturityEntryRow | null> {
  if (!hash) return null;
  const exec: Executor = client ?? getPool();
  const row = await queryOneWith<MaturityRow>(
    exec,
    `SELECT ${MATURITY_ENTRY_COLUMNS}
       FROM knowledge_entries
      WHERE content_hash = $1 AND status = 'active'`,
    [hash],
  );
  return row ? mapMaturityRow(row) : null;
}

// ── Graph-expansion batch read (S8) ──────────────────────────────

/**
 * The recall-DTO shape `MemorySearch` needs to build a graph-expansion
 * result: identity + display text + the NEIGHBOR-side scoring inputs
 * (`source` tier, `activationStrength`) + `validUntil` for the response field.
 * NO embedding, NO contentMd — expansion results are bounded pointers; the
 * agent fetches full content via `MemoryGet`.
 */
export interface GraphNeighborEntry {
  id: number;
  kind: string;
  title: string;
  summary: string;
  source: KnowledgeSource;
  maturityState: MaturityState;
  activationStrength: number;
  validUntil: string | null;
}

/**
 * Batch-fetch ACTIVE, non-expired entries by id (S8 expansion step 4). One
 * `= ANY($1)` query — never per-entry. Applies the SAME active + non-expired
 * predicate as `recallLongMemoryTopK` (`pinned` overrides TTL), so graph
 * expansion can never resurface an entry direct recall would exclude (S3
 * invariant). Order is by id (callers re-rank by graph score).
 */
export async function getActiveEntriesByIds(
  ids: readonly number[],
  client?: PoolClient,
): Promise<GraphNeighborEntry[]> {
  if (ids.length === 0) return [];
  const exec: Executor = client ?? getPool();
  const rows = await queryWith<{
    id: number;
    kind: string;
    title: string;
    summary: string;
    source: string;
    maturity_state: string;
    activation_strength: number;
    valid_until: string | null;
  }>(
    exec,
    `SELECT id, kind, title, summary, source, maturity_state, activation_strength, valid_until
       FROM knowledge_entries
      WHERE id = ANY($1::int[])
        AND status = 'active'
        AND (pinned = TRUE OR valid_until IS NULL OR valid_until > NOW())
      ORDER BY id ASC`,
    [ids],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    source: r.source as KnowledgeSource,
    maturityState: r.maturity_state as MaturityState,
    activationStrength: r.activation_strength,
    validUntil: r.valid_until,
  }));
}

// ── Reconcile reads/writes (S7 — all inside the reconcile tx) ────

/**
 * The entry facts the reconcile tx re-validates + transitions under lock:
 * optimistic concurrency inputs (`status`, `outcomeVersion`) plus the FSM
 * (`maturityState`, `activationStrength`) and provenance tier (`source`) the
 * consequence map / tier-raise act on.
 */
export interface ReconcileEntryLock {
  id: number;
  status: KnowledgeStatus;
  source: KnowledgeSource;
  outcomeVersion: number;
  maturityState: MaturityState;
  activationStrength: number;
}

/**
 * Lock ONE knowledge entry for reconcile (S7 §4.5) — `FOR UPDATE`, ANY status
 * (the worker disambiguates inactive/stale itself; a status filter here would
 * collapse "raced to non-active" and "gone" into one null). MUST be the FIRST
 * lock the reconcile tx takes: the documented lock order is entry →
 * promoted-candidate → job row (recordDecision's coherence check re-locks the
 * job last), which shares no edge with consolidate's jobs → pending-candidate →
 * entry order (disjoint candidate sets), so no deadlock cycle exists.
 */
export async function lockEntryForReconcile(
  entryId: number,
  tx: PoolClient,
): Promise<ReconcileEntryLock | null> {
  if (!Number.isFinite(entryId) || entryId <= 0) return null;
  const row = await queryOneWith<{
    id: number;
    status: string;
    source: string;
    outcome_version: number;
    maturity_state: string;
    activation_strength: number;
  }>(
    tx,
    `SELECT id, status, source, outcome_version, maturity_state, activation_strength
       FROM knowledge_entries
      WHERE id = $1
      FOR UPDATE`,
    [entryId],
  );
  if (!row) return null;
  return {
    id: row.id,
    status: row.status as KnowledgeStatus,
    source: row.source as KnowledgeSource,
    outcomeVersion: row.outcome_version,
    maturityState: row.maturity_state as MaturityState,
    activationStrength: row.activation_strength,
  };
}

/**
 * Invalidate an entry on a reconcile flip verdict (S7 §4.5). DIRECT update —
 * a reconcile invalidation is a BI-TEMPORAL fact ("the world stopped supporting
 * this lesson NOW"), so `valid_until=NOW()` is stamped here (plain status flips
 * elsewhere do not touch valid-time). `status_reason` records the
 * judge's bounded rationale (≤ RECONCILE_RATIONALE_MAX — schema-enforced
 * upstream; never logged). Guarded on `status='active'`; recall already filters
 * to active, so the row disappears from retrieval atomically with the tx.
 */
export async function invalidateEntryOnReconcile(
  entryId: number,
  reason: string | null,
  tx: PoolClient,
): Promise<boolean> {
  const count = await executeWith(
    tx,
    `UPDATE knowledge_entries
        SET status = 'invalidated',
            status_reason = COALESCE($2, status_reason),
            valid_until = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [entryId, reason],
  );
  return count === 1;
}

/**
 * Raise an entry's provenance tier on a reconcile judge verdict (S7 F2). The
 * UPWARD-ONLY rule is enforced by the caller against the FOR UPDATE-locked
 * `ReconcileEntryLock.source` (race-free inside the same tx); this write only
 * re-guards `status='active'`. The clamp (`clampSourceTier`) ran upstream, so
 * `source` can never exceed the evidence ceiling.
 */
export async function raiseEntrySourceTier(
  entryId: number,
  source: KnowledgeSource,
  tx: PoolClient,
): Promise<boolean> {
  const count = await executeWith(
    tx,
    `UPDATE knowledge_entries
        SET source = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [entryId, source],
  );
  return count === 1;
}

/**
 * Bump `outcome_version` (S7 §4.5) — the optimistic-concurrency closing write
 * of the reconcile tx. Guarded on the CURRENT version (D-ORDER: resolve + judge
 * ran before the tx; the guard proves nothing reconciled this entry in
 * between). Deliberately NO status guard: an `invalidate` consequence flips the
 * row to non-active earlier in the SAME tx, and the bump must still land so the
 * decision audit, candidate outcome, and entry version stay in lockstep.
 */
export async function bumpOutcomeVersion(
  entryId: number,
  fromVersion: number,
  tx: PoolClient,
): Promise<boolean> {
  const count = await executeWith(
    tx,
    `UPDATE knowledge_entries
        SET outcome_version = $2 + 1, updated_at = NOW()
      WHERE id = $1 AND outcome_version = $2`,
    [entryId, fromVersion],
  );
  return count === 1;
}

