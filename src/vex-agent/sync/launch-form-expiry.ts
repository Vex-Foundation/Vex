/**
 * Launch-form EXPIRY — the sweep that makes "the form expires and your turn
 * resumes" true.
 *
 * `expireIfAwaitingWith` existed, was correct, and had no production caller. So
 * an `agent_requested_form` launch the user walked away from parked the agent's
 * turn FOREVER: nothing ever stamped the row `expired`, and nothing appended
 * the tool result the parked `trench.launch_request_form` call was waiting for.
 * The manifest promised a turn that resumes; the runtime delivered one that
 * hangs until the process restarts.
 *
 * ── Two writes, ordered, and deliberately independent ──────────────────────
 *
 * EXPIRE FIRST, THEN RESUME. The row's terminal state is the fact; the resume
 * is the notification. Waking the agent first would tell a turn its form died
 * while the form was still live and submittable — and the user could then
 * deploy a launch the agent had already been told expired.
 *
 * A RESUME FAILURE DOES NOT UN-EXPIRE THE ROW. The window genuinely lapsed;
 * that is true whether or not the agent could be woken. `busy` means a live
 * lease holds the session and the next tick will find nothing to expire but the
 * turn still parked — which is why failures are COUNTED and logged rather than
 * swallowed, so a session that can never be resumed is visible instead of
 * silently stuck. (`resumeAgentAfterUserForm` is itself idempotent per parked
 * call: `already_resolved` is one of its outcomes, never a second result.)
 *
 * A CAS MISS IS NOT AN ERROR. `expireIfAwaitingWith` carries `expires_at <=
 * NOW()` and `status = 'awaiting_user_form'` in its predicate, so a miss means
 * the user submitted or dismissed the form in the same instant. THAT path owns
 * the resume; this sweep must not append a second result for one parked call.
 *
 * A FAILURE IS NOT FOREVER, AND NEITHER IS A RETRY (A2). "Failures are counted
 * and logged rather than swallowed" was right about visibility and wrong about
 * cadence: a continuation that could never be delivered warned once a minute
 * for the life of the process. Two bounds now sit between the candidate set and
 * the retry — an ORPHAN check (a resume against a deleted session cannot
 * succeed, so it is retired with a named reason instead of attempted) and a
 * bounded ladder in `launch-form-expiry/continuation-retry.ts` (60s → 5min →
 * next app start, with a deterministic refusal twice over parking the row).
 * Both close only the owed MODEL TURN; the launch's own row is untouched.
 *
 * NEVER SIGNS AND NEVER SPENDS. Its whole authority is "a deadline passed".
 */

import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  casCloseUserFormContinuationWith,
  expireIfAwaitingWith,
  listOutstandingUserFormResumes,
  listOverdueAwaitingForms,
  type TokenLaunchIntent,
  type UserFormContinuationCloseReason,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { isSessionResumable } from "@vex-agent/db/repos/sessions.js";
import { resumeAgentAfterUserForm } from "@vex-agent/engine/core/launch-form-resume.js";
import {
  describeFailureForLog,
  summarizeProtocolError,
  type ErrorCategory,
} from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import {
  forgetContinuation,
  isContinuationDue,
  noteContinuationFailure,
  type ContinuationPromptFacts,
} from "./launch-form-expiry/continuation-retry.js";

/**
 * Bounded batch per run, mirroring the identity sweep: this shares the sync
 * worker's drain with balance and activity sync, and each row can do a resume
 * that takes the session control lock.
 *
 * Unlike the identity sweep this needs no rotation stamp — expiry is TERMINAL,
 * so a swept row leaves the candidate set permanently and cannot starve the
 * rows behind it.
 */
export const LAUNCH_FORM_EXPIRY_BATCH_LIMIT = 25;

export interface LaunchFormExpiryResult {
  readonly checked: number;
  /** Rows moved `awaiting_user_form → expired` by THIS run. */
  readonly expired: number;
  /** Parked turns actually woken. Always <= `expired`: a user-started form has none. */
  readonly resumed: number;
  /** Expired rows whose parked turn could NOT be woken — busy, or a throw. */
  readonly resumeFailures: number;
  /** Continuations recovered by the durable floor below (crash / busy lease). */
  readonly recovered: number;
  /** Floor candidates that still could not be delivered this pass. */
  readonly recoveryFailures: number;
  /**
   * Continuations RETIRED because no turn can ever run for them — a deleted
   * session, or the same deterministic refusal twice. They leave the outstanding
   * set permanently and are counted apart from failures, which are retried.
   */
  readonly closed: number;
}

