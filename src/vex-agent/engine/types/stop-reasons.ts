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
  | "user_form_required";

export type StopReason = BusinessStopReason | RuntimeStopReason;
