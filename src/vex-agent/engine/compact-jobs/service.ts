/**
 * executeCompactNow — the LEGACY, LLM-free compaction primitive.
 *
 * Shared service called by:
 *   - the deterministic critical-band forced fallback (`forced-fallback.ts`)
 *   - the forced-fallback path at critical band (runtime-driven path)
 *
 * This is the deterministic path: it archives a prefix of the transcript and
 * hands the narrative work to the asynchronous `compact_jobs` chunking worker.
 * It is NOT the prepared-apply cutover (compaction v2, `engine/compaction/`),
 * which replaces the rolling summary with a pre-computed branch-A summary and
 * touches `compact_jobs` not at all. The two paths deliberately share only the
 * locked-transaction steps in `./commit-primitives.ts`; everything below this
 * line — the giant-tool fallback, the enqueue and the source-range provenance —
 * belongs to this path alone.
 *
 * Compact-commit semantics — everything below runs in a single atomic
 * transaction under `withCheckpointMutex` so wake/ingress paths cannot observe
 * a half-archived transcript. Pure DB work: no inference call happens here.
 *   1. Redact summary / preserve / themes via memory/redaction
 *   2. lockSessionAndReadGeneration → `nextGen = checkpoint_generation + 1`
 *   3. Reload live messages with ids
 *   4. selectPrefixWithGiantFallback(messages) → plan
 *   5. If `noop` (empty prefix, no compactable tool) → return `{kind:'noop'}`
 *      without bumping generation. Caller decides whether to retry.
 *   6. Otherwise:
 *      - replaceRollingSummaryAndBumpGeneration(...) — REPLACE, not merge,
 *        and the bump + `token_count = 0` reset are inseparable
 *      - enqueueJob({...}) — idempotent on (session_id, generation)
 *      - archivePrefix(...) OR forkToolMessageToArchive(...) with giant
 *        placeholder referencing the compact_job id (the archive chunking
 *        worker will produce the narrative chunk asynchronously)
 *   7. Commit; return `{kind:'committed', generation, archivedMessages, jobId}`
 *
 * The whole inner call is wrapped in `runWithCommitRetry`, whose ONLY retry
 * discriminator is `tracker.commitAttempted` — never the error type.
 *
 * The archive chunking worker NEVER blocks compact. If it fails or the
 * provider is down, the row stays in `compact_jobs` with `status='pending'`
 * for retry; the compact itself has already committed.
 */

import * as messagesRepo from "@vex-agent/db/repos/messages.js";
import { archivePrefix, forkToolMessageToArchive } from "@vex-agent/db/repos/sessions-archive.js";
import { enqueueJob } from "@vex-agent/db/repos/compact-jobs/index.js";
import { getPool } from "@vex-agent/db/client.js";
import { selectPrefixWithGiantFallback } from "@vex-agent/engine/checkpoint/prefix.js";
import { withCheckpointMutex } from "./state.js";
import {
  type CommitAttemptTracker,
  lockSessionAndReadGeneration,
  replaceRollingSummaryAndBumpGeneration,
  runWithCommitRetry,
} from "./commit-primitives.js";
import { redact } from "@vex-agent/memory/redaction.js";
import { buildGiantToolPlaceholder } from "./giant-tool.js";
import {
  COMPACT_COMMIT_MAX_ATTEMPTS,
  COMPACT_COMMIT_RETRY_BACKOFF_MS,
} from "./policy.js";
import logger from "@utils/logger.js";

export interface CompactCommitArgs {
  sessionId: string;
  agentSummary: string;
  preserveMd: string | null;
  threadThemesHints: string[];
  source: "agent_tool" | "forced_fallback";
}

export type CompactCommitResult =
  | {
      kind: "committed";
      generation: number;
      archivedMessages: number;
      jobId: number;
      redactionCounts: { hard: number; mask: number };
      planMode: "prefix" | "giant_tool";
    }
  | {
      kind: "noop";
      reason: "empty_session" | "no_compactable";
    };

export async function executeCompactNow(input: CompactCommitArgs): Promise<CompactCommitResult> {
  return withCheckpointMutex(input.sessionId, async () =>
    runWithCommitRetry(
      {
        sessionId: input.sessionId,
        source: input.source,
        maxAttempts: COMPACT_COMMIT_MAX_ATTEMPTS,
        backoffMs: COMPACT_COMMIT_RETRY_BACKOFF_MS,
      },
      (tracker) => executeCompactNowInner(input, tracker),
    ),
  );
}

