/**
 * The critical-band compaction ladder — ONE decision, two call sites.
 *
 * Two paths in the loop reach critical pressure and must compact before doing
 * anything else: the proactive check at the top of an iteration
 * (`turn-loop-critical-fallback.ts`) and the pre-park check before a
 * `waiting_for_wake` (`turn-loop-waiting-for-wake.ts`). Historically the second
 * ran only the deterministic fallback. Duplicating the v2 ladder into it would
 * be exactly the "duplicated domain logic" stop-the-line condition — two copies
 * of a money-adjacent decision that will drift on the first change. So the
 * ladder lives here and both paths call it.
 *
 * THE LADDER, in order:
 *
 *   1. A validated prepared summary ⇒ force the prepared apply. This is the
 *      good outcome: the summary was written by a background branch from a
 *      frozen corpus, so it is far better than anything synthesized under
 *      duress. Forced execution bypasses the MONEY gate by construction
 *      (`mode: "forced_critical"`) — at 92% context, waiting for a pending
 *      approval to resolve strands the session with no path forward.
 *
 *   2. Branch A still working, lease alive ⇒ bounded wait for the CURRENT
 *      attempt only, then re-check. Waiting across a retry could block a turn
 *      for three full attempt windows; waiting for the one already in flight
 *      costs at most its own deadline and usually converts a fallback into a
 *      real summary.
 *
 *   2b. A cutover ALREADY IN FLIGHT (`applying`) ⇒ DEFER. Not a forced apply
 *      (the row is no longer requestable, so it could only fail) and above all
 *      not the fallback: the fallback bumps `current + 1`, which is normally the
 *      exact generation the in-flight preparation froze as its target. Letting
 *      both run would leave two writers claiming one generation with different
 *      summaries and archives, and apply-crash recovery unable to tell which
 *      committed. The in-flight cutover either lands and relieves the pressure,
 *      or its stale lease is recovered and the next critical turn decides again.
 *
 *   3. Anything else, or the wait timing out ⇒ the deterministic, LLM-free
 *      fallback. It is worse prose but it always terminates.
 *
 * WHAT THIS NEVER DOES: it never returns "proceed to inference". A critical
 * turn either compacted, is being stopped, or falls back — Gate-0 §23. A wait
 * that times out runs the fallback; it does not shrug and issue the request.
 *
 * A QUEUED STOP IS NOT A FAILED COMPACTION. `forcePreparedApply` refuses to
 * rewrite a transcript while an operator Stop is queued, and that refusal is
 * reported as `deferred`, never `noop`. The caller passes the noop counter
 * through unchanged, so pressing Stop can never escalate a healthy run to
 * `compact_unable_at_critical`.
 */

import { maybeRunForcedCompactFallback } from "@vex-agent/engine/compact-jobs/forced-fallback.js";
import { forcePreparedApply } from "@vex-agent/engine/compaction/apply/index.js";
import { getLivePreparationPressureState } from "@vex-agent/db/repos/compaction-preparations/index.js";
// The per-attempt deadline is BRANCH A's constant. Imported, never restated —
// a local copy would silently stop tracking the worker it is waiting on.
import { SUMMARY_CALL_TIMEOUT_MS } from "@vex-agent/engine/compaction/policy.js";
import {
  resolvePreparationPressureState,
  type PreparationPressureState,
} from "./preparation-pressure-state.js";
import logger from "@utils/logger.js";

/**
 * Upper bound on waiting for an in-flight branch-A attempt at critical.
 * Deliberately EQUAL to the attempt's own deadline: waiting longer than the
 * worker's own timeout can only wait on something already dead.
 */
export const CRITICAL_PREPARATION_WAIT_MS = SUMMARY_CALL_TIMEOUT_MS;

/** How often the bounded wait re-reads the preparation state. */
const CRITICAL_PREPARATION_POLL_MS = 2_000;

export type CriticalCompactionOutcome =
  | {
      kind: "committed";
      via: "prepared_apply" | "deterministic_fallback";
      generation: number;
    }
  /**
   * The cutover was correctly declined — an operator Stop is queued, or a
   * cutover is already in flight. NOT a compaction failure: the caller must pass
   * its noop counter through unchanged, or waiting correctly would escalate a
   * healthy run to `compact_unable_at_critical`.
   */
  | { kind: "deferred"; reason: string }
  | { kind: "noop"; reason: string };

