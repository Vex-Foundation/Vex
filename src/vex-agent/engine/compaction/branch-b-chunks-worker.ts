/**
 * Branch B — the chunks worker's single tick. FREEZE-THEN-INSERT (contract C5).
 *
 * Two phases, and the order between them is the whole design:
 *
 *   PHASE 1 (LLM)    claim → read the frozen corpus → chunk → build ONE
 *                    normalized, redacted, schema-valid snapshot → persist it
 *                    with `casFreezeChunksOutput`.
 *   PHASE 2 (INSERT) embed + upsert exactly that snapshot through the EXISTING
 *                    `(session_id, content_hash)` active-row upsert.
 *
 * A tick that finds a row already in the frozen phase SKIPS THE MODEL ENTIRELY
 * and goes straight to phase 2. That is the crash-retry idempotence guarantee
 * and the single most important behaviour in this module: "attempt 3 → freeze →
 * crash" stays retryable forever, because the frozen tail is leased through
 * `claimFrozenChunksTail`, which never burns an attempt.
 *
 * THERE IS NO DELETE PATH HERE, and adding one would break C5. Not a
 * delete-then-insert, not a "clean up stale chunks for this session", not a
 * scoped cleanup before a retry. Re-inserting the frozen snapshot is idempotent
 * because the upsert dedupes on `content_hash`; a delete would turn a crash
 * into data loss.
 *
 * A LATE LANDING IS VALID. If the preparation was superseded or already
 * applied while this branch was working, the memory write still proceeds — the
 * chunks describe a conversation prefix that really happened. Only the
 * FSM-forward transitions refuse; `casChunksApplied` records the late landing
 * from the row's own status.
 */

import {
  BRANCH_RETRY_BACKOFF_BASE_MS,
  BRANCH_STALE_THRESHOLD_MS,
  casBranchFailed,
  casChunksApplied,
  casFreezeChunksOutput,
  casFrozenTailFailed,
  claimBranch,
  claimFrozenChunksTail,
  type CompactionPreparation,
  type FrozenChunksOutput,
} from "../../db/repos/compaction-preparations/index.js";
import {
  BODY_MD_SCHEMA_VERSION,
  insertPreparedMemory,
} from "@vex-agent/db/repos/session-memories/index.js";
import { embedDocument } from "@vex-agent/embeddings/client.js";
import { emitEngineError } from "../runtime/error-bus.js";
import { readMissionErrorSignal } from "../core/runner/mission-error-signal.js";
import logger from "@utils/logger.js";

import { emitPreparationBranchPermanentlyFailedBug } from "./bug-emit.js";
import { emitPreparationCommitted } from "./preparation-event-emit.js";
import { hasBranchProviderConfig, type BranchProviderFactory } from "./branch-provider-call.js";
import type { EndpointFailoverDeps } from "@vex-agent/inference/openrouter/endpoint-failover.js";
import { startBranchHeartbeat, type BranchLeaseHeartbeat } from "./branch-heartbeat.js";
import { buildChunksSnapshot } from "./chunks-snapshot.js";
import { callChunksLLM } from "./chunks-call.js";
import {
  buildCorpusProviderMessages,
  readPreparationCorpus,
  verifyToolPairClosure,
} from "./preparation-corpus.js";

export type ChunksTickOutcome =
  | { kind: "idle_nothing_due" }
  | { kind: "idle_no_provider_config" }
  | { kind: "landed"; preparationId: number; inserted: number; deduped: number }
  | { kind: "claim_lost"; preparationId: number }
  | { kind: "freeze_rejected"; preparationId: number }
  | { kind: "insert_failed"; preparationId: number }
  | { kind: "llm_failed"; preparationId: number; terminal: boolean };

export interface ChunksTickDeps {
  readonly makeProvider?: BranchProviderFactory;
  /** Endpoint-candidate source for the session's effective endpoint. */
  readonly failoverDeps?: EndpointFailoverDeps;
}

export async function runChunksBranchTick(
  workerId: string,
  deps: ChunksTickDeps = {},
): Promise<ChunksTickOutcome> {
  // Frozen tails first. They cost no inference, they are the crash-recovery
  // path, and they must not be starved by the LLM phase — nor gated on the
  // vault, since inserting a snapshot that was already paid for needs no
  // provider credentials.
  const frozen = await claimFrozenChunksTail(workerId, BRANCH_STALE_THRESHOLD_MS);
  if (frozen) return runInsertPhase(frozen, workerId);

  if (!hasBranchProviderConfig()) return { kind: "idle_no_provider_config" };

  const preparation = await claimBranch("chunks", workerId);
  if (!preparation) return { kind: "idle_nothing_due" };
  return runLlmPhase(preparation, workerId, deps);
}

// ── Phase 1: model → snapshot → freeze ───────────────────────────

