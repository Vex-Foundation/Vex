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
 * WHY THE TURN CANNOT JUST END. The agent's launch request-form call is
 * still pending when the form opens. Without this wake the run stays parked on
 * `paused_user_form` forever holding an unanswered tool call: the user's token
 * launches and the agent never learns it happened. Every terminal outcome —
 * deployed, broadcast-but-unconfirmed, refused, dismissed, expired — therefore
 * resumes the turn with an honest result.
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

import {
  casMarkUserFormResumeConsumedWith,
  getById,
  stampResultMessageWith,
} from "../../db/repos/token-launch-intents.js";
// STATIC, per `release-and-emit-chokepoint.test.ts`. A dynamic import here
// would put the release behind a fallible module load: a rejected import means
// the lease is never released at all, and a leaked heartbeat keeps renewing
// `expires_at`, so no TTL sweep can reclaim the session and it stays blocked
// for the life of the process. The module is safe to bind statically — it
// reaches `core/approval-runtime/` only dynamically and only AFTER the
// release, so `runtime/` keeps no static edge into `core/`.
import type { LeaseHandle } from "../runtime/lease-handle.js";
import { releaseLeaseAndEmitControlState } from "../runtime/release-and-emit.js";
import { LEASE_TTL_MS } from "./approval-runtime/helpers.js";
import {
  claimUserFormResume,
  closeUserFormContinuation,
  commitUserFormToolResult,
  userFormDismissalOutput,
  type UserFormContinuationRef,
} from "./user-form-runtime.js";

/**
 * Whether the continuation's turn got its chance to run — and, when it did, the
 * lease it ran under. The lease is HANDED BACK rather than released here: the
 * closing decision (retire the Stop, mark completion, release) has to happen
 * while it is still held, or an operator Stop landing at the end of the turn
 * outlives the continuation that should have consumed it.
 */
type DispatchOutcome =
  | { readonly kind: "dispatched"; readonly leaseHandle: LeaseHandle | null }
  | { readonly kind: "lease_busy" };

