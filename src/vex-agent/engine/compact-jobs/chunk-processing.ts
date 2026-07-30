/**
 * Per-chunk processing for the archive chunking worker. Extracted
 * from `executor.ts` for scaling.
 *
 * For each raw chunk from the chunker LLM:
 *   1. Redact every emitted string field (theme + narrative + outstanding
 *      items + entities/protocols/error_classes/chains/tasks) so secrets
 *      and address/tx identifiers never reach DB or embedding storage.
 *   2. Validate the (redacted) theme; fall back to `buildFallbackTheme`
 *      using the redacted structured columns when validation fails.
 *   3. Exclusion-scan the redacted body. If it's mostly live state the
 *      chunk is dropped (counted in `rejectedExclusion`).
 *   4. Render → embed → insert under the exact-body embedding contract
 *      (the bytes embedded are the bytes stored).
 *
 * Claim-loss observability is bit-for-bit preserved with the original
 * inline loop:
 *
 *   - mid-loop guards (pre-render, post-embed) return `claim_lost_silent`
 *     and the caller `return`s without logging — matches the original
 *     `if (claimLost) return;` silent exits.
 *   - post-loop guard returns `claim_lost_after_loop` and the caller
 *     logs `compact-worker.exit_after_claim_lost` — matches the
 *     original post-loop check that logged the warn.
 *   - the entry guard maps to `claim_lost_silent` so an empty
 *     chunkerOutput in the race window between caller's checks and
 *     helper entry cannot be mistaken for `markCompleted(0 chunks)`
 *     success (would be a permanent-loss bug). Caller's pre-helper
 *     `if (claimGuard.isLost()) return` is the primary defense; the
 *     entry guard is defense-in-depth.
 */

import type { CompactJob } from "../../db/repos/compact-jobs/index.js";
import { embedDocument } from "@vex-agent/embeddings/client.js";
import {
  EMBEDDING_DOCUMENT_MAX_CHARS,
  embeddingDocumentInputChars,
  exceedsEmbeddingDocumentBudget,
} from "@vex-agent/embeddings/document-size-budget.js";
import {
  insertPreparedMemory,
  prepareMemoryRender,
} from "@vex-agent/db/repos/session-memories/index.js";
import { redact } from "@vex-agent/memory/redaction.js";
import { scanLiveState } from "@vex-agent/memory/exclusion-rules.js";
import { validateTheme, buildFallbackTheme } from "@vex-agent/memory/theme-validation.js";
import { redactStringArray } from "./archived-prefix.js";
import type { ChunkerChunk } from "./chunker-call.js";
import { MAX_OUTSTANDING_ITEMS_PER_CHUNK } from "@vex-agent/memory/session-memory-policy.js";
import logger from "@utils/logger.js";

export interface ClaimGuard {
  isLost(): boolean;
}

export type ChunkProcessingOutcome =
  | { kind: "completed"; inserted: number; rejectedExclusion: number }
  | { kind: "claim_lost_silent" }
  | { kind: "claim_lost_after_loop"; insertedSoFar: number; sessionId: string };

