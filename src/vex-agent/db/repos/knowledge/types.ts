/**
 * Knowledge repo — row types, domain types, mappers.
 *
 * Pure-data module: interfaces + pg-row → domain conversions + small pgvector
 * serialization helpers. No imports from other submodules; everyone imports
 * from here. Prevents circular imports inside `./knowledge/`.
 */

import type { KnowledgeStatus } from "@vex-agent/knowledge/policy.js";
import type { RecallCandidate } from "@vex-agent/knowledge/ranking.js";
import type { KnowledgeSource } from "@vex-agent/memory/long-memory-source-policy.js";
import type {
  DecayPolicy,
  InfluenceScope,
  MaturityState,
} from "@vex-agent/memory/schema/long-memory-enums.js";

// ── Internal row types (not exported) ───────────────────────────

export interface KnowledgeRow {
  id: number;
  kind: string;
  title: string;
  summary: string;
  content_md: string;
  tags: string[] | null;
  source_refs: Record<string, unknown> | null;
  confidence: number | null;
  status: string;
  pinned: boolean;
  valid_from: string;
  valid_until: string | null;
  content_hash: string;
  embedding_model: string;
  embedding_dim: number;
  source_surface: string;
  source_session: string | null;
  supersedes_id: number | null;
  status_reason: string | null;
  change_summary: string | null;
  what_failed: string | null;
  /** Provenance classification — gates hot-context injection. See migration 018. */
  source: string;
  created_at: string;
  updated_at: string;
  // ── Memory v2 (influence + bi-temporal lifecycle). See 001_initial.sql. ──
  /** Lesson-confidence FSM, separate axis from `status`. CHECK ke_maturity_state_valid. */
  maturity_state: string;
  /** 0..1 reranking weight. CHECK ke_activation_strength_range. */
  activation_strength: number;
  /** advisory | retrieval_boost only. CHECK ke_influence_scope_valid. */
  influence_scope: string;
  /** none | time | regime_aware | outcome_aware. CHECK ke_decay_policy_valid. */
  decay_policy: string;
  /** Market-regime labels (NOT NULL DEFAULT '{}'); no NULL elements. */
  regime_tags: string[];
  first_promoted_at: string | null;
  last_reinforced_at: string | null;
  next_review_at: string | null;
  /** Reconciliation counter (S7). CHECK ke_outcome_version_nonneg. */
  outcome_version: number;
}

export interface KnowledgeRowWithInsertFlag extends KnowledgeRow {
  inserted: boolean;
}

export interface KnowledgeRecallRow extends KnowledgeRow {
  /** pgvector returns cosine distance via `<=>`; we expose similarity = 1 - distance. */
  cosine_distance: number;
}

// ── Public domain types ─────────────────────────────────────────

export interface KnowledgeEntry {
  id: number;
  kind: string;
  title: string;
  summary: string;
  contentMd: string;
  tags: string[];
  sourceRefs: Record<string, unknown>;
  confidence: number | null;
  status: KnowledgeStatus;
  pinned: boolean;
  validFrom: string;
  validUntil: string | null;
  contentHash: string;
  embeddingModel: string;
  embeddingDim: number;
  sourceSurface: "vex_agent" | "mcp_local";
  sourceSession: string | null;
  /** FK to predecessor row this entry replaces (set by the manager's supersede transaction), or null. */
  supersedesId: number | null;
  /** Short "why" for any non-active status transition (superseded / invalidated / archived). */
  statusReason: string | null;
  /** Supersede-only: what's different about this new version. NULL on predecessors and plain entries. */
  changeSummary: string | null;
  /** Supersede-only: evidence that invalidated the predecessor. NULL on predecessors and plain entries. */
  whatFailed: string | null;
  /** Provenance classification — only `observed` + `user_confirmed` surface in Active Memory hot context. */
  source: KnowledgeSource;
  createdAt: string;
  updatedAt: string;
  // ── Memory v2 (influence + bi-temporal lifecycle) ───────────────
  /** Lesson-confidence FSM tier. SEPARATE axis from `status`. Legacy/default `established`. */
  maturityState: MaturityState;
  /** 0..1 weight used by recall reranking (S3). Decay lowers it, never deletes. Legacy 1.0. */
  activationStrength: number;
  /** Advisory only by doctrine — never feeds execution/sizing/approval (OD-1). */
  influenceScope: InfluenceScope;
  /** How `activationStrength` erodes (S6). Legacy/default `none`. */
  decayPolicy: DecayPolicy;
  /** Market-regime labels for reactivation (S6). Never contains null elements. */
  regimeTags: string[];
  /** When this lesson was first promoted to long-term memory, or null. */
  firstPromotedAt: string | null;
  /** When this lesson was last reinforced by new evidence, or null. */
  lastReinforcedAt: string | null;
  /** Scheduled review timestamp for decay/reconciliation, or null. */
  nextReviewAt: string | null;
  /** Reconciliation counter (S7) — re-derivation is idempotent per (id, outcomeVersion). */
  outcomeVersion: number;
}