async function runLlmPhase(
  preparation: CompactionPreparation,
  workerId: string,
  deps: ChunksTickDeps,
): Promise<ChunksTickOutcome> {
  const heartbeat = startBranchHeartbeat(preparation.id, "chunks", workerId);
  try {
    const corpus = readPreparationCorpus(preparation);
    const prefix = buildCorpusProviderMessages(corpus);
    const closure = verifyToolPairClosure(prefix);
    if (!closure.ok) {
      // Should be unreachable: the watermark selector yields a pair-closed
      // prefix and capture already ran the shared orphan repair. Failing here
      // named is far better than shipping the sequence and reading an opaque
      // provider 400 that never mentions the watermark.
      throw new Error(`compaction_corpus_pair_closure_broken: ${closure.reason}`);
    }

    const call = await callChunksLLM(
      {
        preparationId: preparation.id,
        sessionId: preparation.sessionId,
        frozenSummary: preparation.frozenSessionSummary,
        prefix,
      },
      deps.makeProvider,
      deps.failoverDeps,
    );

    const built = buildChunksSnapshot({
      preparationId: preparation.id,
      chunks: call.chunks,
      targetGeneration: preparation.targetCheckpointGeneration,
    });

    if (heartbeat.isClaimLost()) {
      logger.warn("compaction-prep.chunks_exit_after_claim_lost", {
        preparationId: preparation.id,
        workerId,
      });
      return { kind: "claim_lost", preparationId: preparation.id };
    }

    // THE BARRIER. Nothing is written to `session_memories` until this
    // resolves true.
    const froze = await casFreezeChunksOutput(preparation.id, workerId, {
      frozenOutput: built.snapshot,
      frozenOutputSha256: built.snapshotSha256,
      rejectedByExclusion: built.rejectedByExclusion,
      rejectedByRedaction: built.rejectedByRedaction,
      provider: "openrouter",
      model: call.model ?? process.env.AGENT_MODEL ?? "unknown",
      costUsd: call.costUsd,
    });
    if (!froze) {
      // Either the claim was lost or a snapshot already exists. Both mean the
      // authoritative bytes are not ours; a later frozen-tail claim inserts
      // whatever is actually on the row.
      logger.warn("compaction-prep.chunks_freeze_rejected", {
        preparationId: preparation.id,
        sessionId: preparation.sessionId,
        workerId,
      });
      return { kind: "freeze_rejected", preparationId: preparation.id };
    }

    // Committed. The row STATUS does not move here, but the `chunks_*` columns
    // the DTO exposes do, so the renderer still needs the invalidation.
    await emitPreparationCommitted(preparation.id);

    logger.info("compaction-prep.chunks_frozen", {
      preparationId: preparation.id,
      sessionId: preparation.sessionId,
      chunks: built.snapshot.chunks.length,
      rejectedByExclusion: built.rejectedByExclusion,
      costUsd: call.costUsd,
    });

    // The freeze keeps this worker's lease (status `frozen`, same owner), so
    // the insert continues here rather than waiting a poll interval.
    return insertFrozenSnapshot(
      preparation,
      built.snapshot,
      workerId,
      heartbeat,
      call.model,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const backoff =
      BRANCH_RETRY_BACKOFF_BASE_MS * Math.max(1, preparation.chunksAttemptCount);
    const outcome = await casBranchFailed(
      preparation.id,
      "chunks",
      workerId,
      errorMsg,
      backoff,
    );
    logger.warn("compaction-prep.chunks_attempt_failed", {
      preparationId: preparation.id,
      sessionId: preparation.sessionId,
      error: errorMsg,
      ok: outcome.ok,
      terminal: outcome.terminal,
    });
    if (outcome.ok && outcome.terminal) {
      await emitPreparationCommitted(preparation.id);
      // Branch B is NON-BLOCKING by contract — the cutover still happens
      // without it. What is lost is this window's session memory, which is
      // worth a report but never a session failure.
      const signal = readMissionErrorSignal(err);
      emitEngineError({
        sessionId: preparation.sessionId,
        scope: "compact",
        errorType: signal.errorType,
        errorClass: signal.errorClass,
        statusCode: signal.status,
        causeCode: signal.causeCode,
        retryAfterSeconds: signal.retryAfterSeconds,
      });
      await emitPreparationBranchPermanentlyFailedBug({
        preparationId: preparation.id,
        sessionId: preparation.sessionId,
        branch: "chunks",
        errorMsg,
      });
    }
    return {
      kind: "llm_failed",
      preparationId: preparation.id,
      terminal: outcome.ok && outcome.terminal,
    };
  } finally {
    heartbeat.stop();
  }
}

// ── Phase 2: insert the frozen snapshot ──────────────────────────

async function runInsertPhase(
  preparation: CompactionPreparation,
  workerId: string,
): Promise<ChunksTickOutcome> {
  const heartbeat = startBranchHeartbeat(preparation.id, "chunks", workerId);
  try {
    const snapshot = preparation.chunksFrozenOutput;
    if (!snapshot) {
      // `chunks_status = 'frozen'` with no snapshot is unrepresentable through
      // the repo's own CAS, so this is corruption rather than a race. Back off
      // instead of inventing a payload.
      await casFrozenTailFailed(
        preparation.id,
        workerId,
        "compaction_chunks_frozen_without_snapshot",
        BRANCH_RETRY_BACKOFF_BASE_MS,
      );
      logger.error("compaction-prep.chunks_frozen_without_snapshot", {
        preparationId: preparation.id,
        sessionId: preparation.sessionId,
      });
      return { kind: "insert_failed", preparationId: preparation.id };
    }
    return await insertFrozenSnapshot(
      preparation,
      snapshot,
      workerId,
      heartbeat,
      preparation.chunksModel,
    );
  } finally {
    heartbeat.stop();
  }
}

async function insertFrozenSnapshot(
  preparation: CompactionPreparation,
  snapshot: FrozenChunksOutput,
  workerId: string,
  heartbeat: BranchLeaseHeartbeat,
  inferenceModel: string | null,
): Promise<ChunksTickOutcome> {
  let inserted = 0;
  let deduped = 0;
  try {
    for (const chunk of snapshot.chunks) {
      if (heartbeat.isClaimLost()) {
        return { kind: "claim_lost", preparationId: preparation.id };
      }

      if (chunk.bodyMdSchemaVersion !== BODY_MD_SCHEMA_VERSION) {
        // The frozen bytes still win — they are what the first attempt
        // embedded and what the row must contain. What drifts is only the
        // version label the repo stamps, so this is an audit-fidelity warning,
        // not a reason to discard paid-for work.
        logger.warn("compaction-prep.chunk_body_schema_version_drift", {
          preparationId: preparation.id,
          frozen: chunk.bodyMdSchemaVersion,
          current: BODY_MD_SCHEMA_VERSION,
        });
      }

      // The FROZEN body is embedded, preserving the exact-body contract: the
      // bytes embedded are the bytes stored.
      const embedded = await embedDocument(chunk.theme, chunk.bodyMd);
      if (heartbeat.isClaimLost()) {
        return { kind: "claim_lost", preparationId: preparation.id };
      }

      const result = await insertPreparedMemory(
        {
          sessionId: preparation.sessionId,
          // The FIXED target generation frozen at fork, not a re-read.
          checkpointGeneration: preparation.targetCheckpointGeneration,
          theme: chunk.theme,
          // Carried on the snapshot, decided where it was knowable. Never
          // re-derived: a fallback theme validates by construction.
          themeSource: chunk.themeSource,
          entities: [...chunk.entities],
          protocols: [...chunk.protocols],
          errorClasses: [...chunk.errorClasses],
          chains: [...chunk.chains],
          tasks: [...chunk.tasks],
          happenedMd: chunk.happenedMd,
          didMd: chunk.didMd,
          triedMd: chunk.triedMd,
          outstandingTexts: chunk.outstandingItems.map((item) => item.text),
          // The corpus is MEMBERSHIP, not an ID interval, so there is no
          // meaningful start bound to record — claiming one would describe a
          // contiguous range the corpus never promised. The watermark is the
          // real upper bound and is read off the row, so the insert phase never
          // needs the corpus (which retention may already have pruned).
          sourceStartMessageId: null,
          sourceEndMessageId: preparation.watermarkMessageId,
          inferenceModel,
          embedding: embedded.embedding,
          embeddingModel: embedded.providerModel,
          embeddingDim: embedded.embedding.length,
        },
        {
          outstandingItems: chunk.outstandingItems,
          bodyMd: chunk.bodyMd,
          bodyMdHash: chunk.bodyMdHash,
          contentHash: chunk.contentHash,
        },
      );
      if (result.inserted) inserted += 1;
      else deduped += 1;
    }

    const landed = await casChunksApplied(preparation.id, workerId, {
      inserted,
      deduped,
    });
    if (!landed) {
      logger.warn("compaction-prep.chunks_landing_claim_lost", {
        preparationId: preparation.id,
        sessionId: preparation.sessionId,
        workerId,
        inserted,
        deduped,
      });
      return { kind: "claim_lost", preparationId: preparation.id };
    }

    // Committed insert outcome (`chunks_inserted` / `chunks_deduped` /
    // `chunks_landed_after_supersession` are now readable).
    await emitPreparationCommitted(preparation.id);

    logger.info("compaction-prep.chunks_landed", {
      preparationId: preparation.id,
      sessionId: preparation.sessionId,
      rowStatusAtStart: preparation.status,
      inserted,
      deduped,
    });
    return { kind: "landed", preparationId: preparation.id, inserted, deduped };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // The insert tail has NO terminal outcome: the snapshot is durable and was
    // already paid for, so it is retried until it lands. An insert that can
    // never succeed (a permanently unreachable embedding endpoint, say) is a
    // monitoring concern — a row sitting in `chunks_status = 'frozen'` with a
    // rising error — not a reason to discard the work.
    await casFrozenTailFailed(
      preparation.id,
      workerId,
      errorMsg,
      BRANCH_RETRY_BACKOFF_BASE_MS,
    );
    logger.warn("compaction-prep.chunks_insert_failed", {
      preparationId: preparation.id,
      sessionId: preparation.sessionId,
      insertedBeforeFailure: inserted,
      error: errorMsg,
    });
    return { kind: "insert_failed", preparationId: preparation.id };
  }
}