export async function processChunkerOutput(args: {
  readonly job: CompactJob;
  readonly chunkerOutput: ChunkerChunk[];
  readonly claimGuard: ClaimGuard;
}): Promise<ChunkProcessingOutcome> {
  // Entry guard — race window between caller's post-callChunkerLLM check
  // and this helper entry. Without this, an empty chunkerOutput in that
  // window would land in `markCompleted(0)` and silently lose the job.
  if (args.claimGuard.isLost()) {
    return { kind: "claim_lost_silent" };
  }

  let inserted = 0;
  let rejectedExclusion = 0;

  for (const raw of args.chunkerOutput) {
    // Redaction across ALL generated string fields the chunker emitted —
    // narrative + outstanding items + entities/protocols/error_classes/
    // chains/tasks/theme. Anything that lands in the row's structured
    // columns (or in the body_md / embedded text) must be redacted before
    // DB write so secrets and address/tx identifiers never reach storage.
    const themeR = redact(raw.theme ?? "");
    const r1 = redact(raw.happened_md ?? "");
    const r2 = redact(raw.did_md ?? "");
    const r3 = redact(raw.tried_md ?? "");
    const rOuts = (raw.outstanding_items ?? [])
      .slice(0, MAX_OUTSTANDING_ITEMS_PER_CHUNK)
      .map((t) => redact(t));
    const entitiesR = redactStringArray(raw.entities ?? []);
    const protocolsR = redactStringArray(raw.protocols ?? []);
    const errorClassesR = redactStringArray(raw.error_classes ?? []);
    const chainsR = redactStringArray(raw.chains ?? []);
    const tasksR = redactStringArray(raw.tasks ?? []);

    const totalHard =
      themeR.hardRedactCount
      + r1.hardRedactCount + r2.hardRedactCount + r3.hardRedactCount
      + rOuts.reduce((acc, r) => acc + r.hardRedactCount, 0)
      + entitiesR.hardCount + protocolsR.hardCount + errorClassesR.hardCount
      + chainsR.hardCount + tasksR.hardCount;

    // Validate the REDACTED theme — hard-redact placeholders would fail
    // slug validation anyway, but the build-fallback path still needs
    // sanitized inputs so a leaked identifier doesn't survive via the
    // fallback theme construction.
    const themeResult = validateTheme(themeR.text);
    const theme = themeResult.ok
      ? themeResult.theme
      : buildFallbackTheme({
          entities: entitiesR.values,
          protocols: protocolsR.values,
          errorClasses: errorClassesR.values,
          chains: chainsR.values,
          tasks: tasksR.values,
          generation: args.job.checkpointGeneration,
        });
    const themeSource = themeResult.ok ? "chunker" : "fallback";

    // Exclusion check on the redacted body — if it's mostly live state,
    // drop the chunk. Outstanding items ARE part of `body_md` so the scan
    // input includes the redacted outstanding text. (codex P1 — round 2.)
    const outstandingTextForExclusion = rOuts.map((r) => r.text).join("\n");
    const bodyForExclusion =
      `${r1.text}\n${r2.text}\n${r3.text}\n${outstandingTextForExclusion}`;
    const exclusionScan = scanLiveState(bodyForExclusion);
    if (exclusionScan.rejected) {
      rejectedExclusion += 1;
      logger.info("compact-worker.chunk_rejected_exclusion", {
        jobId: args.job.id,
        theme,
        liveFraction: exclusionScan.liveFraction,
      });
      continue;
    }
    if (totalHard > 0) {
      logger.info("compact-worker.chunk_redacted", {
        jobId: args.job.id,
        theme,
        hardCount: totalHard,
      });
    }

    // Pre-render guard — mid-loop silent exit (matches the original
    // `if (claimLost) return;` before `prepareMemoryRender`).
    if (args.claimGuard.isLost()) {
      return { kind: "claim_lost_silent" };
    }

    const prep = prepareMemoryRender({
      theme,
      happenedMd: r1.text,
      didMd: r2.text,
      triedMd: r3.text,
      outstandingTexts: rOuts.map((r) => r.text),
    });
    // NEVER embed a body the provider cannot take. The shipped embeddings
    // server answers HTTP 500 for anything over its physical batch, and this
    // worker's retry/backoff would re-send the same oversized body on every
    // attempt. Throwing here makes it a FAILED ATTEMPT, so the job reaches
    // `permanently_failed` after `WORKER_MAX_ATTEMPTS` instead of retrying
    // forever, and nothing oversized is ever inserted. The legacy path gets no
    // repair round — the preparation pipeline owns that; here the named failure
    // plus the prompt budget in `chunker-call.ts` is the whole fix.
    if (exceedsEmbeddingDocumentBudget(theme, prep.bodyMd)) {
      logger.warn("compact-worker.chunk_exceeds_embedding_budget", {
        jobId: args.job.id,
        theme,
        inputChars: embeddingDocumentInputChars(theme, prep.bodyMd),
        maxChars: EMBEDDING_DOCUMENT_MAX_CHARS,
      });
      throw new Error(
        `chunker_chunk_exceeds_embedding_budget: theme=${theme} chars=${embeddingDocumentInputChars(theme, prep.bodyMd)} max=${EMBEDDING_DOCUMENT_MAX_CHARS}`,
      );
    }
    const embedded = await embedDocument(theme, prep.bodyMd);

    // Post-embed guard — mid-loop silent exit (matches the original
    // `if (claimLost) return;` after `embedDocument`).
    if (args.claimGuard.isLost()) {
      return { kind: "claim_lost_silent" };
    }

    const result = await insertPreparedMemory(
      {
        sessionId: args.job.sessionId,
        checkpointGeneration: args.job.checkpointGeneration,
        theme,
        themeSource: themeSource as "chunker" | "fallback",
        entities: entitiesR.values,
        protocols: protocolsR.values,
        errorClasses: errorClassesR.values,
        chains: chainsR.values,
        tasks: tasksR.values,
        happenedMd: r1.text,
        didMd: r2.text,
        triedMd: r3.text,
        outstandingTexts: rOuts.map((r) => r.text),
        sourceStartMessageId: args.job.sourceStartMessageId,
        sourceEndMessageId: args.job.sourceEndMessageId,
        inferenceModel: process.env.AGENT_MODEL ?? null,
        embedding: embedded.embedding,
        embeddingModel: embedded.providerModel,
        embeddingDim: embedded.embedding.length,
      },
      prep,
    );
    if (result.inserted) inserted += 1;
  }

  // Post-loop guard — caller logs `compact-worker.exit_after_claim_lost`
  // (matches the original post-loop warn-then-return).
  if (args.claimGuard.isLost()) {
    return {
      kind: "claim_lost_after_loop",
      insertedSoFar: inserted,
      sessionId: args.job.sessionId,
    };
  }

  return { kind: "completed", inserted, rejectedExclusion };
}