/**
 * getById() extension that also resolves the reverse lineage link:
 * `supersededBy` — the id of the row whose `supersedes_id = this.id`, or null.
 *
 * Single-successor lineage is enforced by the partial unique index on
 * `supersedes_id`, so this is at most one row.
 */
export interface KnowledgeEntryWithLineage extends KnowledgeEntry {
  supersededBy: number | null;
}

export interface ActiveKnowledgeListItem {
  id: number;
  kind: string;
  title: string;
  summary: string;
  pinned: boolean;
  validUntil: string | null;
  updatedAt: string;
}

export interface KnownKind {
  kind: string;
  count: number;
}

export interface InsertEntryInput {
  kind: string;
  title: string;
  summary: string;
  contentMd: string;
  tags: string[];
  sourceRefs: Record<string, unknown>;
  confidence: number | null;
  pinned: boolean;
  validUntil: Date | null;
  contentHash: string;
  embeddingModel: string;
  embeddingDim: number;
  /** Vector as plain number[]. Must match embeddingDim. Serialized to pgvector literal. */
  embedding: number[];
  // ── Optional provenance fields. Default 'vex_agent' / NULL when omitted.
  // 'mcp_local' is retained only for legacy backups/imports.
  sourceSurface?: "vex_agent" | "mcp_local";
  sourceSession?: string;
  // ── Optional audit fields (used by knowledge-import to preserve roundtrip).
  // The promotion path does NOT pass these — defaults `'active'` / NOW() apply.
  status?: KnowledgeStatus;
  validFrom?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  // ── Optional lifecycle fields. Plain promotion leaves all null; the manager's
  // supersede transaction populates supersedesId + changeSummary + whatFailed on
  // the new row; import v2 may set any of them when restoring historical state.
  supersedesId?: number | null;
  statusReason?: string | null;
  changeSummary?: string | null;
  whatFailed?: string | null;
  /**
   * Provenance classification. Defaults to `'observed'` when omitted (backward-
   * compatible with import scripts and tools that haven't been updated yet).
   * Only `observed` + `user_confirmed` show up in Active Memory hot context;
   * `inferred` + `hypothesis` are recall-only.
   */
  source?: KnowledgeSource;
  // ── Optional memory v2 influence fields. ALL omitted → legacy-equivalent DB
  // defaults applied in TS by insertEntry (established / 1.0 / advisory / none /
  // [] / null / 0), so pre-v2 callers are byte-for-byte behavior-neutral.
  // Promotion / reconciliation paths (S4–S7) populate them; import preserves them.
  maturityState?: MaturityState;
  activationStrength?: number;
  influenceScope?: InfluenceScope;
  decayPolicy?: DecayPolicy;
  regimeTags?: string[];
  firstPromotedAt?: Date | null;
  lastReinforcedAt?: Date | null;
  nextReviewAt?: Date | null;
  outcomeVersion?: number;
}

export interface InsertEntryResult {
  entry: KnowledgeEntry;
  /** True iff the row was newly inserted; false iff it already existed (content_hash collision). */
  inserted: boolean;
}

export interface RecallFilters {
  /** Required — current embedding model identifier. Recall ONLY returns rows produced by this model. */
  embeddingModel: string;
  /** Required — current embedding dim. Recall ONLY returns rows with matching dim (mixed-dim crash protection). */
  embeddingDim: number;
  /** Optional kind filter (free-form, no enum). */
  kind?: string;
  /** If true, include entries past their TTL. Default: true (TTL ≠ existence). */
  includeExpired?: boolean;
}

export interface ListActiveOptions {
  limit: number;
}

export interface ListKnownKindsOptions {
  limit: number;
}

/**
 * Export row shape: KnowledgeEntry plus the predecessor's content_hash (stable
 * cross-DB identifier). `supersedes_id` (local integer FK) is deliberately NOT
 * in the export — IDs are unstable across installations. The importer resolves
 * `supersedesContentHash` back to a local id via `findByContentHash`.
 */
export interface KnowledgeEntryForExport extends KnowledgeEntry {
  /** content_hash of the predecessor row (resolved via self-join), or null. */
  supersedesContentHash: string | null;
}

export interface ReembedRow {
  id: number;
  kind: string;
  title: string;
  summary: string;
  contentMd: string;
}

// ── Mappers + helpers ───────────────────────────────────────────

export function mapRow(r: KnowledgeRow): KnowledgeEntry {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    contentMd: r.content_md,
    tags: r.tags ?? [],
    sourceRefs: r.source_refs ?? {},
    confidence: r.confidence,
    status: r.status as KnowledgeStatus,
    pinned: r.pinned,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    contentHash: r.content_hash,
    embeddingModel: r.embedding_model,
    embeddingDim: r.embedding_dim,
    sourceSurface: (r.source_surface as "vex_agent" | "mcp_local") ?? "vex_agent",
    sourceSession: r.source_session,
    supersedesId: r.supersedes_id,
    statusReason: r.status_reason,
    changeSummary: r.change_summary,
    whatFailed: r.what_failed,
    source: (r.source ?? "observed") as KnowledgeSource,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // ── Memory v2. DB columns are NOT NULL with defaults; the `?? default`
    // fallbacks defensively cover rows from narrower SELECTs that omit them.
    maturityState: (r.maturity_state ?? "established") as MaturityState,
    activationStrength: r.activation_strength ?? 1.0,
    influenceScope: (r.influence_scope ?? "advisory") as InfluenceScope,
    decayPolicy: (r.decay_policy ?? "none") as DecayPolicy,
    regimeTags: r.regime_tags ?? [],
    firstPromotedAt: r.first_promoted_at,
    lastReinforcedAt: r.last_reinforced_at,
    nextReviewAt: r.next_review_at,
    outcomeVersion: r.outcome_version ?? 0,
  };
}

