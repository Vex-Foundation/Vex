/**
 * The ONE stop-gated ordering for a lease-held agent turn that nobody typed a
 * message to start.
 *
 * ## Why this is a shared primitive and not a pattern to re-type
 *
 * Two paths wake a chat session's turn from durable state: an approval resume
 * and a launch-form resume. Both hold the session lease, both run a full turn
 * loop, and both can be reached long after the operator pressed Stop. The
 * approval path got the ordering right; the form path did not have it at all
 * and ran a model turn with no lease, no gate and no signal.
 *
 * That is the same defect twice, which is the definition of a missing shared
 * primitive. So the ordering lives HERE and both callers delegate:
 *
 *   1. REGISTER the session-slice abort controller FIRST — before the gate,
 *      before the provider, before anything fallible. The gate and the
 *      controller must OVERLAP, not sit end to end: registering afterwards
 *      leaves an interval (gate read → provider load → config load →
 *      registration) in which a committed Stop is invisible to both halves —
 *      too late for the gate's snapshot, too early to find a controller — and
 *      the turn then runs unstoppable.
 *   2. Consult the DURABLE operator-stop gate with `missionRunId: null` under
 *      the session control lock, BEFORE any provider resolution and before any
 *      caller-supplied preparation. Fail-closed: a stopped session resolves no
 *      provider, appends no cue and runs no model call.
 *   3. Thread the signal into BOTH turn-loop positions, so a Stop landing
 *      DURING the turn breaks the loop at the next iteration and mid-provider
 *      call — never mid-dispatch, so a signing or broadcast call in flight
 *      still completes.
 *   4. CONSUME the applied stop exactly once, conditioned on the signal,
 *      because that is the only evidence a stop landed on this turn. Without it
 *      the row that stopped this turn stays open and the next unrelated thing
 *      to consult the gate is refused by a stop that already did its job.
 *
 * The gate covers a Stop landed BEFORE the turn; the signal covers one landed
 * DURING it. Both are required — neither subsumes the other.
 *
 * ## What this does NOT own
 *
 * The LEASE. Every caller claims and releases its own, because the claim is
 * where the caller's own exactly-once semantics live (an approval flips its
 * run, a form CASes its intent). This primitive runs under a lease the caller
 * already holds and never touches it.
 */

import logger from "@utils/logger.js";

import type { ResumedTurnClaim, TurnResult } from "../../types.js";

/** The result a gated turn returns when the operator had already stopped. */
const STOPPED_RESULT: TurnResult = {
  text: null,
  toolCallsMade: 0,
  pendingApprovals: [],
  stopReason: "user_stopped",
  missionStatus: null,
};

export interface GatedSessionTurnInput {
  readonly sessionId: string;
  /**
   * The session-lease owner id the CALLER holds for this turn. Threaded so the
   * turn loop's compaction-apply boundary can prove ownership by equality
   * against the live lease.
   */
  readonly runnerOwnerId: string;
  /**
   * Caller preparation that must run only on a session that was NOT stopped —
   * an idempotent transcript cue, for instance. Runs after the gate and after
   * the provider is resolved, so a stopped session pays for none of it.
   */
  readonly beforeTurn?: () => Promise<void>;
  /** The resumed-turn guard, passed straight through to the turn core. */
  readonly claimTurn?: ResumedTurnClaim;
  /** Log discriminator, so two callers' declines are distinguishable. */
  readonly logScope: string;
}

export async function runStopGatedSessionTurn(
  input: GatedSessionTurnInput,
): Promise<TurnResult> {
  const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
    "../../runtime/lease-and-status.js"
  );
  const {
    registerSessionSliceAbortController,
    unregisterSessionSliceAbortController,
  } = await import("../../runtime/session-slice-abort.js");

  /**
   * The gate both OBSERVES a session-scoped stop and APPLIES it, so calling it
   * is how a stop gets consumed. Idempotent: a session with nothing queued
   * reports `clear` and writes nothing, so it is safe on more than one path.
   */
  const consultStopGate = async (): Promise<boolean> =>
    withSessionControlLock(input.sessionId, async (client) => {
      const gate = await gateOnOperatorStopWithClient(client, {
        sessionId: input.sessionId,
        missionRunId: null,
      });
      return gate.kind === "stopped";
    });

  const controller = registerSessionSliceAbortController(input.sessionId);
  try {
    if (await consultStopGate()) {
      logger.info("engine.gated_session_turn.declined_stopped", {
        sessionId: input.sessionId,
        scope: input.logScope,
      });
      return STOPPED_RESULT;
    }

    const { resolveProvider } = await import("@vex-agent/inference/registry.js");
    const provider = await resolveProvider();
    if (!provider) throw new Error("No inference provider available");
    const config = await provider.loadConfig();
    if (!config) throw new Error("No inference config available");

    if (input.beforeTurn !== undefined) await input.beforeTurn();

    const { runAgentTurnUnderLease } = await import("./agent.js");
    return await runAgentTurnUnderLease(
      input.sessionId,
      provider,
      config,
      controller.signal,
      input.claimTurn,
      // Boundary position too: the turn must stop at the next iteration, not
      // only mid-stream.
      controller.signal,
      input.runnerOwnerId,
    );
  } finally {
    if (controller.signal.aborted) {
      try {
        await consultStopGate();
      } catch (cause) {
        // Never masks the turn's own outcome: the caller needs the result (or
        // the original throw) far more than it needs to hear that a cleanup
        // transaction failed, and an unconsumed row degrades to the
        // pre-existing behaviour rather than to anything unsafe.
        logger.warn("engine.gated_session_turn.stop_consume_failed", {
          sessionId: input.sessionId,
          scope: input.logScope,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    unregisterSessionSliceAbortController(input.sessionId);
  }
}
