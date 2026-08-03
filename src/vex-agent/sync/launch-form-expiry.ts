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
 * NEVER SIGNS AND NEVER SPENDS. Its whole authority is "a deadline passed".
 */

import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  expireIfAwaitingWith,
  listOverdueAwaitingForms,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { resumeAgentAfterUserForm } from "@vex-agent/engine/core/launch-form-resume.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

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
}

export async function expireOverdueLaunchForms(): Promise<LaunchFormExpiryResult> {
  const candidates = await listOverdueAwaitingForms(LAUNCH_FORM_EXPIRY_BATCH_LIMIT);
  let expired = 0;
  let resumed = 0;
  let resumeFailures = 0;

  for (const intent of candidates) {
    const stamped = await withSessionControlLock(intent.sessionId, (client) =>
      expireIfAwaitingWith(client, intent.intentId, intent.sessionId));
    if (stamped === null) {
      logger.info("trench.launch_form_expiry.cas_miss", { intentId: intent.intentId });
      continue;
    }
    expired++;

    const outcome = await resumeParkedTurn(intent.intentId, intent.sessionId);
    if (outcome === "resumed") resumed++;
    else if (outcome === "failed") resumeFailures++;
  }

  if (expired > 0 || resumeFailures > 0) {
    logger.info("trench.launch_form_expiry.swept", { expired, resumed, resumeFailures });
  }
  return { checked: candidates.length, expired, resumed, resumeFailures };
}

/**
 * Wake the parked turn, or report why not.
 *
 * `no_parked_call` is NOT a failure: a user-started launch has no pending tool
 * call and nothing to wake, which is the normal shape of that path rather than
 * a problem to count. A throw is contained here so one stuck session cannot
 * abort the sweep for every other row.
 */
async function resumeParkedTurn(
  intentId: string,
  sessionId: string,
): Promise<"resumed" | "nothing_parked" | "failed"> {
  try {
    const result = await resumeAgentAfterUserForm({
      intentId,
      sessionId,
      outcome: { kind: "expired" },
    });
    if (result.resumed) return "resumed";
    if (result.reason === "no_parked_call") return "nothing_parked";
    logger.warn("trench.launch_form_expiry.resume_declined", { intentId, reason: result.reason });
    return "failed";
  } catch (err) {
    logger.warn("trench.launch_form_expiry.resume_failed", {
      intentId,
      // The canonical scrub boundary — a runtime error can carry prompt text,
      // provider payloads and session content.
      error: summarizeProtocolError(err).message,
    });
    return "failed";
  }
}