async function executeCompactNowInner(
  input: CompactCommitArgs,
  tracker: CommitAttemptTracker,
): Promise<CompactCommitResult> {
  // Pre-compute redactions on every text field (counts surfaced in audit).
  const summaryR = redact(input.agentSummary);
  const preserveR = input.preserveMd === null ? null : redact(input.preserveMd);
  const themeRs = input.threadThemesHints.map((t) => redact(t));
  const redactionCounts = {
    hard:
      summaryR.hardRedactCount
      + (preserveR?.hardRedactCount ?? 0)
      + themeRs.reduce((acc, r) => acc + r.hardRedactCount, 0),
    mask:
      summaryR.maskCount
      + (preserveR?.maskCount ?? 0)
      + themeRs.reduce((acc, r) => acc + r.maskCount, 0),
  };
  const redactedSummary = summaryR.text;
  const redactedPreserve = preserveR?.text ?? null;
  const redactedHints = themeRs.map((r) => r.text);

  const pool = getPool();
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");

    // Lock the session row and read the current generation FIRST — see
    // `lockSessionAndReadGeneration` for why the order is load-bearing.
    const { nextGen } = await lockSessionAndReadGeneration(tx, input.sessionId);

    // Now read live messages + select prefix under the locked session — the
    // tx-aware variant of `getLiveMessagesWithId` reuses the FOR-UPDATE
    // client so the snapshot matches what's about to commit.
    const messagesWithId = await messagesRepo.getLiveMessagesWithId(input.sessionId, tx);
    const plan = selectPrefixWithGiantFallback(messagesWithId);
    if (plan.mode === "noop") {
      await tx.query("ROLLBACK").catch(() => undefined);
      logger.info("compact.noop", {
        sessionId: input.sessionId,
        reason: plan.reason,
        source: input.source,
      });
      return { kind: "noop", reason: plan.reason };
    }

    // The source range records which ARCHIVED rows feed this chunking job —
    // `archived-prefix.ts` reads `messages_archive` over exactly this span. In
    // giant_tool mode only the bloated row is forked to the archive, so the
    // range is that single row; recording the (never-archived) parent
    // assistant here made the provenance record claim a row the archive does
    // not hold.
    const sourceStartMessageId =
      plan.mode === "prefix" ? plan.prefix[0]?.id ?? null : plan.bloatedMessageId;
    const sourceEndMessageId =
      plan.mode === "prefix"
        ? plan.prefix[plan.prefix.length - 1]?.id
        : plan.bloatedMessageId;

    if (sourceEndMessageId === undefined) {
      await tx.query("ROLLBACK").catch(() => undefined);
      return { kind: "noop", reason: "no_compactable" };
    }

    // 1. Replace the rolling summary, bump the generation and reset
    //    token_count — one inseparable step, see the primitive's contract.
    await replaceRollingSummaryAndBumpGeneration(tx, {
      sessionId: input.sessionId,
      summary: redactedSummary,
      nextGen,
    });

    // 2. Enqueue the archive chunking job first — we need its id to embed in the
    //    giant-tool placeholder if applicable. Idempotent on (session, gen).
    const enq = await enqueueJob(
      {
        sessionId: input.sessionId,
        checkpointGeneration: nextGen,
        agentSummary: redactedSummary,
        preserveMd: redactedPreserve,
        threadThemesHints: redactedHints,
        sourceStartMessageId,
        sourceEndMessageId,
      },
      tx,
    );

    let archivedMessages: number;
    if (plan.mode === "prefix") {
      const remainingCount = messagesWithId.length - plan.prefix.length;
      await archivePrefix(input.sessionId, plan.cutoffMessageId, remainingCount, tx);
      archivedMessages = plan.prefix.length;
    } else {
      // giant_tool plan: fork the single bloated row to archive, leave a
      // placeholder stub in live messages pointing at the compact_job (Track
      // 2 will produce the narrative chunk asynchronously). Placeholder text
      // mentions session_memory_search as the recovery path per codex guardrail.
      const placeholder = buildGiantToolPlaceholder(plan.bloatedMessageId, enq.job.id);
      await forkToolMessageToArchive(input.sessionId, plan.bloatedMessageId, placeholder, tx);
      archivedMessages = 1;
    }

    // Point of no return. Set BEFORE issuing COMMIT, never after: if the
    // COMMIT itself throws we cannot know whether the server applied it, so
    // the only safe assumption is that it did — retrying would risk a second
    // generation bump. Everything above this line rolled back cleanly and is
    // replayable.
    tracker.commitAttempted = true;
    await tx.query("COMMIT");

    logger.info("compact.committed", {
      sessionId: input.sessionId,
      generation: nextGen,
      planMode: plan.mode,
      archivedMessages,
      jobId: enq.job.id,
      source: input.source,
      redactionHard: redactionCounts.hard,
      redactionMask: redactionCounts.mask,
    });

    return {
      kind: "committed",
      generation: nextGen,
      archivedMessages,
      jobId: enq.job.id,
      redactionCounts,
      planMode: plan.mode,
    };
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }
}