/**
 * Long-memory recall candidate (S3) — a `RecallCandidate` PLUS the provenance
 * `source` tier and `maturityState`, so `MemorySearch` can apply
 * source-tier ranking (de-weight inferred/hypothesis) WITHOUT excluding them
 * (genesis §951). Only the dedicated `recallLongMemoryTopK` returns this shape.
 */
export interface LongMemoryRecallCandidate extends RecallCandidate {
  /** Provenance tier — drives the S3 source-tier de-weight. */
  source: KnowledgeSource;
  /** Lesson-confidence FSM tier — surfaced in detailed output (S6 ranking input). */
  maturityState: MaturityState;
  /**
   * 0..1 influence weight (S6a) — drives the BOUNDED rerank activation factor
   * (`activationFactor`). A decayed lesson has lower activation and ranks below a
   * reinforced one at equal base score, WITHOUT ever dropping under a candidate
   * (the MIN_FACTOR bound). Defaults to 1.0 for rows from narrower SELECTs.
   */
  activationStrength: number;
}

export function mapRowToLongMemoryCandidate(r: KnowledgeRecallRow): LongMemoryRecallCandidate {
  return {
    ...mapRowToCandidate(r),
    source: (r.source ?? "observed") as KnowledgeSource,
    maturityState: (r.maturity_state ?? "established") as MaturityState,
    activationStrength: r.activation_strength ?? 1.0,
  };
}

export function mapRowToCandidate(r: KnowledgeRecallRow): RecallCandidate {
  // pgvector cosine distance is in [0, 2]; for normalized vectors it's in [0, 2] too
  // but TEI/embedding models normalize, so distance ∈ [0, 2]. Similarity = 1 - distance/2
  // is one convention; another is similarity = 1 - distance for unit-norm L2-distance.
  // pgvector docs use `1 - (embedding <=> query)` for similarity, treating distance as
  // cosine distance ∈ [0, 2]. We follow that.
  const similarity = clampUnit(1 - r.cosine_distance);
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    contentMd: r.content_md,
    similarity,
    confidence: r.confidence,
    status: r.status as KnowledgeStatus,
    pinned: r.pinned,
    validUntil: r.valid_until ? new Date(r.valid_until) : null,
    validFrom: new Date(r.valid_from),
    updatedAt: new Date(r.updated_at),
    sourceRefs: r.source_refs ?? {},
    tags: r.tags ?? [],
  };
}

export function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Serialize a number[] to a pgvector literal: `[0.1,0.2,...]`.
 *
 * pgvector accepts text-format vectors via `$1::vector` cast. We do this in TS
 * so we don't need a special pg type adapter.
 */
export function vectorLiteral(v: readonly number[]): string {
  // Use minimal precision sufficient for embedding vectors. Float32 is what TEI returns.
  return "[" + v.join(",") + "]";
}

export function toIsoOrNull(d: Date | undefined): string | null {
  return d ? d.toISOString() : null;
}

// ── Lineage (read-only browse) ───────────────────────────────────

/**
 * Compact lineage node — one entry in a version chain. Excludes embedding,
 * content_md, content_hash and source_refs because lineage browse must stay
 * cheap even for long chains. Use `getById` (or `MemoryGet`) when you
 * need the full entry.
 */
export interface KnowledgeLineageItem {
  id: number;
  kind: string;
  title: string;
  status: KnowledgeStatus;
  /** FK to predecessor in this chain, or null for the root. */
  supersedesId: number | null;
  /** "why" for any non-active transition (set on superseded/invalidated/archived rows). */
  statusReason: string | null;
  /** Successor-only: what's different about this node vs its predecessor. */
  changeSummary: string | null;
  /** Successor-only: evidence that invalidated the predecessor. */
  whatFailed: string | null;
  validFrom: string;
  validUntil: string | null;
  updatedAt: string;
}

/**
 * Result of `getLineageChain(id)` — the full ordered chain with head metadata.
 *
 * `chain` is ordered root → head, regardless of where `requestedId` sits.
 * `headId` is the id of the last entry in the chain (no successor exists);
 * `headStatus` lets the caller tell at a glance whether the chain is still
 * active or terminated on invalidated/archived without a follow-up fetch.
 */
export interface KnowledgeLineageResult {
  /** The id originally requested (may be root, middle, or head). */
  requestedId: number;
  /** Last-in-chain id — the entry no other row supersedes. */
  headId: number;
  /** Status of the head node. */
  headStatus: KnowledgeStatus;
  /** Ordered chain root → head. Length ≥ 1. */
  chain: KnowledgeLineageItem[];
}

