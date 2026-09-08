/**
 * THE USER DISMISSED THE LAUNCH FORM THE AGENT ASKED FOR.
 *
 * ── WHAT THIS CLOSES ──────────────────────────────────────────────────────
 * `pools.launch_request_form` drafts an `awaiting_user_form` intent and PARKS
 * the agent's turn on it. Closing that dialog used to do nothing to the row:
 * the intent stayed live and the parked turn waited until the fifteen-minute
 * window lapsed and `sync/launch-form-expiry.ts` swept it. The user had
 * answered; the agent was told a quarter of an hour later, and was told the
 * form "expired" rather than that they declined it.
 *
 * The launch lane retired by migration 108 did have a cancel-by-intent-id, and
 * nothing inherited it: `cancelPoolsLaunch` takes a `fingerprintId` and cancels
 * a PREPARED launch, which is a different object at a later stage. This module
 * is the missing one, rebuilt on the pools lane's own contract.
 *
 * ── TWO WRITES, ORDERED, EXACTLY AS THE EXPIRY SWEEP ORDERS THEM ──────────
 * CANCEL FIRST, THEN RESUME. The row's terminal state is the fact; the wake is
 * the notification. Waking first would tell a turn its form was declined while
 * the form was still live and submittable, and the user could then deploy a
 * launch the agent had already been told was gone.
 *
 * A RESUME FAILURE DOES NOT UN-CANCEL THE ROW. The user genuinely dismissed the
 * form; that is true whether or not a lease was free to wake the turn. A busy
 * lease leaves the continuation OWED, and the durable floor in
 * `sync/launch-form-expiry.ts` (`listOutstandingUserFormResumes`) is what finds
 * it again - which is why `resumedAgentTurn` reports what happened rather than
 * what was attempted.
 *
 * A CAS MISS IS NOT AN ERROR. `cancelIfAwaitingWith` carries
 * `status = 'awaiting_user_form'` in its predicate, so a miss means the form was
 * submitted or swept in the same instant. THAT path owns the resume, and this
 * one must not append a second result for one parked call - so the miss is
 * reported as `cancelled: false` rather than dressed up as a failure.
 *
 * ── NO FAILURE REASON IS WRITTEN, DELIBERATELY ────────────────────────────
 * `cancelIfAwaitingWith` stamps the status and nothing else, and that is the
 * behaviour this path needs. `recoveryOutcomeFor` in the expiry sweep reads a
 * `cancelled` row WITH a `failure_reason` as a cancellation somebody OTHER than
 * the user made, and answers the model `failed` with that prose. A user's own
 * dismissal carries no reason precisely so the recovery path keeps saying the
 * form's moment passed instead of asserting the launch failed. The
 * user-dismissed sentence travels on the WAKE, where it belongs:
 * `userFormDismissalOutput("dismissed")` states that the user declined and that
 * nothing was created and no funds moved.
 *
 * ── NEVER SIGNS AND NEVER SPENDS ──────────────────────────────────────────
 * No fingerprint, no plan builder, no signer, no fee. It reads one row, takes
 * the session control lock every other money-state writer takes, moves a status
 * one way, and appends a tool result. `awaiting_user_form` is the ONLY status it
 * can move; every other one is refused by name, including the terminal ones and
 * the advisory `previewed` rows a pools preview writes.
 */

import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  cancelIfAwaitingWith,
  getById,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { resumeAgentAfterUserForm } from "@vex-agent/engine/core/launch-form-resume.js";

import type {
  CancelAwaitingPoolsLaunchForm,
  PoolsAwaitingFormCancellation,
  PoolsLaunchOutcome,
  PoolsLaunchRefusalKind,
} from "./runtime-contract.js";

function refusal(
  kind: PoolsLaunchRefusalKind,
  message: string,
): PoolsLaunchOutcome<PoolsAwaitingFormCancellation> {
  return { ok: false, refusal: { kind, message } };
}

