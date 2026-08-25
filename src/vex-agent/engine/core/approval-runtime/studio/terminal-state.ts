/**
 * The ONE definition of "this Studio row can no longer change".
 *
 * Every release, every announce and every reported outcome on the Studio arm
 * is gated on this predicate, so they cannot disagree about what terminal
 * means. It is a pure function with no imports on purpose: the main process
 * imports it directly (`vex-app/src/main/studio/settlement-terminal.ts`)
 * rather than keeping a second copy that could drift.
 *
 * ## Why `approved/not_started` and `approved/dispatching` are NOT terminal
 *
 * The approval COMMITS BEFORE the dispatch. A reader that treats "decision
 * exists" as terminal therefore observes a legitimate mid-flight row - the
 * dispatcher has taken its slot, or is about to - and would answer a blocked
 * external agent "nothing happened" while the approved action is still on its
 * way. Those two states have an owner (the dispatcher, and the startup
 * reconciler if that process died); nobody may answer for them.
 *
 * A row that was never approved is terminal at its decision: a rejection never
 * dispatches, whatever its execution status says.
 */

/** The fields the predicate reads. Any row shape carrying them qualifies. */
export interface StudioTerminalStateInput {
  readonly decision: string | null;
  readonly executionStatus: string;
}

export function isTerminalStudioState(row: StudioTerminalStateInput): boolean {
  if (row.decision === null) return false;
  if (row.decision !== "approved") return true;
  return (
    row.executionStatus === "succeeded"
    || row.executionStatus === "failed"
    || row.executionStatus === "indeterminate"
  );
}
