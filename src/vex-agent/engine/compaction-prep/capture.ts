/**
 * Fork-time capture — the one writer that creates a `compaction_preparations`
 * row (wave contract C2 + C3).
 *
 * Everything a preparation will ever read is frozen here, in ONE transaction,
 * under the `sessions` row lock:
 *   - the pre-fork `sessions.summary` (the previous compacted history lives
 *     only there; without it branch A's REPLACE would drop everything before
 *     the last checkpoint);
 *   - the live message rows `<= watermark`, redacted, ID-bearing;
 *   - the canonical provider-safe corpus text and its sha256.
 *
 * LOCK ORDER. Capture takes the `sessions` row lock and NOTHING else — no
 * advisory lock, ever. The apply path locks
 * `session advisory lock → queued-stop/control rows → sessions row →
 * preparation row → money rows`; a capture that took the control lock after
 * the row lock would close a cycle with it. The preparation repo's create
 * functions require this client precisely so the fork cannot grab a
 * preparation row before the session row.
 *
 * AUTHORITATIVE READ. There is no cheap pre-check outside the transaction.
 * Gate 0 removed it: pressure state and tool visibility share one read owned
 * by the turn's pressure resolver, and capture keeps its own authoritative
 * read rather than pretending one snapshot can serve a worker race too.
 *
 * The TypeScript supersession decision is ADVISORY. `supersedeAndReplace`
 * re-checks the status inside its guarded `UPDATE`, so a concurrent apply
 * request that lands between the decision and the CAS is refused by Postgres,
 * not by an if-statement here.
 */

import type { PoolClient } from "pg";

import { queryOneWith } from "../../db/client.js";
import { getPool } from "../../db/client.js";
import {
  LIVE_PREPARATION_STATUSES,
  createPreparation,
  listPreparationsForSession,
  supersedeAndReplace,
  type CompactionPreparation,
  type NewCompactionPreparation,
} from "../../db/repos/compaction-preparations/index.js";
import * as messagesRepo from "../../db/repos/messages.js";
import { lockSessionAndReadGeneration } from "../compact-jobs/commit-primitives.js";
import {
  COMPACTION_PREPARATION_EVENT_TYPE,
  compactionPreparationBus,
} from "../runtime/compaction-bus.js";
import logger from "@utils/logger.js";
import {
  CORPUS_FORMAT_VERSION,
  buildPreparationCorpus,
  fingerprintPreparationCorpus,
  serializePreparationCorpus,
} from "./corpus.js";
import { computeWatermarkMessageId, decideSupersession } from "./supersession.js";

export type CaptureSkipReason =
  | "no_messages"
  | "live_preparation_not_material"
  | "supersede_forbidden"
  | "summary_exhausted_for_generation";

export type CaptureOutcome =
  | {
      kind: "captured";
      preparationId: number;
      watermarkMessageId: number;
      corpusMessageCount: number;
    }
  | {
      kind: "superseded_and_captured";
      preparationId: number;
      supersededPreparationId: number;
      watermarkMessageId: number;
      corpusMessageCount: number;
    }
  | { kind: "already_live"; preparationId: number | null }
  | { kind: "skipped"; reason: CaptureSkipReason };

export interface CapturePreparationArgs {
  readonly sessionId: string;
  readonly source: "warning_band_auto";
}

