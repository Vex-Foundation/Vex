/**
 * The two pre-dispatch rules that make `BoardCompose` a TERMINAL presentation
 * tool. Pure: it reads a batch and one boolean and returns a decision.
 *
 * RULE 1, SOLE CALL. A batch that contains `BoardCompose` beside anything else
 * is refused whole, BEFORE dispatch. The compose hydrates provider data and
 * stages a board that the turn's final prose then carries; a sibling call in
 * the same batch would either run after the board is staged (which rule 2
 * forbids) or race it. Refusing the batch rather than the sibling keeps one
 * answer for one question: the model re-emits the compose alone.
 *
 * RULE 2, NOTHING AFTER A STAGED BOARD. Once a board is staged, every tool
 * call in the turn is refused before dispatch until the board is consumed by
 * the final prose. This is what makes approval parking and user-form parking
 * unreachable while a board is pending: both are consequences of a DISPATCHED
 * tool, and nothing dispatches here.
 *
 * Refusals are model-visible instructions, not errors to be interpreted: each
 * one states that nothing ran and names the single next action.
 */

/** The tool name the two rules are about. */
export const BOARD_COMPOSE_TOOL_NAME = "BoardCompose";

export const BOARD_COMPOSE_NOT_SOLE_CALL_OUTPUT =
  "board_compose_must_be_alone: BoardCompose presents a board and must be the ONLY tool call in "
  + "its batch. Nothing in this batch was dispatched and no board was staged. Emit BoardCompose "
  + "on its own, then write your final reply as plain prose.";

export const BOARD_PENDING_TOOL_REFUSED_OUTPUT =
  "board_pending_write_final_reply: a board is already staged for this turn and is waiting for "
  + "your final reply. No further tool calls run until it is attached, so this call was NOT "
  + "dispatched and had no effect. Write your final reply now as plain prose with no tool calls; "
  + "the staged board is attached to that message.";

export type PresentationGateDecision =
  | { readonly kind: "proceed" }
  | {
      readonly kind: "refuse_batch";
      readonly reason: "pending_presentation" | "compose_not_sole_call";
      /** Model-visible result written onto EVERY call in the refused batch. */
      readonly output: string;
    };

/**
 * Decide whether this batch may be dispatched at all.
 *
 * Rule 2 is evaluated first: when a board is pending, WHY the batch is wrong
 * is always "there is a board waiting", including for a second compose, and
 * telling the model about sole-call rules there would point it at the wrong
 * next action.
 */
export function evaluatePresentationGate(args: {
  readonly toolCalls: readonly { readonly name: string }[];
  readonly hasPendingPresentation: boolean;
}): PresentationGateDecision {
  if (args.toolCalls.length === 0) return { kind: "proceed" };

  if (args.hasPendingPresentation) {
    return {
      kind: "refuse_batch",
      reason: "pending_presentation",
      output: BOARD_PENDING_TOOL_REFUSED_OUTPUT,
    };
  }

  const composeCount = args.toolCalls.filter(
    (call) => call.name === BOARD_COMPOSE_TOOL_NAME,
  ).length;
  if (composeCount > 0 && args.toolCalls.length > 1) {
    return {
      kind: "refuse_batch",
      reason: "compose_not_sole_call",
      output: BOARD_COMPOSE_NOT_SOLE_CALL_OUTPUT,
    };
  }

  return { kind: "proceed" };
}
