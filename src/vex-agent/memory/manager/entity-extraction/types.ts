/**
 * Data contracts shared across the graph-extraction layer: what the extractor
 * is shown, what the pre-tx plan build produces, and what the in-tx apply
 * reports back. No behavior lives here — see `../entity-extraction.ts` for the
 * public surface and where each stage is implemented.
 */

import type { MemoryEntityType } from "@vex-agent/db/repos/memory-entities/index.js";
import type { MemoryEdgeRelation } from "@vex-agent/db/repos/memory-edges/index.js";

import type { EntityExtraction } from "../entity-extraction-schema.js";

// ── Lesson input (already-redacted candidate text + verdict tags) ──

/** The candidate fields the extractor sees — structurally a `MemoryCandidate`. */
export interface GraphLessonCandidate {
  id: string;
  kind: string;
  title: string;
  summary: string;
  contentMd: string;
}

/** The full extraction input: candidate text + the verdict's regime tags. */
export interface ExtractionLesson {
  kind: string;
  title: string;
  summary: string;
  contentMd: string;
  regimeTags: readonly string[];
}

// ── Graph plan (pre-tx product → in-tx apply) ──────────────────────

/**
 * One planned entity. `key` is the composite canonical identity
 * `(entityType, normalizeEntityName(name))` links/edges resolve through.
 *   - `existing` — an ACTIVE entity already owns this identity
 *     (pre-tx `findActiveEntity`, the skip-embed optimization); only its alias
 *     set grows. The race with a concurrent invalidation is harmless: aliasing
 *     a just-invalidated row is a benign no-op and the link stays a valid FK.
 *   - `new` — upserted in-tx (xmax — a concurrent insert degrades to a merge).
 */
export type GraphPlanEntity =
  | {
      kind: "existing";
      key: string;
      entityId: string;
      aliases: string[];
    }
  | {
      kind: "new";
      key: string;
      entityType: MemoryEntityType;
      name: string;
      aliases: string[];
      summary: string;
      embedding: number[];
      embeddingModel: string;
      embeddingDim: number;
    };

/** One planned entry↔entity link (every planned entity gets exactly one). */
export interface GraphPlanLink {
  key: string;
  mentionCount: number;
}

/** One planned directed edge; endpoints reference plan-entity keys. */
export interface GraphPlanEdge {
  sourceKey: string;
  targetKey: string;
  relation: MemoryEdgeRelation;
  fact: string;
}

export interface GraphPlan {
  entities: GraphPlanEntity[];
  links: GraphPlanLink[];
  edges: GraphPlanEdge[];
}

/** Write counts for the §7 `graph_extracted` telemetry. */
export interface GraphApplyCounts {
  entityCount: number;
  linkCount: number;
  edgeCount: number;
}

// ── Injectable IO for the plan build ───────────────────────────────

export interface GraphPlanDeps {
  /** The extraction LLM call (stubbed in tests). */
  extractEntities: (lesson: ExtractionLesson) => Promise<EntityExtraction>;
  /** Pre-tx active-identity probe — the skip-embed optimization only. */
  findActiveEntity: (
    entityType: MemoryEntityType,
    normalizedName: string,
  ) => Promise<{ id: string } | null>;
  /** NAME embedding for a NEW entity (same model/dim space as candidates — D-EMB). */
  embedEntityName: (
    name: string,
    summary: string,
  ) => Promise<{ embedding: number[]; providerModel: string }>;
}