/** What actually happened to the form the agent opened. */
export type LaunchFormOutcome =
  | {
      readonly kind: "launched";
      readonly txHash: string;
      /** `null` when the receipt could not be decoded — say so, never guess. */
      readonly tokenAddress: string | null;
    }
  /**
   * BROADCAST, BUT NOT PROVEN — the third state, and the one that has no honest
   * home in either arm above. The user's gas is at stake and the token may
   * already exist, so this is not `failed` (whose "No token was created" would
   * be a false statement); nothing is confirmed, so it is not `launched`
   * either. `txHash` is `null` only when the broadcast could not be read back.
   * `reason` is the executor's own user-safe prose.
   */
  | { readonly kind: "unconfirmed"; readonly txHash: string | null; readonly reason: string }
  /** A refusal or a mined revert. `reason` is already user-safe prose. */
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "dismissed" }
  | { readonly kind: "expired" }
  /**
   * NO LONGER TRACKED, OUTCOME UNPROVEN — the recovery outcome for a form whose
   * launch was broadcast and whose intent has since been terminalized
   * `superseded_unproven` (migration 072).
   *
   * It exists because the crash window has an honest answer and `expired` is not
   * it. `expired` says the form's moment passed with nothing signed; this launch
   * WAS signed and DID spend gas, and its token may exist. Telling the model
   * "expired" here would invite exactly the relaunch this state cannot rule out.
   */
  | { readonly kind: "superseded_unproven"; readonly txHash: string };

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

  // THE consumption authority. `result_message_id` is NOT it: that stamp says
  // the transcript has the answer, which is true from the moment the result
  // commits — long before the turn it answers has been dispatched. Only a
  // COMPLETED resumed turn ends eligibility, exactly as `resume_consumed_at`
  // does for the approval lifecycle.
  if (intent.resumeConsumedAt !== null) {
    return { resumed: false, reason: "already_resolved" };
  }

  const ref: UserFormContinuationRef = {
    sessionId: input.sessionId,
    missionRunId: intent.missionRunId,
    toolCallId: intent.toolCallId,
  };
  const ownerId = `launch-form-${input.intentId}`;

  const claim = await claimUserFormResume(ref, ownerId);
  if (claim.outcome === "busy") {
    armBusyRetry(input);
    return { resumed: false, reason: "busy" };
  }
  if (claim.outcome === "already_resolved") {
    return { resumed: false, reason: "already_resolved" };
  }

  // ONE owner for the claimed lease, from here to the closing decision. The
  // mission branch's RUN lease is live from the claim above; `resumeMissionRun`
  // is explicit that the CALLER owns its lifecycle, and a stamp or dispatch
  // failure must not strand it.
  let closed = false;
  try {

  // RESULT-ALREADY-APPENDED is a RECOVERY, not a refusal. The row reaching here
  // with a stamp and no consumption is precisely the crash/restart/busy-lease
  // case: the transcript carries its answer and the turn that answer exists for
  // never ran. Re-appending would answer one tool call twice; stopping would
  // strand the turn forever. So skip the append and go straight to the dispatch.
  if (intent.resultMessageId === null) {
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
      // Someone else appended it between our read and this write. The result
      // exists either way, so the remaining work is identical to the recovery
      // branch above — fall through to the dispatch rather than giving up on a
      // turn that is still owed.
      if (!(err instanceof ResultAlreadyStampedError)) throw err;
      logger.info("engine.user_form.result_appended_concurrently", {
        intentId: input.intentId,
        sessionId: input.sessionId,
      });
    }
  }

  // The result exists; now WAKE THE AGENT. Appending without dispatching is the
  // half-fix the approval path already learned to avoid — the turn would sit
  // with its answer written and nobody reading it.
    const dispatched = await dispatchContinuation(
      ref,
      ownerId,
      claim.leaseHandle,
    );
    if (dispatched.kind === "lease_busy") {
      // NOT consumed: the turn is still owed, and the durable scan can still
      // see this row precisely because eligibility keys off
      // `resume_consumed_at` rather than off the result stamp. An in-process
      // ladder would not be enough on its own — a crash here has no process
      // left to retry in.
      armBusyRetry(input);
      return { resumed: false, reason: "busy" };
    }

    // CLOSE IT: retire the operator's Stop, write the COMPLETION marker, and
    // release the lease — in one ordering, while the lease is still held. See
    // `closeUserFormContinuation` for the interleaving that ordering exists
    // for. The marker is written even when the gated turn declined on a stop: a
    // stop is a terminal answer to this continuation, not a reason to retry it
    // forever.
    await closeUserFormContinuation({
      sessionId: input.sessionId,
      leaseHandle: dispatched.leaseHandle,
      consume: async (client) => {
        const recorded = await casMarkUserFormResumeConsumedWith(
          client,
          input.intentId,
          input.sessionId,
        );
        if (!recorded) {
          logger.info("engine.user_form.resume_completion_already_recorded", {
            intentId: input.intentId,
            sessionId: input.sessionId,
          });
        }
      },
    });
    closed = true;
    return { resumed: true };
  } finally {
    // Every exit that did NOT reach the closing decision — a stamp throw, a
    // dispatch throw, a busy lease — still owes the claimed RUN lease its
    // release. The chat branch's own lease is released by the close, or was
    // never claimed.
    if (!closed && claim.leaseHandle !== null) {
      await releaseLeaseAndEmitControlState(
        claim.leaseHandle,
        input.sessionId,
        { missionRunId: ref.missionRunId },
      ).catch(() => undefined);
    }
  }
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
 * `resumeMissionRun` under the run lease its claim already took; a chat session
 * claims the SESSION lease here and runs the shared stop-gated turn. Dynamic
 * imports for the same reason that module uses them — the runner imports the
 * engine core back, and a static edge here is a cycle.
 *
 * ## Why the chat branch claims a lease and a gate, and why HERE
 *
 * It used to call `runAgentTurnUnderLease` — the LEASE-ALREADY-HELD runner —
 * with no lease held at all, no operator-stop gate and no abort signal. Three
 * consequences, all real:
 *
 *   - a full model turn could overlap a turn another runner was already
 *     driving, because nothing excluded them;
 *   - a Stop committed in the gap between the result being appended and this
 *     dispatch was retired as "nothing will observe it" and the turn then ran
 *     anyway — the operator stopped the session and the agent kept going, on
 *     the LAUNCH path, where the next thing it does can spend real money;
 *   - a Stop landing mid-turn had no controller to fire.
 *
 * The lease is claimed at DISPATCH rather than at claim time on purpose. The
 * tool result is a durable write that must land whatever else is running — the
 * form's outcome is a fact about the user's money and delaying it behind a
 * lease would risk losing it. What must not overlap, and what must observe the
 * operator's Stop, is the MODEL TURN. So the exclusion is placed exactly there.
 *
 * A busy lease is not an error: the result is already stamped, so the durable
 * floor (`listOutstandingUserFormResumes`) finds this row again and a later
 * dispatch is safe.
 */
