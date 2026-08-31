/**
 * Stop conditions - why a run stopped.
 *
 * Implementation detail of `engine/types.ts`; import from there.
 *
 * ## The tuples are the contract, the unions are derived
 *
 * Each union used to be hand-written, and every consumer that needed to
 * ENUMERATE the members (the runtime classification sets in
 * `core/stop-conditions.ts`, the strict chat schema in
 * `vex-app/src/shared/schemas/chat.ts`) re-typed the list by hand. A member
 * added to one list and forgotten in another is invisible to the compiler,
 * because a `Set<string>` accepts any string and a `z.enum` of a shorter list
 * is still a valid enum. That is exactly how `isRuntimePause` ended up
 * claiming `reason is RuntimeStopReason` while answering `false` for three
 * real runtime stops.
 *
 * So the tuples below are the single source of truth: the unions are derived
 * from them, the classification sets are built from them, and a cross-package
 * schema test asserts the chat enum matches `STOP_REASONS` member for member.
 * Adding a stop reason is one edit here plus whatever the tests then demand.
 */

// ── Stop conditions ─────────────────────────────────────────────

/**
 * Business stops terminate a run permanently. Model-reported through the
 * `MissionStop` internal tool, never parsed from text.
 */
export const BUSINESS_STOP_REASONS = [
  "goal_reached",
  "deadline_reached",
  "capital_depleted",
  "max_loss_hit",
  "no_viable_opportunity",
  "emergency_stop",
  "user_stopped",
] as const;

export type BusinessStopReason = (typeof BUSINESS_STOP_REASONS)[number];

/**
 * Runtime stops are engine states, not mission outcomes.
 *
 * Per-member notes for the ones whose name does not carry their contract:
 *
 * - `user_paused`: user requested a pause at the next safe checkpoint
 *   (puzzle 03).
 * - `plan_acceptance_required`: plan-mode; the agent wrote or changed a plan
 *   that needs user acceptance before execution can resume. Resumed only by
 *   the `plan.accept` IPC.
 * - `user_form_required`: §C3b, the agent opened a launch form and the turn is
 *   parked until the human answers it. Sibling of `approval_required` - the
 *   call it stopped on has no transcript result yet, and
 *   `resumeAgentAfterUserForm` appends the only one.
 * - `no_progress`: the model produced a run of rounds that emitted NOTHING -
 *   no tool call, no text - so the turn stalled without consuming its
 *   iteration budget in any meaningful sense. Deliberately NOT
 *   `iteration_limit`: that means "the agent did a lot of work and ran out of
 *   room", this means "the agent did no work at all and kept asking". They
 *   call for different copy, different operator next steps, and different
 *   continuation policy - an exhausted budget is continuable (a fresh slice
 *   makes progress), a stall is NOT, because the round that produced nothing
 *   persisted nothing, so the next round sees the identical input and would
 *   stall identically. See `runner/unproductive-rounds.ts`.
 * - `restart_orphan`: the run row said `running`, but the process that owned
 *   it died and its runner lease expired, so nothing is driving it. The
 *   reclaim owner parks it truthfully instead of leaving an orphan the
 *   operator can neither resume nor explain.
 * - `tool_call_loop`: the model repeated the SAME completed tool call - same
 *   name, same arguments, same result - enough times to prove it is cycling
 *   rather than working, and it did so again after being corrected once.
 *   Deliberately NOT `iteration_limit`: the budget is not the thing that ran
 *   out, the model is repeating itself. See
 *   `runner/tool-call-loop-detector.ts` for the signature, the bound, and why
 *   the first strike only corrects.
 */
export const RUNTIME_STOP_REASONS = [
  "approval_required",
  "checkpoint_pause",
  "iteration_limit",
  "timeout",
  "waiting_for_wake",
  "waiting_for_compact_commit",
  "compact_unable_at_critical",
  "system_error",
  "user_paused",
  "plan_acceptance_required",
  "user_form_required",
  "no_progress",
  "restart_orphan",
  "tool_call_loop",
] as const;

export type RuntimeStopReason = (typeof RUNTIME_STOP_REASONS)[number];

/**
 * Every stop reason, business first then runtime. The ORDER is part of the
 * artifact: the strict chat schema mirrors it, and the cross-package test
 * compares the two sequences, not two sets, so a reordering is a reviewed
 * diff rather than a silent one.
 */
export const STOP_REASONS = [
  ...BUSINESS_STOP_REASONS,
  ...RUNTIME_STOP_REASONS,
] as const;

export type StopReason = BusinessStopReason | RuntimeStopReason;