export async function capturePreparation(
  args: CapturePreparationArgs,
): Promise<CaptureOutcome> {
  const tx = await getPool().connect();
  let committed: CompactionPreparation | null = null;
  try {
    await tx.query("BEGIN");
    const result = await captureInTransaction(tx, args.sessionId);
    if (
      result.outcome.kind === "skipped" ||
      result.outcome.kind === "already_live"
    ) {
      await tx.query("ROLLBACK").catch(() => undefined);
    } else {
      await tx.query("COMMIT");
      committed = result.committed;
    }
    logCaptureOutcome(args, result.outcome);
    if (committed) emitPreparationEvent(args.sessionId, committed);
    return result.outcome;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

/**
 * POST-COMMIT ONLY — the bus's binding producer contract. The renderer treats
 * this purely as an invalidation signal and immediately re-reads the row, so an
 * emit issued inside the transaction would make that refetch observe the OLD
 * state and not refetch again until the 60 s fallback poll.
 *
 * ONE event per committed transaction, carrying the row that is now LIVE.
 * A supersede-and-replace commits two transitions, but the superseded row is
 * terminal and not what the session's surface renders; emitting its status too
 * would tell the renderer the session's preparation is `superseded` at the
 * exact moment its replacement went live.
 *
 * Status and readiness come from the committed row, never from an assumption
 * about what capture "should" have produced.
 */
function emitPreparationEvent(
  sessionId: string,
  row: CompactionPreparation,
): void {
  compactionPreparationBus.emit({
    type: COMPACTION_PREPARATION_EVENT_TYPE,
    sessionId,
    status: row.status,
    summaryReady: row.summaryOutput !== null,
    // Capture is runtime-automatic — there is no request to correlate with.
    correlationId: null,
  });
}

/**
 * `committed` is the row that will be live once the caller commits — the emit
 * payload's source. It is non-null exactly when the outcome is one the caller
 * commits, so a rolled-back capture cannot emit.
 */
interface CaptureAttempt {
  readonly outcome: CaptureOutcome;
  readonly committed: CompactionPreparation | null;
}

async function captureInTransaction(
  tx: PoolClient,
  sessionId: string,
): Promise<CaptureAttempt> {
  // Lock first, then read everything from under that lock.
  const { currentGen, nextGen } = await lockSessionAndReadGeneration(
    tx,
    sessionId,
  );
  const frozenSummary = await readFrozenSummary(tx, sessionId);

  const rows = await messagesRepo.getLiveMessagesWithId(sessionId, tx);
  const watermarkMessageId = computeWatermarkMessageId(rows);
  if (watermarkMessageId === null) {
    return notCommitted({ kind: "skipped", reason: "no_messages" });
  }

  // ONE read serves both questions below: a live preparation is always the
  // newest row for its session (supersede-then-replace keeps exactly one live
  // row, and the replacement is created after it), so the newest row is the
  // live one when a live one exists.
  const [latest] = await listPreparationsForSession(sessionId, 1);

  if (isSummaryExhaustedForGeneration(latest, currentGen)) {
    return notCommitted({
      kind: "skipped",
      reason: "summary_exhausted_for_generation",
    });
  }

  const live =
    latest && LIVE_PREPARATION_STATUSES.includes(latest.status) ? latest : null;

  if (live) {
    const decision = decideSupersession({
      liveStatus: live.status,
      liveWatermarkMessageId: live.watermarkMessageId,
      rowsAfterWatermark: rows.filter((r) => r.id > live.watermarkMessageId),
    });
    if (decision.kind === "keep") {
      return notCommitted({
        kind: "skipped",
        reason:
          decision.reason === "terminal_status_forbidden"
            ? "supersede_forbidden"
            : "live_preparation_not_material",
      });
    }
  }

  const input = buildNewPreparation({
    sessionId,
    frozenSummary,
    rows,
    watermarkMessageId,
    baseCheckpointGeneration: currentGen,
    targetCheckpointGeneration: nextGen,
  });

  if (live) {
    const replaced = await supersedeAndReplace(live.id, input, tx);
    if (!replaced.ok) {
      // The guarded UPDATE saw a status the advisory decision above did not.
      // Postgres is the authority; leave the row alone.
      return notCommitted(
        replaced.reason === "apply_in_progress"
          ? { kind: "skipped", reason: "supersede_forbidden" }
          : { kind: "already_live", preparationId: live.id },
      );
    }
    return {
      outcome: {
        kind: "superseded_and_captured",
        preparationId: replaced.replacement.id,
        supersededPreparationId: replaced.superseded.id,
        watermarkMessageId,
        corpusMessageCount: input.corpusMessageCount,
      },
      committed: replaced.replacement,
    };
  }

  const created = await createPreparation(input, tx);
  if (!created.ok) {
    // A live row appeared between the read and the insert. The partial unique
    // reported it through `DO NOTHING`, so the transaction is still usable and
    // nothing is lost — the next boundary re-evaluates.
    return notCommitted({ kind: "already_live", preparationId: null });
  }
  return {
    outcome: {
      kind: "captured",
      preparationId: created.preparation.id,
      watermarkMessageId,
      corpusMessageCount: input.corpusMessageCount,
    },
    committed: created.preparation,
  };
}

/** A path that rolls back: no committed row, therefore no event. */
function notCommitted(outcome: CaptureOutcome): CaptureAttempt {
  return { outcome, committed: null };
}

function buildNewPreparation(args: {
  readonly sessionId: string;
  readonly frozenSummary: string | null;
  readonly rows: Awaited<ReturnType<typeof messagesRepo.getLiveMessagesWithId>>;
  readonly watermarkMessageId: number;
  readonly baseCheckpointGeneration: number;
  readonly targetCheckpointGeneration: number;
}): NewCompactionPreparation {
  const corpus = buildPreparationCorpus({
    frozenSummary: args.frozenSummary,
    rows: args.rows,
    watermarkMessageId: args.watermarkMessageId,
  });
  const corpusText = serializePreparationCorpus(corpus);

  return {
    sessionId: args.sessionId,
    watermarkMessageId: args.watermarkMessageId,
    baseCheckpointGeneration: args.baseCheckpointGeneration,
    targetCheckpointGeneration: args.targetCheckpointGeneration,
    frozenSessionSummary: args.frozenSummary,
    corpusText,
    corpusSha256: fingerprintPreparationCorpus(corpusText),
    corpusFormatVersion: CORPUS_FORMAT_VERSION,
    corpusMessageCount: corpus.entries.length,
    corpusBytes: Buffer.byteLength(corpusText, "utf8"),
    corpusRedactionHard: corpus.redactionCounts.hard,
    corpusRedactionMask: corpus.redactionCounts.mask,
  };
}

/**
 * Frozen eligibility rule: once branch A has exhausted its attempts, the
 * runtime never automatically prepares this session again on the SAME base
 * checkpoint generation. Eligibility returns only after the deterministic
 * LLM-free fallback bumps the generation — otherwise a failed branch re-forks
 * a full corpus, and a full branch-A spend, on every single iteration.
 */
function isSummaryExhaustedForGeneration(
  latest: CompactionPreparation | undefined,
  currentGeneration: number,
): boolean {
  if (!latest) return false;
  return (
    latest.summaryStatus === "permanently_failed" &&
    latest.baseCheckpointGeneration === currentGeneration
  );
}

async function readFrozenSummary(
  tx: PoolClient,
  sessionId: string,
): Promise<string | null> {
  // Read inside the transaction that already holds `sessions ... FOR UPDATE`,
  // so this is the summary the fork is defined against and nobody can move it
  // between the lock and this read.
  const row = await queryOneWith<{ summary: string | null }>(
    tx,
    "SELECT summary FROM sessions WHERE id = $1",
    [sessionId],
  );
  return row?.summary ?? null;
}

/** Metadata only — never corpus content, never a summary. */
function logCaptureOutcome(
  args: CapturePreparationArgs,
  outcome: CaptureOutcome,
): void {
  if (outcome.kind === "skipped" || outcome.kind === "already_live") {
    logger.info("compaction.preparation.capture_skipped", {
      sessionId: args.sessionId,
      source: args.source,
      outcome: outcome.kind,
      reason: outcome.kind === "skipped" ? outcome.reason : null,
    });
    return;
  }
  logger.info("compaction.preparation.captured", {
    sessionId: args.sessionId,
    source: args.source,
    outcome: outcome.kind,
    preparationId: outcome.preparationId,
    watermarkMessageId: outcome.watermarkMessageId,
    corpusMessageCount: outcome.corpusMessageCount,
  });
}
