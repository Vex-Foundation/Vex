/**
 * executeCompactNow — the single compaction primitive of PR2.
 *
 * Shared service called by:
 *   - the `compact_now` tool handler (agent-driven path)
 *   - the forced-fallback path at critical band (runtime-driven path)
 *
 * Compact-commit semantics — everything below runs in a single atomic
 * transaction under `withCheckpointMutex` so wake/ingress paths cannot observe
 * a half-archived transcript. Pure DB work: no inference call happens here.
 *   1. Redact summary / preserve / themes via memory/redaction
 *   2. SELECT session FOR UPDATE; compute `nextGen = checkpoint_generation + 1`
 *   3. Reload live messages with ids
 *   4. selectPrefixWithGiantFallback(messages) → plan
 *   5. If `noop` (empty prefix, no compactable tool) → return `{kind:'noop'}`
 *      without bumping generation. Caller decides whether to retry.
 *   6. Otherwise:
 *      - setRollingSummary(sessionId, agent_summary)  -- REPLACE, not merge
 *      - UPDATE sessions SET checkpoint_generation = nextGen
 *      - archivePrefix(...) OR forkToolMessageToArchive(...) with giant
 *        placeholder referencing the compact_job id (the archive chunking
 *        worker will produce the narrative chunk asynchronously)
 *      - enqueueJob({...}) — idempotent on (session_id, generation)
 *   7. Commit; return `{kind:'committed', generation, archivedMessages, jobId}`
 *
 * The archive chunking worker NEVER blocks compact. If it fails or the
 * provider is down, the row stays in `compact_jobs` with `status='pending'`
 * for retry; the compact itself has already committed.
 */

import * as messagesRepo from "@vex-agent/db/repos/messages.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import { archivePrefix, forkToolMessageToArchive } from "@vex-agent/db/repos/sessions-archive.js";
import { enqueueJob } from "@vex-agent/db/repos/compact-jobs/index.js";
import { getPool } from "@vex-agent/db/client.js";
import { selectPrefixWithGiantFallback } from "@vex-agent/engine/checkpoint/prefix.js";
import { withCheckpointMutex } from "./state.js";
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

/**
 * Records whether the transaction reached its `COMMIT` statement.
 *
 * This is the ONLY thing that makes retrying safe, so it is an explicit
 * parameter rather than an inferred condition. See `executeCompactNow`.
 */
interface CommitAttemptTracker {
  commitAttempted: boolean;
}

export async function executeCompactNow(input: CompactCommitArgs): Promise<CompactCommitResult> {
  return withCheckpointMutex(input.sessionId, async () => {
    // Retry the whole inner call — but ONLY for failures that happened strictly
    // BEFORE `COMMIT` was issued.
    //
    // Why the boundary is load-bearing: `executeCompactNowInner` recomputes
    // `nextGen` from a FRESH `SELECT … FOR UPDATE` on every attempt. If the
    // first attempt actually committed and then something threw on the way out,
    // a retry would read the already-bumped generation, bump it AGAIN, enqueue
    // a SECOND chunking job and archive a SECOND prefix. `enqueueJob` is
    // idempotent on `(session_id, checkpoint_generation)`, which protects a
    // replay of the SAME generation — it cannot protect a different one. So a
    // post-COMMIT failure must propagate untouched.
    //
    // A pre-COMMIT failure rolled the transaction back and wrote nothing, so
    // replaying it is safe and spares the caller a lost compact exactly when
    // context pressure is critical. These are three DATABASE attempts: this
    // path makes no inference call at all (that is the archive chunking
    // worker, which has its own separate retry budget).
    for (let attempt = 1; ; attempt++) {
      const tracker: CommitAttemptTracker = { commitAttempted: false };
      try {
        return await executeCompactNowInner(input, tracker);
      } catch (err) {
        if (tracker.commitAttempted || attempt >= COMPACT_COMMIT_MAX_ATTEMPTS) {
          throw err;
        }
        logger.warn("compact.commit_retry", {
          sessionId: input.sessionId,
          source: input.source,
          attempt,
          maxAttempts: COMPACT_COMMIT_MAX_ATTEMPTS,
          error: err instanceof Error ? err.message : String(err),
        });
        await delay(COMPACT_COMMIT_RETRY_BACKOFF_MS);
      }
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    // Lock the session row and read the current generation FIRST. Selecting
    // the prefix before the lock would let a second compacter plan against
    // a stale transcript and serialize on the row lock — the second commit
    // would then bump a SECOND generation using an obsolete cutoff. Reading
    // messages + planning under the same connection as the FOR UPDATE makes
    // the plan/commit pair atomic per session.
    const genRow = await tx.query<{ checkpoint_generation: number }>(
      "SELECT checkpoint_generation FROM sessions WHERE id = $1 FOR UPDATE",
      [input.sessionId],
    );
    const currentGen = genRow.rows[0]?.checkpoint_generation ?? 0;
    const nextGen = currentGen + 1;

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

    // 1. Replace the rolling summary with the agent's narrative summary.
    //    Wholesale REPLACE (not merge) — agent's full-context summary IS
    //    the new rolling summary. Old merge semantics produced telephone-
    //    game drift across many compactions.
    await sessionsRepo.setRollingSummary(input.sessionId, redactedSummary, tx);

    // 2. Bump generation atomically AND reset token_count so a restart in
    //    the window between commit and the next executeTurn cannot resume
    //    into a stale-critical band that would fire a redundant forced
    //    fallback (which would noop, since the session was just compacted).
    //    The next executeTurn writes the actual post-compact prompt size
    //    via `sessionsRepo.updateTokenCount` — this 0 is only a safe
    //    interim baseline. Same single UPDATE so the bump + reset commit
    //    atomically with the archive write.
    await tx.query(
      "UPDATE sessions SET checkpoint_generation = $2, token_count = 0 WHERE id = $1",
      [input.sessionId, nextGen],
    );

    // 3. Enqueue the archive chunking job first — we need its id to embed in the
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
