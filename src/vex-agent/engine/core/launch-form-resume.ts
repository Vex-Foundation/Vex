/**
 * §C3b — waking the agent after the human answered the launch form it opened.
 *
 * `user-form-runtime.ts` owns the MECHANICS (park, claim-exactly-once, append
 * the result and stamp the owning record in one transaction). It deliberately
 * knows nothing about launches. This module is the launch-shaped orchestration
 * over them, and it exists as ONE exported function because it is also the ONLY
 * interface main-side code has to the wake: the submit flow calls
 * `resumeAgentAfterUserForm` and never touches the runtime primitives, so the
 * claim/stamp ordering cannot be reimplemented — or half-implemented — there.
 *
 * WHY THE TURN CANNOT JUST END. The agent's `trench.launch_request_form` call is
 * still pending when the form opens. Without this wake the run stays parked on
 * `paused_user_form` forever holding an unanswered tool call: the user's token
 * launches and the agent never learns it happened. Every terminal outcome —
 * deployed, refused, dismissed, expired — therefore resumes the turn with an
 * honest result.
 *
 * EXACTLY ONCE, through two independent guards, because a double click, a
 * retried IPC call and a submit racing the expiry sweep are all real:
 *   1. a mission run's lease claim flips `paused_user_form → running` under a
 *      row lock, so the second caller gets `already_resolved`;
 *   2. the `result_message_id IS NULL` CAS on the intent, which is the ONLY
 *      guard for a CHAT session (no run to claim). A null stamp THROWS, which
 *      rolls the transcript row back with it — that is the documented way to
 *      refuse a result whose record someone else already answered.
 */

import type { PoolClient } from "pg";

import { getById, stampResultMessageWith } from "../../db/repos/token-launch-intents.js";
import {
  claimUserFormResume,
  commitUserFormToolResult,
  userFormDismissalOutput,
  type UserFormContinuationRef,
} from "./user-form-runtime.js";

/** What actually happened to the form the agent opened. */
export type LaunchFormOutcome =
  | {
      readonly kind: "launched";
      readonly txHash: string;
      /** `null` when the receipt could not be decoded — say so, never guess. */
      readonly tokenAddress: string | null;
    }
  /** A refusal or a mined revert. `reason` is already user-safe prose. */
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "dismissed" }
  | { readonly kind: "expired" };

export type LaunchFormResumeResult =
  | { readonly resumed: true }
  | {
      readonly resumed: false;
      /**
       * `busy` is the ONLY retryable one — a live lease holder owns the session
       * right now. `already_resolved` means the turn was answered; retrying it
       * would be an attempt to append a second result for one call.
       */
      readonly reason: "intent_not_found" | "no_parked_call" | "already_resolved" | "busy";
    };

/** Thrown by the stamp to roll the transcript row back. Never escapes this module. */
class ResultAlreadyStampedError extends Error {
  constructor() {
    super("token_launch_intents: this intent already carries a result message");
    this.name = "ResultAlreadyStampedError";
  }
}

/**
 * Resume the agent's parked turn with the form's outcome.
 *
 * Session-scoped like every other intents read: the caller must name the session
 * the intent belongs to, so a resume can never reach across sessions.
 */
export async function resumeAgentAfterUserForm(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly outcome: LaunchFormOutcome;
}): Promise<LaunchFormResumeResult> {
  const intent = await getById(input.intentId, input.sessionId);
  if (intent === null) return { resumed: false, reason: "intent_not_found" };
  // Only the `agent_requested_form` path persists a tool-call id. A user-started
  // launch has no pending call and nothing to wake — that is not an error.
  if (!intent.toolCallId) return { resumed: false, reason: "no_parked_call" };

  const ref: UserFormContinuationRef = {
    sessionId: input.sessionId,
    missionRunId: intent.missionRunId,
    toolCallId: intent.toolCallId,
  };

  const claim = await claimUserFormResume(ref, `launch-form-${input.intentId}`);
  if (claim.outcome === "busy") return { resumed: false, reason: "busy" };
  if (claim.outcome === "already_resolved") {
    return { resumed: false, reason: "already_resolved" };
  }

  try {
    await commitUserFormToolResult({
      ref,
      success: input.outcome.kind === "launched",
      output: describeOutcome(input.outcome),
      stamp: async (client: PoolClient, resultMessageId: number) => {
        const stamped = await stampResultMessageWith(
          client,
          input.intentId,
          input.sessionId,
          resultMessageId,
        );
        if (stamped === null) throw new ResultAlreadyStampedError();
      },
    });
  } catch (err) {
    if (err instanceof ResultAlreadyStampedError) {
      return { resumed: false, reason: "already_resolved" };
    }
    throw err;
  }

  return { resumed: true };
}

/**
 * The tool result the model reads.
 *
 * Every branch states WHO acted and WHETHER funds moved. The model must not
 * conclude it launched the token itself, nor retry a form the user declined, nor
 * claim a launch that failed — each of those is a wrong sentence to a user about
 * their own money.
 */
function describeOutcome(outcome: LaunchFormOutcome): string {
  switch (outcome.kind) {
    case "launched":
      return (
        "The user reviewed the form and deployed the token. This is done — do not launch again. "
        + `Transaction: ${outcome.txHash}. `
        + (outcome.tokenAddress === null
          ? "The token address could not be decoded from the receipt yet; do not state one until it settles."
          : `Token address: ${outcome.tokenAddress}.`)
      );
    case "failed":
      return (
        `The launch did not go through: ${outcome.reason} `
        + "No token was created. Tell the user what happened before trying anything else."
      );
    case "dismissed":
      return userFormDismissalOutput("dismissed");
    case "expired":
      return userFormDismissalOutput("expired");
  }
}