async function dispatchContinuation(
  ref: UserFormContinuationRef,
  ownerId: string,
  missionLease: LeaseHandle | null,
): Promise<DispatchOutcome> {
  if (ref.missionRunId !== null) {
    const { resumeMissionRun } = await import("./runner/mission.js");
    await resumeMissionRun(ref.missionRunId, ownerId);
    // The RUN lease the claim acquired, handed straight back — this function
    // never owned it and must not release it.
    return { kind: "dispatched", leaseHandle: missionLease };
  }

  const { claimSessionLease } = await import(
    "../runtime/lease-and-status.js"
  );
  const claim = await claimSessionLease({
    sessionId: ref.sessionId,
    ownerId,
    processKind: "electron_main",
    ttlMs: LEASE_TTL_MS,
  });
  if (claim.outcome === "lease_busy") {
    logger.info("engine.user_form.dispatch_lease_busy", {
      sessionId: ref.sessionId,
      ownerId,
    });
    return { kind: "lease_busy" };
  }

  const { createLeaseHandle } = await import("../runtime/lease-handle.js");
  const handle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });
  const { runStopGatedSessionTurn } = await import(
    "./runner/gated-session-turn.js"
  );
  await runStopGatedSessionTurn({
    sessionId: ref.sessionId,
    runnerOwnerId: ownerId,
    logScope: "launch_form_resume",
  });
  return { kind: "dispatched", leaseHandle: handle };
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
    case "unconfirmed":
      // Deliberately mirrors the executor's own ambiguous wording
      // (the launch execute's `ambiguous` outcome): the two paths describe the SAME
      // event, and a model told "done" here while the tool result says
      // "unconfirmed" learns whichever it read last.
      return (
        // Not "deployed": the word is the one the model latches onto, and
        // nothing here proves a deployment happened.
        `The user reviewed the form and submitted the launch, but it is NOT confirmed: ${outcome.reason} `
        + (outcome.txHash === null
          ? "The broadcast returned no transaction hash, so it cannot be checked yet. "
          : `Transaction: ${outcome.txHash}. `)
        + "It is recorded as pending and will resolve automatically — DO NOT launch again and do "
        + "not retry. Tell the user it is still settling; do not say the token exists until it "
        + "confirms."
      );
    case "failed":
      return (
        `The launch did not go through: ${outcome.reason} `
        + "No token was created. Tell the user what happened before trying anything else."
      );
    case "superseded_unproven":
      // Mirrors the `unconfirmed` arm's discipline and stops short of its
      // promise: that one resolves automatically, this one already did and
      // resolved to "nobody knows". Neither "deployed" nor "did not go through"
      // is a sentence the evidence supports.
      return (
        "The user reviewed the form and submitted the launch. It was broadcast, but the "
        + "transaction is no longer tracked and what actually happened was never "
        + `established. Transaction: ${outcome.txHash}. `
        + "The token MAY exist. Vex has stopped checking this hash, so it will not resolve on its "
        + "own. DO NOT launch again on the assumption it failed - tell the user it is unresolved "
        + "and check whether the token exists before doing anything else."
      );
    case "dismissed":
      return userFormDismissalOutput("dismissed");
    case "expired":
      return userFormDismissalOutput("expired");
  }
}