export interface CriticalCompactionInput {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly sessionPermission: "restricted" | "full";
  /**
   * The calling runner's lease owner id. Absent ⇒ no forced apply is attempted
   * (we cannot prove we hold the lease), and the ladder falls through to the
   * deterministic fallback — which is safe precisely because an `applying` row
   * defers above, so the fallback can never race a live cutover.
   */
  readonly runnerOwnerId?: string;
  /** Injectable for tests; production leaves it to the real repo reader. */
  readonly readPreparationState?: (
    sessionId: string,
  ) => Promise<PreparationPressureState>;
  /** Injectable sleep so the bounded wait is testable without real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function resolveCriticalCompaction(
  input: CriticalCompactionInput,
): Promise<CriticalCompactionOutcome> {
  const read =
    input.readPreparationState ??
    ((sessionId: string) =>
      getLivePreparationPressureState(sessionId, SUMMARY_CALL_TIMEOUT_MS));

  let state = await resolvePreparationPressureState(input.sessionId, read);

  // Step 2 — bounded wait for the attempt already in flight, before deciding.
  if (state.kind === "preparing" && state.leaseAlive) {
    state = await awaitCurrentPreparationAttempt(input, state, read);
  }

  // Step 2b — a cutover is already in flight. Defer; never fall through.
  if (state.kind === "applying") {
    logger.info("compact.critical.apply_in_flight", {
      sessionId: input.sessionId,
      preparationId: state.preparationId,
    });
    return { kind: "deferred", reason: "apply_in_flight" };
  }

  // Step 1 — prefer the prepared summary whenever one exists.
  if (state.kind === "summary_ready" && input.runnerOwnerId !== undefined) {
    const forced = await forcePreparedApply({
      sessionId: input.sessionId,
      missionRunId: input.missionRunId,
      sessionPermission: input.sessionPermission,
      runnerOwnerId: input.runnerOwnerId,
    });

    if (forced.kind === "applied") {
      logger.info("compact.forced_apply.committed", {
        sessionId: input.sessionId,
        generation: forced.generation,
        archivedMessages: forced.archivedMessages,
      });
      return {
        kind: "committed",
        via: "prepared_apply",
        generation: forced.generation,
      };
    }

    if (forced.kind === "deferred" && forced.result.kind === "stop_queued") {
      // The operator pressed Stop. The loop's next iteration guard consumes it;
      // our job is only to make sure this does not read as a failed compaction.
      logger.info("compact.forced_apply.gate_deferred", {
        sessionId: input.sessionId,
        reason: "stop_queued",
      });
      return { kind: "deferred", reason: "stop_queued" };
    }

    // Every other refusal (a moved generation, a preparation that is no longer
    // applicable, nothing compactable) means the prepared row cannot help this
    // turn. Fall through rather than stall — the fallback always terminates.
    logger.warn("compact.forced_apply.unusable", {
      sessionId: input.sessionId,
      outcome: forced.kind,
      detail: forced.kind === "deferred" ? forced.result.kind : null,
    });
  }

  // Step 3 — deterministic, LLM-free fallback.
  return runDeterministicFallback(input.sessionId);
}

/**
 * Poll until the in-flight attempt resolves, the lease dies, the attempt rolls
 * over, or the bound elapses. Returns the LAST state observed, so the caller
 * decides on fresh information either way.
 *
 * The rollover check is what keeps this bounded in practice: a second attempt
 * starting means the first failed, and waiting for the replacement would double
 * an already long stall at the worst possible moment.
 */
async function awaitCurrentPreparationAttempt(
  input: CriticalCompactionInput,
  initial: Extract<PreparationPressureState, { kind: "preparing" }>,
  read: (sessionId: string) => Promise<PreparationPressureState>,
): Promise<PreparationPressureState> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = Date.now();
  const attemptsAtStart = initial.attemptsRemaining;

  logger.info("compact.critical.awaiting_attempt", {
    sessionId: input.sessionId,
    preparationId: initial.preparationId,
    attemptsRemaining: attemptsAtStart,
    boundMs: CRITICAL_PREPARATION_WAIT_MS,
  });

  let state: PreparationPressureState = initial;
  while (Date.now() - startedAt < CRITICAL_PREPARATION_WAIT_MS) {
    await sleep(CRITICAL_PREPARATION_POLL_MS);
    state = await resolvePreparationPressureState(input.sessionId, read);

    if (state.kind !== "preparing") return state; // ready, failed, or gone
    if (!state.leaseAlive) return state; // the worker died
    if (state.attemptsRemaining !== attemptsAtStart) {
      // A new attempt began — do NOT wait across it.
      logger.info("compact.critical.attempt_rolled_over", {
        sessionId: input.sessionId,
        preparationId: state.preparationId,
      });
      return state;
    }
  }

  logger.info("compact.critical.wait_timed_out", {
    sessionId: input.sessionId,
    waitedMs: Date.now() - startedAt,
  });
  return state;
}

async function runDeterministicFallback(
  sessionId: string,
): Promise<CriticalCompactionOutcome> {
  const fallback = await maybeRunForcedCompactFallback(sessionId);
  if (fallback.kind === "committed") {
    logger.info("compact.forced_fallback.committed", {
      sessionId,
      generation: fallback.generation,
      jobId: fallback.jobId,
      planMode: fallback.planMode,
    });
    return {
      kind: "committed",
      via: "deterministic_fallback",
      generation: fallback.generation,
    };
  }
  return { kind: "noop", reason: fallback.reason };
}
