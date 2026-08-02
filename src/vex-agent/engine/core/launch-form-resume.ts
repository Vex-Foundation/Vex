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

import logger from "@utils/logger.js";

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

/**
 * Backoff ladder for a resume that lost the lease race, copied in shape and
 * intent from `approval-runtime/deferred-resume.ts`.
 *
 * `busy` means another runner holds the session RIGHT NOW — the ordinary case
 * being a user who deploys while a turn is still in flight. Short and finite on
 * purpose: this covers "the other runner finishes in a moment". Anything longer
 * is the durable floor's job (`listOutstandingUserFormResumes`, which finds any
 * parked form whose result was never appended), not a polling loop's.
 */
const BUSY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

/** Intents with a retry ladder already armed in this process. */
const retryingIntents = new Set<string>();

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
  if (claim.outcome === "busy") {
    armBusyRetry(input);
    return { resumed: false, reason: "busy" };
  }
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

  // The result exists; now WAKE THE AGENT. Appending without dispatching is the
  // half-fix the approval path already learned to avoid — the turn would sit
  // with its answer written and nobody reading it. Failure to dispatch does not
  // undo the result: the outstanding scan below finds this row again, and a
  // second dispatch is safe because the result is already stamped.
  await dispatchContinuation(ref, `launch-form-${input.intentId}`);
  return { resumed: true };
}

/**
 * Arm a bounded retry ladder for a resume that lost the lease race.
 *
 * Idempotent per intent: a second `busy` for the same form does not stack a
 * second ladder. Each rung simply calls back in, so the first rung that wins the
 * lease resumes and every later rung short-circuits on `already_resolved` — the
 * exactly-once guarantee is unchanged, since it lives in the claim and the
 * stamp, not here.
 *
 * Not awaited by the caller by design. Main-side IPC must answer the user's
 * click immediately; the wake is allowed to land a moment later.
 */
function armBusyRetry(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly outcome: LaunchFormOutcome;
}): void {
  if (retryingIntents.has(input.intentId)) return;
  retryingIntents.add(input.intentId);

  void (async () => {
    try {
      for (const delayMs of BUSY_RETRY_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const retry = await resumeAgentAfterUserForm(input).catch((err: unknown) => {
          logger.warn("engine.user_form.retry_failed", {
            intentId: input.intentId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { resumed: false, reason: "busy" } as const;
        });
        // Anything other than a still-busy lease is settled: resumed, already
        // answered, or a form that no longer exists. Stop either way.
        if (retry.resumed || retry.reason !== "busy") return;
      }
      logger.warn("engine.user_form.retry_exhausted", {
        intentId: input.intentId,
        sessionId: input.sessionId,
      });
    } finally {
      retryingIntents.delete(input.intentId);
    }
  })();
}

/**
 * Run the agent's next turn now that the form's result is in the transcript.
 *
 * Mirrors `approval-runtime/continuation.ts`: a mission run resumes through
 * `resumeMissionRun`, a chat session through `runAgentTurnUnderLease`. Dynamic
 * imports for the same reason that module uses them — the runner imports the
 * engine core back, and a static edge here is a cycle.
 */
async function dispatchContinuation(
  ref: UserFormContinuationRef,
  ownerId: string,
): Promise<void> {
  if (ref.missionRunId !== null) {
    const { resumeMissionRun } = await import("./runner/mission.js");
    await resumeMissionRun(ref.missionRunId, ownerId);
    return;
  }

  const { resolveProvider } = await import("@vex-agent/inference/registry.js");
  const provider = await resolveProvider();
  if (!provider) throw new Error("No inference provider available");
  const config = await provider.loadConfig();
  if (!config) throw new Error("No inference config available");

  const { runAgentTurnUnderLease } = await import("./runner/agent.js");
  await runAgentTurnUnderLease(ref.sessionId, provider, config);
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
