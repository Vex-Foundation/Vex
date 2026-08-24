/**
 * Stop conditions — why a run stopped.
 *
 * Implementation detail of `engine/types.ts`; import from there.
 */

// ── Stop conditions ─────────────────────────────────────────────

export type BusinessStopReason =
  | "goal_reached"
  | "deadline_reached"
  | "capital_depleted"
  | "max_loss_hit"
  | "no_viable_opportunity"
  | "emergency_stop"
  | "user_stopped";

export type RuntimeStopReason =
  | "approval_required"
  | "checkpoint_pause"
  | "iteration_limit"
  | "timeout"
  | "waiting_for_wake"
  | "waiting_for_compact_commit"
  | "compact_unable_at_critical"
  | "system_error"
  /** User requested pause at the next safe checkpoint (puzzle 03). */
  | "user_paused"
  /** Plan-mode: agent wrote/changed a plan that needs user acceptance before
   *  execution can resume. Resumed only by the `plan.accept` IPC. */
  | "plan_acceptance_required"
  /**
   * §C3b: the agent opened a launch form and the turn is parked until the human
   * answers it. Sibling of `approval_required` — the call it stopped on has no
   * transcript result yet, and `resumeAgentAfterUserForm` appends the only one.
   */
  | "user_form_required"
  /**
   * The model produced a run of rounds that emitted NOTHING - no tool call, no
   * text - so the turn stalled without consuming its iteration budget in any
   * meaningful sense.
   *
   * Deliberately NOT `iteration_limit`. `iteration_limit` means "the agent did
   * a lot of work and ran out of room"; this means "the agent did no work at
   * all and kept asking". They call for different copy, different operator
   * next steps, and different continuation policy: an exhausted budget is
   * continuable (a fresh slice makes progress), a stall is NOT - the round that
   * produced nothing persisted nothing, so the next round sees the identical
   * input and would stall identically. See
   * `runner/unproductive-rounds.ts` for the detector and its bound.
   */
  | "no_progress";

export type StopReason = BusinessStopReason | RuntimeStopReason;
