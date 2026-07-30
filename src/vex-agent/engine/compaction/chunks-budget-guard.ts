/**
 * Branch B — producing a frozen snapshot whose every chunk can actually be
 * embedded (owner decision 2026-07-30).
 *
 * THE INVARIANT THIS MODULE OWNS: a snapshot that reaches
 * `casFreezeChunksOutput` contains ONLY chunks that pass the embedding size
 * budget. Oversized-and-frozen is unrepresentable, which is what makes the
 * insert tail's "no terminal outcome, retry until it lands" contract correct —
 * before this, a single oversized chunk parked the row in
 * `chunks_status = 'frozen'` forever and the session silently never got its
 * narrative memory.
 *
 * THE SHAPE, and why it is not a loop. The model is asked for compliant sizes
 * up front (the prompt states the budget); everything the first answer got
 * right is KEPT; the violations go back in exactly ONE follow-up request that
 * carries only them. If that still comes back oversized the attempt FAILS into
 * the existing attempts/backoff machinery. We never truncate — the chunk is a
 * memory, and silently cutting it in half would store a lie.
 *
 * The size check runs on the BUILT chunks, not on the model's raw text,
 * because the bytes that get embedded are `renderBodyMd`'s output plus the
 * embeddings formatter prefix — the only measurement that answers the real
 * question.
 */

import {
  callChunksLLM,
  callChunksRepairLLM,
  type ChunksCallInput,
  type OversizedChunkForRepair,
} from "./chunks-call.js";
import {
  buildChunksSnapshot,
  partitionFrozenChunksByEmbeddingBudget,
  sealFrozenChunks,
} from "./chunks-snapshot.js";
import type { BranchProviderFactory } from "./branch-provider-call.js";
import type { EndpointFailoverDeps } from "@vex-agent/inference/openrouter/endpoint-failover.js";
import type {
  FrozenChunk,
  FrozenChunksOutput,
} from "../../db/repos/compaction-preparations/index.js";
import logger from "@utils/logger.js";

export interface BudgetValidChunksSnapshot {
  readonly snapshot: FrozenChunksOutput;
  readonly snapshotSha256: string;
  readonly rejectedByExclusion: number;
  readonly rejectedByRedaction: number;
  /** Summed across the chunking call AND the repair call, when one ran. */
  readonly costUsd: number | null;
  readonly model: string | null;
  readonly repairAttempted: boolean;
}

export interface BudgetGuardDeps {
  readonly makeProvider?: BranchProviderFactory;
  readonly failoverDeps?: EndpointFailoverDeps;
}

export async function buildBudgetValidChunksSnapshot(
  input: ChunksCallInput & { readonly targetGeneration: number },
  deps: BudgetGuardDeps = {},
): Promise<BudgetValidChunksSnapshot> {
  const call = await callChunksLLM(input, deps.makeProvider, deps.failoverDeps);
  const built = buildChunksSnapshot({
    preparationId: input.preparationId,
    chunks: call.chunks,
    targetGeneration: input.targetGeneration,
  });
  const first = partitionFrozenChunksByEmbeddingBudget(built.snapshot.chunks);

  if (first.oversized.length === 0) {
    return {
      ...built,
      costUsd: call.costUsd,
      model: call.model,
      repairAttempted: false,
    };
  }

  logger.warn("compaction-prep.chunks_oversized_requesting_repair", {
    preparationId: input.preparationId,
    sessionId: input.sessionId,
    oversized: first.oversized.length,
    withinBudget: first.withinBudget.length,
  });

  const repair = await callChunksRepairLLM(
    {
      preparationId: input.preparationId,
      sessionId: input.sessionId,
      oversized: first.oversized.map(forRepair),
    },
    deps.makeProvider,
    deps.failoverDeps,
  );
  const rebuilt = buildChunksSnapshot({
    preparationId: input.preparationId,
    chunks: repair.chunks,
    targetGeneration: input.targetGeneration,
  });
  const second = partitionFrozenChunksByEmbeddingBudget(rebuilt.snapshot.chunks);

  if (second.oversized.length > 0) {
    // A FAILED ATTEMPT, not a freeze and not a truncation: the branch backs off
    // and retries from the top, and only an exhausted attempt budget is
    // terminal. Nothing is written to `session_memories`.
    throw new Error(
      `compaction_chunks_oversized_after_repair: ${second.oversized.length} chunk(s) still exceed the embedding size budget`,
    );
  }

  logger.info("compaction-prep.chunks_size_repaired", {
    preparationId: input.preparationId,
    sessionId: input.sessionId,
    keptFromFirstAnswer: first.withinBudget.length,
    reEmitted: second.withinBudget.length,
  });

  return {
    ...sealFrozenChunks([...first.withinBudget, ...second.withinBudget]),
    rejectedByExclusion: built.rejectedByExclusion + rebuilt.rejectedByExclusion,
    rejectedByRedaction: built.rejectedByRedaction + rebuilt.rejectedByRedaction,
    costUsd: addCosts(call.costUsd, repair.costUsd),
    model: call.model ?? repair.model,
    repairAttempted: true,
  };
}

function forRepair(chunk: FrozenChunk): OversizedChunkForRepair {
  return {
    theme: chunk.theme,
    happenedMd: chunk.happenedMd,
    didMd: chunk.didMd,
    triedMd: chunk.triedMd,
    outstandingItems: chunk.outstandingItems.map((item) => item.text),
  };
}

/**
 * Sum two best-effort provider costs. `null` means "the provider did not report
 * one" and must not be read as zero, so the result is `null` only when NEITHER
 * call reported — an under-report would silently unprice a real spend, which is
 * exactly what the branch-cost accounting is there to catch.
 */
function addCosts(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}