export async function expireOverdueLaunchForms(): Promise<LaunchFormExpiryResult> {
  const candidates = await listOverdueAwaitingForms(LAUNCH_FORM_EXPIRY_BATCH_LIMIT);
  let expired = 0;
  let resumed = 0;
  let resumeFailures = 0;
  let closed = 0;

  for (const intent of candidates) {
    const stamped = await withSessionControlLock(intent.sessionId, (client) =>
      expireIfAwaitingWith(client, intent.intentId, intent.sessionId));
    if (stamped === null) {
      logger.info("trench.launch_form_expiry.cas_miss", { intentId: intent.intentId });
      continue;
    }
    expired++;

    const outcome = await resumeParkedTurn(intent);
    if (outcome === "resumed") resumed++;
    else if (outcome === "failed") resumeFailures++;
    else if (outcome === "closed") closed++;
  }

  const recovery = await deliverOutstandingContinuations();
  closed += recovery.closed;

  if (expired > 0 || resumeFailures > 0 || recovery.recovered > 0
      || recovery.recoveryFailures > 0 || closed > 0) {
    logger.info("trench.launch_form_expiry.swept", {
      expired,
      resumed,
      resumeFailures,
      recovered: recovery.recovered,
      recoveryFailures: recovery.recoveryFailures,
      closed,
    });
  }
  return {
    checked: candidates.length,
    expired,
    resumed,
    resumeFailures,
    recovered: recovery.recovered,
    recoveryFailures: recovery.recoveryFailures,
    closed,
  };
}

/**
 * THE DURABLE FLOOR, finally driven.
 *
 * `listOutstandingUserFormResumes` existed and had no production caller — the
 * same defect this module was written to fix for `expireIfAwaitingWith`, one
 * layer down. Every doc comment that promised "a failure to dispatch does not
 * lose the wake, the outstanding scan finds this row again" was describing a
 * sweep nobody ran.
 *
 * It matters most for the interleaving the resume cannot handle in-process: the
 * form's result is stamped, then the session lease is claimed, then the turn
 * runs. A busy lease, a crash or a restart between the stamp and the turn
 * leaves an ANSWERED tool call with no turn to read it, and an in-process retry
 * ladder cannot help — a crash has no process left to retry in. Eligibility
 * keys off `resume_consumed_at`, so exactly those rows are still visible here.
 *
 * `resumeAgentAfterUserForm` is the ONE interface, so this reuses every guard
 * it owns: it skips the append when a result already exists, dispatches through
 * the stop-gated lease-held path, and stamps the completion marker itself. The
 * `expired` outcome passed here is only used when a row somehow has no result
 * yet — a settled intent that never got one — and is the honest thing to say
 * about a form whose moment has passed.
 *
 * Same bounded batch and same containment as the expiry pass above: one stuck
 * session must not abort the sweep for every other row.
 */
async function deliverOutstandingContinuations(): Promise<{
  readonly recovered: number;
  readonly recoveryFailures: number;
  readonly closed: number;
}> {
  const outstanding = await listOutstandingUserFormResumes(
    LAUNCH_FORM_EXPIRY_BATCH_LIMIT,
  );
  let recovered = 0;
  let recoveryFailures = 0;
  let closed = 0;

  for (const intent of outstanding) {
    // A continuation whose ladder has not come round yet is not skipped
    // silently — it is simply not due, and its earlier failure was already
    // reported. Counting it again every minute is the warn-loop this ends.
    if (!isContinuationDue(intent.intentId, Date.now())) continue;

    const outcome = await resumeParkedTurn(intent);
    if (outcome === "resumed") recovered++;
    else if (outcome === "failed") recoveryFailures++;
    else if (outcome === "closed") closed++;
  }

  return { recovered, recoveryFailures, closed };
}

/** What one sweep attempt did with a parked turn. */
type ParkedTurnOutcome = "resumed" | "nothing_parked" | "failed" | "closed";

/**
 * Wake the parked turn, or report why not.
 *
 * `no_parked_call` is NOT a failure: a user-started launch has no pending tool
 * call and nothing to wake, which is the normal shape of that path rather than
 * a problem to count. A throw is contained here so one stuck session cannot
 * abort the sweep for every other row.
 *
 * `closed` is the outcome added for A2: the continuation can NEVER complete, so
 * it is retired durably instead of being retried until the process dies.
 */
