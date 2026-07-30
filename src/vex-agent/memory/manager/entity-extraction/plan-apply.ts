/**
 * In-tx application of a pre-built graph plan.
 *
 * Every write is an idempotent repo upsert (xmax / GREATEST-on-conflict), so a
 * retried transaction re-applies cleanly. The caller wraps this in
 * `SAVEPOINT graph_plan` (D-SAVEPOINT) — an error here rolls back ONLY the graph
 * writes and the promotion still commits.
 */

import type { PoolClient } from "pg";

import {
  addEntityAliases,
  upsertEntity,
} from "@vex-agent/db/repos/memory-entities/index.js";
import { linkEntryEntity } from "@vex-agent/db/repos/memory-entry-entities/index.js";
import { upsertEdge } from "@vex-agent/db/repos/memory-edges/index.js";

import type { GraphApplyCounts, GraphPlan } from "./types.js";

/**
 * Apply a pre-built graph plan inside the promotion transaction, AFTER
 * `applyDecision` resolved the promoted entry id. All writes are idempotent
 * repo upserts (xmax / GREATEST-on-conflict), so a retried tx re-applies
 * cleanly. The caller (`applyDecisionAtomically`) wraps this in
 * `SAVEPOINT graph_plan` — an error here rolls back ONLY the graph writes and
 * the promotion still commits (D-SAVEPOINT).
 */
export async function applyGraphPlan(
  plan: GraphPlan,
  entryId: number,
  tx: PoolClient,
): Promise<GraphApplyCounts> {
  const idByKey = new Map<string, string>();

  for (const entity of plan.entities) {
    if (entity.kind === "existing") {
      // Alias growth on the active row; a null return means the entity was
      // invalidated since the pre-tx probe — benign (link below still valid).
      if (entity.aliases.length > 0) {
        await addEntityAliases(entity.entityId, entity.aliases, tx);
      }
      idByKey.set(entity.key, entity.entityId);
    } else {
      const res = await upsertEntity(
        {
          entityType: entity.entityType,
          name: entity.name,
          aliases: entity.aliases,
          summary: entity.summary,
          attributes: {},
          embedding: entity.embedding,
          embeddingModel: entity.embeddingModel,
          embeddingDim: entity.embeddingDim,
          validFrom: null,
        },
        tx,
      );
      // Conflict-merged row (a race created the identity first): the insert's
      // alias set was discarded — merge it explicitly (F2: deterministic only).
      if (!res.inserted && entity.aliases.length > 0) {
        await addEntityAliases(res.entity.id, entity.aliases, tx);
      }
      idByKey.set(entity.key, res.entity.id);
    }
  }

  let linkCount = 0;
  for (const link of plan.links) {
    const entityId = idByKey.get(link.key);
    if (entityId === undefined) continue;
    await linkEntryEntity(entryId, entityId, link.mentionCount, tx);
    linkCount += 1;
  }

  let edgeCount = 0;
  for (const edge of plan.edges) {
    const sourceId = idByKey.get(edge.sourceKey);
    const targetId = idByKey.get(edge.targetKey);
    if (sourceId === undefined || targetId === undefined) continue;
    // D-EMB: edges carry NO fact embedding in S8 (all-or-none triplet stays NULL).
    await upsertEdge(
      {
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        relation: edge.relation,
        fact: edge.fact,
        factEmbedding: null,
        embeddingModel: null,
        embeddingDim: null,
        originEntryId: entryId,
        validFrom: null,
      },
      tx,
    );
    edgeCount += 1;
  }

  return { entityCount: plan.entities.length, linkCount, edgeCount };
}
