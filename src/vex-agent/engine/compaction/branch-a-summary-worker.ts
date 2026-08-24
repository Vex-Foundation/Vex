/**
 * Branch A — the summary worker's single tick.
 *
 * claim → read the frozen corpus → summarize → VALIDATE → CAS `summary_ready`.
 *
 * Two properties are load-bearing and both are enforced here rather than left
 * to a caller's discretion:
 *
 *   1. VALIDATION PRECEDES READINESS. An output that fails
 *      `validateSummaryOutput` is thrown, which makes it a FAILED ATTEMPT with
 *      a backoff. It never reaches the `summary_ready` CAS. Readiness is what
 *      unlocks the apply button, the apply tool and forced critical apply, so
 *      publishing readiness with unvalidated text would put unreviewed model
 *      output on the cutover path.
 *
 *   2. THE ENV GATE RUNS BEFORE THE CLAIM. Claiming increments the attempt
 *      counter, so claiming and then discovering the vault is locked would burn
 *      the retry budget for a condition that has nothing to do with the model.
 *      The loop stays idle until the vault injects the credentials.
 *
 * A terminal failure is reported on `{ ok && terminal }`, never on `terminal`
 * alone: the repo re-checks ownership in the UPDATE, so `{ ok: false }` means
 * another worker owns the row and the retry may still succeed. Reporting on
 * `terminal` alone once told users their compaction had permanently failed when
 * it had not.
 */

import {
  BRANCH_RETRY_BACKOFF_BASE_MS,
  casBranchFailed,
  casSummaryReady,
  claimBranch,
} from "../../db/repos/compaction-preparations/index.js";
import { emitEngineError, errorDetailOf } from "../runtime/error-bus.js";
import { readMissionErrorSignal } from "../core/runner/mission-error-signal.js";
import logger from "@utils/logger.js";

import { emitPreparationBranchPermanentlyFailedBug } from "./bug-emit.js";
import { emitPreparationCommitted } from "./preparation-event-emit.js";
import { hasBranchProviderConfig, type BranchProviderFactory } from "./branch-provider-call.js";
import type { EndpointFailoverDeps } from "@vex-agent/inference/openrouter/endpoint-failover.js";
import { startBranchHeartbeat } from "./branch-heartbeat.js";
import {
  buildCorpusProviderMessages,
  readPreparationCorpus,
  verifyToolPairClosure,
} from "./preparation-corpus.js";
import { callSummaryLLM } from "./summary-call.js";
import { SUMMARY_PROMPT_VERSION } from "./summary-prompt.js";
import { validateSummaryOutput } from "./summary-validation.js";

export type SummaryTickOutcome =
  | { kind: "idle_no_provider_config" }
  | { kind: "idle_nothing_due" }
  | { kind: "ready"; preparationId: number }
  | { kind: "claim_lost"; preparationId: number }
  | { kind: "rejected"; preparationId: number; reason: string }
  | { kind: "failed"; preparationId: number; terminal: boolean };

export interface SummaryTickDeps {
  readonly makeProvider?: BranchProviderFactory;
  /** Endpoint-candidate source for the session's effective endpoint. */
  readonly failoverDeps?: EndpointFailoverDeps;
}

export async function runSummaryBranchTick(
  workerId: string,
  deps: SummaryTickDeps = {},
): Promise<SummaryTickOutcome> {
  if (!hasBranchProviderConfig()) return { kind: "idle_no_provider_config" };

  const preparation = await claimBranch("summary", workerId);
  if (!preparation) return { kind: "idle_nothing_due" };

  const heartbeat = startBranchHeartbeat(preparation.id, "summary", workerId);
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

    const call = await callSummaryLLM(
      {
        preparationId: preparation.id,
        sessionId: preparation.sessionId,
        frozenSummary: preparation.frozenSessionSummary,
        prefix,
      },
      deps.makeProvider,
      deps.failoverDeps,
    );

    const validated = validateSummaryOutput(call.rawSummary);
    if (!validated.ok) {
      // A rejection is an attempt, not an outcome — the throw routes it through
      // the same failure/backoff path as a provider error.
      throw new Error(`compaction_summary_rejected_${validated.reason}`);
    }

    if (heartbeat.isClaimLost()) {
      logger.warn("compaction-prep.summary_exit_after_claim_lost", {
        preparationId: preparation.id,
        workerId,
      });
      return { kind: "claim_lost", preparationId: preparation.id };
    }

    const result = await casSummaryReady(preparation.id, workerId, {
      summary: validated.summary,
      promptVersion: SUMMARY_PROMPT_VERSION,
      provider: "openrouter",
      model: call.model ?? process.env.AGENT_MODEL ?? "unknown",
      costUsd: call.costUsd,
    });
    if (!result.ok) {
      // The CAS is state-checked as well as owner-checked, so this also covers
      // the C3 case: a preparation that was superseded (or moved onto the apply
      // path) while the call was in flight refuses a late readiness write. It
      // is not retried — the row it belonged to is gone.
      logger.warn("compaction-prep.summary_cas_rejected", {
        preparationId: preparation.id,
        sessionId: preparation.sessionId,
        workerId,
        reason: result.reason,
      });
      return {
        kind: "rejected",
        preparationId: preparation.id,
        reason: result.reason,
      };
    }

    // Committed: readiness is now fetchable, so the renderer may be told.
    await emitPreparationCommitted(preparation.id);

    logger.info("compaction-prep.summary_ready", {
      preparationId: preparation.id,
      sessionId: preparation.sessionId,
      promptVersion: SUMMARY_PROMPT_VERSION,
      summaryChars: validated.summary.length,
      hardRedactCount: validated.hardRedactCount,
      costUsd: call.costUsd,
      model: call.model,
    });
    return { kind: "ready", preparationId: preparation.id };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const backoff =
      BRANCH_RETRY_BACKOFF_BASE_MS * Math.max(1, preparation.summaryAttemptCount);
    const outcome = await casBranchFailed(
      preparation.id,
      "summary",
      workerId,
      errorMsg,
      backoff,
    );
    logger.warn("compaction-prep.summary_attempt_failed", {
      preparationId: preparation.id,
      sessionId: preparation.sessionId,
      error: errorMsg,
      ok: outcome.ok,
      terminal: outcome.terminal,
    });

    if (outcome.ok && outcome.terminal) {
      // Committed terminal failure — the row is now `failed`. A NON-terminal
      // attempt is deliberately silent: nothing observable to the renderer
      // changed, and a bus event per retry is noise.
      await emitPreparationCommitted(preparation.id);
      // Branch A giving up permanently means this session will never reach a
      // prepared cutover: the user must be able to see that, because the next
      // turns are the ones that walk into the context wall.
      //
      // Codes plus the raw message as `detail` - sanitized at the main-side
      // bridge before it can reach the renderer (owner decree 2026-08-02).
      const signal = readMissionErrorSignal(err);
      emitEngineError({
        sessionId: preparation.sessionId,
        scope: "compact",
        errorType: signal.errorType,
        errorClass: signal.errorClass,
        statusCode: signal.status,
        causeCode: signal.causeCode,
        retryAfterSeconds: signal.retryAfterSeconds,
        detail: errorDetailOf(err),
      });
      await emitPreparationBranchPermanentlyFailedBug({
        preparationId: preparation.id,
        sessionId: preparation.sessionId,
        branch: "summary",
        errorMsg,
      });
    }
    return {
      kind: "failed",
      preparationId: preparation.id,
      terminal: outcome.ok && outcome.terminal,
    };
  } finally {
    heartbeat.stop();
  }
}