async function resumeParkedTurn(intent: TokenLaunchIntent): Promise<ParkedTurnOutcome> {
  const { intentId, sessionId } = intent;

  // ORPHAN CHECK FIRST, because a resume against a deleted session builds its
  // prompt from a history that no longer exists — it cannot succeed, and its
  // refusal tells us nothing we could not have known before spending the call.
  if (!(await isSessionResumable(sessionId))) {
    return closeContinuation(intent, "session_deleted");
  }

  const prompt: ContinuationPromptFacts = {
    resultMessageId: intent.resultMessageId,
    status: intent.status,
  };

  try {
    const result = await resumeAgentAfterUserForm({
      intentId,
      sessionId,
      outcome: { kind: "expired" },
    });
    if (result.resumed) {
      forgetContinuation(intentId);
      return "resumed";
    }
    if (result.reason === "no_parked_call") {
      forgetContinuation(intentId);
      return "nothing_parked";
    }
    logger.warn("trench.launch_form_expiry.resume_declined", { intentId, reason: result.reason });
    // A decline is a state answer, never a provider refusal: `busy` and
    // `already_resolved` say nothing about whether the request itself is sound,
    // so they can only ever move the ladder, never park it.
    return applyRetryDecision(intent, prompt, { deterministic: false, signature: result.reason });
  } catch (err) {
    const summary = summarizeProtocolError(err);
    const status = httpStatusOf(err, summary);
    logger.warn("trench.launch_form_expiry.resume_failed", {
      intentId,
      status,
      // The canonical scrub boundary — a runtime error can carry prompt text,
      // provider payloads and session content.
      error: describeFailureForLog(err),
    });
    return applyRetryDecision(intent, prompt, {
      deterministic: isDeterministicRefusal(status, summary.category),
      signature: `${summary.code}/${status ?? "none"}`,
    });
  }
}

/**
 * The provider's own status, when the throw carried one.
 *
 * `SafeErrorSummary.httpStatus` only travels on a `VexError`, and the failure
 * this whole path exists for comes from the model provider's SDK, which reports
 * its status as a plain numeric property. So the object is read as the
 * untrusted input it is: a bounded integer or nothing, never a coerced string.
 */
function httpStatusOf(err: unknown, summary: { readonly httpStatus?: number }): number | undefined {
  if (summary.httpStatus !== undefined) return summary.httpStatus;
  if (typeof err !== "object" || err === null) return undefined;
  const carried = (err as { status?: unknown; statusCode?: unknown });
  for (const value of [carried.status, carried.statusCode]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value < 600) {
      return value;
    }
  }
  return undefined;
}

/**
 * A failure the next attempt would earn identically — the only kind worth
 * parking on, because parking retires a turn the agent is genuinely owed.
 *
 * Deliberately NARROW. 408 and 429 are 4xx that a later attempt fixes, and
 * 401/403 usually mean a credential the USER can repair — none of those should
 * cost the user their turn permanently. They are still bounded: the ladder puts
 * them to sleep until the next app start.
 *
 * When no status travelled, the classifier's own verdict stands in for it: a
 * malformed request, a policy refusal and an unparseable response are refusals
 * of what we SENT, and the sweep sends the same thing every time.
 */
function isDeterministicRefusal(httpStatus: number | undefined, category: ErrorCategory): boolean {
  if (httpStatus !== undefined) {
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 408 || httpStatus === 429) {
      return false;
    }
    return httpStatus >= 400 && httpStatus < 500;
  }
  return category === "invalid_request"
    || category === "policy_refusal"
    || category === "response_schema";
}

async function applyRetryDecision(
  intent: TokenLaunchIntent,
  prompt: ContinuationPromptFacts,
  failure: { readonly deterministic: boolean; readonly signature: string },
): Promise<ParkedTurnOutcome> {
  const decision = noteContinuationFailure({
    intentId: intent.intentId,
    failure,
    prompt,
    now: Date.now(),
  });
  if (decision.kind === "park") return closeContinuation(intent, decision.reason);
  if (decision.kind === "dormant_until_restart") {
    logger.info("trench.launch_form_expiry.retry_dormant", {
      intentId: intent.intentId,
      // Not "given up": the next app start gets one more ladder, because a
      // restart genuinely changes what a resume runs against.
      until: "next_app_start",
    });
  }
  return "failed";
}

/**
 * Retire a continuation no turn will ever run for, ONCE.
 *
 * The write is the write-once CAS, so a real completion that landed in the
 * meantime wins and this logs nothing. That is what makes the info line
 * trustworthy as "this happened once" rather than "the sweep is still trying".
 *
 * Nothing about the LAUNCH changes here: its status, hash and fee are facts
 * about the user's money and a model turn nobody can deliver does not alter
 * them.
 */
async function closeContinuation(
  intent: TokenLaunchIntent,
  reason: UserFormContinuationCloseReason,
): Promise<ParkedTurnOutcome> {
  const recorded = await withSessionControlLock(intent.sessionId, (client) =>
    casCloseUserFormContinuationWith(client, intent.intentId, intent.sessionId, reason));
  forgetContinuation(intent.intentId);
  if (recorded) {
    logger.info("trench.launch_form_expiry.continuation_closed", {
      intentId: intent.intentId,
      reason,
    });
  }
  return "closed";
}