/**
 * What to tell the user about a form that is not theirs to cancel any more.
 *
 * Every status gets its OWN sentence, because "cannot be cancelled" alone is
 * unactionable and the four live-or-terminal families mean genuinely different
 * things: one is mid-signature, one already reached the chain, and the rest are
 * over. The status name itself is our own vocabulary, not provider text and not
 * a secret, so naming it is what makes the refusal diagnosable.
 */
function whyNotCancellable(status: string): string {
  switch (status) {
    case "previewed":
      return (
        "That launch is a preview, not an open form: it holds no authorization and nothing is "
        + "waiting on it, so there is nothing to cancel."
      );
    case "authorized":
    case "consuming":
      return (
        "That launch has already been authorized and is being signed, so it can no longer be "
        + "cancelled. Check Agent Scan for how it settles."
      );
    case "broadcast_pending":
    case "awaiting_keeper":
      return (
        "That launch has already been broadcast, so it cannot be cancelled. Check Agent Scan for "
        + "how it settles."
      );
    default:
      return (
        `That launch form is already ${status} and cannot be cancelled again. Nothing further was `
        + "signed or spent."
      );
  }
}

export const cancelAwaitingPoolsLaunchForm: CancelAwaitingPoolsLaunchForm = async (
  session,
  inputs,
) => {
  let intent;
  try {
    // SESSION-SCOPED READ. `getById` carries the session id in its predicate, so
    // another session's intent MISSES even when its id is known - a foreign id
    // and an unknown id are answered identically, on purpose.
    intent = await getById(inputs.intentId, session.sessionId);
  } catch (err) {
    return refusal(
      "provider_unavailable",
      `That launch form could not be read (${err instanceof Error ? err.name : "unknown"}), so it `
        + "was not cancelled. It expires on its own, and nothing was signed.",
    );
  }

  if (intent === null) {
    return refusal(
      "form_not_cancellable",
      "No launch form is waiting under that id in this session, so there was nothing to cancel.",
    );
  }
  if (intent.protocol !== "pools_fun") {
    // The intents table carries every launchpad's forms. A pools dismissal must
    // not terminalize another venue's launch, whose own lane owns that decision.
    return refusal(
      "form_not_cancellable",
      "That launch form belongs to a different launchpad, so the pools.fun dialog will not "
        + "cancel it.",
    );
  }
  if (intent.status !== "awaiting_user_form") {
    return refusal("form_not_cancellable", whyNotCancellable(intent.status));
  }

  let cancelled;
  try {
    // The SAME lock and the SAME writer the expiry sweep uses. Cancellation
    // moves the intent out of the live set the compaction gate and the
    // image-locker deletion check both read, so it takes the session control
    // lock every other money-state writer does. DB-only and short.
    cancelled = await withSessionControlLock(session.sessionId, (client) =>
      cancelIfAwaitingWith(client, inputs.intentId, session.sessionId));
  } catch (err) {
    return refusal(
      "provider_unavailable",
      `That launch form could not be cancelled (${err instanceof Error ? err.name : "unknown"}). `
        + "It expires on its own, and nothing was signed.",
    );
  }

  if (cancelled === null) {
    // Nothing live to cancel, and deliberately NOT a wake: whoever won the race
    // owns the parked call's one result, and a second "dismissed" would try to
    // answer it twice.
    return { ok: true, value: { cancelled: false, resumedAgentTurn: false } };
  }

  // A THROW here must not un-cancel the row, so the wake is contained. The
  // continuation stays owed and the durable floor finds it again.
  const resumed = await resumeAgentAfterUserForm({
    intentId: inputs.intentId,
    sessionId: session.sessionId,
    outcome: { kind: "dismissed" },
  }).catch(() => ({ resumed: false }) as const);

  return { ok: true, value: { cancelled: true, resumedAgentTurn: resumed.resumed } };
};
