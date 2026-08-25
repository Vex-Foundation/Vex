/**
 * `StudioCallOutcome` -> `CallToolResult`. The ONE projection, pinned here.
 *
 * Seven outcome kinds reach an external agent, and each has a different
 * remedy. Collapsing any two of them would make the agent do the wrong thing
 * with at least one, so every kind gets its own sentence and the sentence says
 * what did or did not happen. Nothing here is ever "unexpected error".
 *
 * ## The three rules that are not negotiable
 *
 *   1. THE OUTPUT IS NEVER CUT. `completed` carries the whole
 *      `result.output`. The description budget puts the critical facts first
 *      at the source; this boundary does not get to decide the reader ran out
 *      of room (repo decree on silent content cutting).
 *   2. `isError: true` EXACTLY when the call did not produce a successful
 *      result. For `completed` that is `result.success === false`, which
 *      includes a `configuration_unavailable` refusal and a handler failure. A
 *      successful result OMITS `isError` rather than sending `false`.
 *   3. `indeterminate` LEADS WITH DO-NOT-RETRY. MCP has no machine-readable
 *      no-retry annotation, so the only channel is the first words the model
 *      reads. The action may have moved real funds; a retry is the one thing
 *      that must not happen.
 *
 * ## O5 stays deferred
 *
 * `structuredContent` is never emitted. `ToolResult.data`, the approval
 * preview and the policy metadata are internal shapes that A3 needs whole and
 * that no external contract has been reviewed for. Publishing them here would
 * freeze them as a wire format by accident.
 */

import type { StudioCallOutcome } from "./outcome.js";

/**
 * The `CallToolResult` fields Vex produces, structurally.
 *
 * Declared here rather than imported from the SDK so this projection - the
 * part that is pure product copy and pure policy - can be tested without
 * loading a server. `server.ts` returns these values where the SDK's own
 * `CallToolResult` is expected, which is where a drift would fail to compile.
 */
export type StudioCallToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

function textResult(text: string, isError: boolean): StudioCallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/**
 * The sentence for a refusal that Vex could not prove it recorded.
 *
 * `confirmed: false` means the cancellation write did not reach the database.
 * The scheduled sweep reconciles the row, but until then the agent must not be
 * told the action was cleanly cancelled - the honest answer is that Vex is
 * still resolving it.
 */
function refusedSentence(reason: string, confirmed: boolean): string {
  if (confirmed) {
    return (
      "This action was REFUSED by Vex before it ran. Nothing was executed and "
      + `no funds moved. ${reason}`
    );
  }
  return (
    "This action was refused by Vex before it ran, and Vex could NOT confirm "
    + "that it recorded the refusal, so treat the outcome as unresolved rather "
    + `than cleanly cancelled. Do not retry. ${reason} `
    + "Check the approval in Vex before asking again."
  );
}

/**
 * The DO-NOT-RETRY sentence, and the order of its clauses is the contract.
 *
 * A client that shows an agent only the head of an error message must still
 * receive the instruction, so the instruction is first and the explanation
 * follows it.
 */
export const STUDIO_INDETERMINATE_SENTENCE =
  "DO NOT RETRY THIS CALL. Vex approved and dispatched this action but cannot "
  + "prove whether it took effect, so its outcome is UNKNOWN and it may have "
  + "moved funds. Retrying could execute it a second time. Vex reconciles the "
  + "approval itself - open Vex and read the approval before doing anything "
  + "else with this account.";

/**
 * The sentence for a tool handler that THREW instead of returning an outcome.
 *
 * A throw out of `runCall` is the one path where Vex has no outcome at all: the
 * executor decided nothing, so whether the action ran is genuinely UNKNOWN.
 * `dispatch_failed` would claim "nothing was executed", which the thrower did
 * not prove, and `indeterminate` names an approval this call may never have
 * reached. So this is its own sentence, and it leads with DO NOT RETRY for the
 * same reason `indeterminate` does: MCP carries no machine-readable no-retry
 * annotation, and the first words are the only channel.
 *
 * It carries the CORRELATION ID and nothing else. The thrown error's own
 * message is peer- or provider-shaped text that can quote a path, a URL, a
 * stack or a payload; it is logged redacted by its classification at the
 * boundary and never crosses the wire (rules 04 error layers, 07 secrets).
 */
export function studioHandlerFailureSentence(correlationId: string): string {
  return (
    "DO NOT RETRY THIS CALL. Vex failed while carrying out this action and "
    + "could not determine what happened, so its outcome is UNRESOLVED and it "
    + "may have taken effect. Retrying could execute it a second time. Open Vex "
    + "and check this action before doing anything else with this account. "
    + `Vex correlation id: ${correlationId}.`
  );
}

/** The `isError` result for a handler that threw. Never carries the cause. */
export function studioHandlerFailureResult(correlationId: string): StudioCallToolResult {
  return textResult(studioHandlerFailureSentence(correlationId), true);
}

export function studioOutcomeToCallToolResult(
  outcome: StudioCallOutcome,
): StudioCallToolResult {
  switch (outcome.kind) {
    case "completed":
      // THE WHOLE OUTPUT, and `isError` mirrors the tool's own verdict.
      return textResult(outcome.result.output, outcome.result.success === false);

    case "declined":
      return textResult(
        "A person DECLINED this action in Vex. Nothing was executed and no "
        + `funds moved. ${outcome.reason}`,
        true,
      );

    case "expired":
      return textResult(
        "This action EXPIRED before anyone decided it in Vex. Nothing was "
        + "executed and no funds moved. Ask the user to approve it in Vex if it "
        + "is still wanted, then call the tool again.",
        true,
      );

    case "refused":
      return textResult(refusedSentence(outcome.reason, outcome.confirmed), true);

    case "dispatch_failed":
      return textResult(
        "This action was approved but Vex could not carry it out, so nothing "
        + `was executed and no funds moved. It was NOT retried. ${outcome.reason}`,
        true,
      );

    case "indeterminate":
      return textResult(STUDIO_INDETERMINATE_SENTENCE, true);

    case "not_queued":
      // The reason is already the whole honest sentence: `runStudioCall` owns
      // one per cause (locked, starting, shutting down, unknown project,
      // wallet drift, at capacity) and each names its own remedy. Prefixing it
      // would restate what it already says.
      return textResult(outcome.reason, true);
  }
}
