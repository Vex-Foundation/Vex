/**
 * What the per-turn compaction-preparation read yields, and the two decisions
 * derived from it.
 *
 * ONE READ, TWO AXES (Gate 0). Three consumers independently wanted a DB read
 * inside the turn; the frozen contract is that the per-turn PRESSURE read
 * happens exactly once and serves both the C8 barrier bypass and the UI/tool
 * `hasCompactionSummaryReady` axis. `barrierBypassAllowed` and
 * `hasCompactionSummaryReady` below are pure functions of one snapshot, so the
 * two flags can never disagree about the same turn. (Apply-time capture keeps
 * its own authoritative transactional read — that is a different question,
 * asked under a lock.)
 *
 * FAIL CLOSED. Bypass is a security-relevant relaxation: it lets mutating,
 * fund-moving tools run at >=88% context, where the barrier would otherwise
 * strip them. The safe default is therefore "no bypass", and every state that
 * is not a positively-observed live preparation must map to it — including a
 * read that threw. That is what `resolvePreparationPressureState` guarantees,
 * and it is a test rather than a comment.
 *
 * This module is pure and dependency-free BY DESIGN: it is the seam the
 * preparation repo implements against, so it must not import the repo.
 */

import logger from "@utils/logger.js";

/**
 * Snapshot of the session's compaction preparation, as the turn loop sees it.
 *
 * Modeled as a discriminated union rather than a flags bag so impossible
 * combinations cannot be represented: there is no "ready but out of attempts",
 * no "failed with a live lease", and no way to read `attemptsRemaining` on a
 * state where it is meaningless.
 */
export type PreparationPressureState =
  /** No preparation exists for this session, or none that still bears on pressure. */
  | { readonly kind: "none" }
  /**
   * Branch A is still working: the summary is not ready yet, but the runtime
   * is actively producing one. Bypass is allowed only while this is genuinely
   * live — a dead lease or an exhausted attempt budget means nothing is coming.
   */
  | {
      readonly kind: "preparing";
      readonly preparationId: string;
      readonly leaseAlive: boolean;
      readonly attemptsRemaining: number;
      /**
       * Epoch-ms deadline of the attempt currently in flight, or `null` when
       * no attempt is running. The critical-band bounded wait waits on THIS
       * attempt only, never across a retry.
       */
      readonly currentAttemptDeadlineMs: number | null;
    }
  /**
   * Branch A produced a validated summary. Apply is available: the tool and
   * the UI button may appear, and the runtime can force the apply at critical.
   */
  | { readonly kind: "summary_ready"; readonly preparationId: string }
  /**
   * A cutover is IN FLIGHT (`apply_requested` consumed into `applying`). Its own
   * first-class state, deliberately NOT folded into `summary_ready`.
   *
   * Folding them was a real defect: the critical ladder saw `summary_ready`,
   * tried a forced apply that could not win (the row is no longer requestable),
   * and then fell through to the deterministic fallback — which bumps
   * `current + 1`, normally the very generation the in-flight preparation had
   * frozen as its target. Two writers then claim the same generation with
   * different summaries and archives, and apply-crash recovery can no longer
   * tell which one committed.
   *
   * So this state DEFERS the critical ladder instead: no forced apply, no
   * fallback, counter passed through. The cutover either completes and relieves
   * the pressure, or its stale lease is recovered and the next turn decides
   * again.
   */
  | { readonly kind: "applying"; readonly preparationId: string }
  /**
   * The preparation reached a terminal failure. Today's barrier returns and
   * the runtime falls back deterministically — no bypass, no apply.
   */
  | { readonly kind: "failed"; readonly preparationId: string };

/**
 * May the 0.88 barrier stop stripping mutating tools this turn?
 *
 * True only when a preparation is genuinely going to relieve the pressure:
 * either the summary is already ready, or Branch A is live with a held lease
 * and attempts left. Everything else — including `none` and `failed` — keeps
 * today's barrier.
 *
 * Scope is the BARRIER band only. Critical keeps stripping; forced apply owns
 * that band.
 */
export function barrierBypassAllowed(state: PreparationPressureState): boolean {
  switch (state.kind) {
    case "summary_ready":
      return true;
    case "preparing":
      return state.leaseAlive && state.attemptsRemaining > 0;
    // `applying` fails CLOSED even though relief is imminent. The snapshot
    // carries no apply-lease liveness, so a cutover whose owner died would
    // otherwise keep fund-moving tools unlocked at >=88% until recovery ran.
    // Denying the bypass costs one barrier-stripped turn; granting it wrongly
    // costs the barrier itself.
    case "applying":
    case "none":
    case "failed":
      return false;
    default:
      return assertNeverFailingClosed(state);
  }
}

/**
 * Is a validated summary available to apply right now?
 *
 * Gates `compact_apply`'s visibility and the UI's apply affordance. Derived
 * from the SAME snapshot as `barrierBypassAllowed` — never a second read.
 */
export function hasCompactionSummaryReady(state: PreparationPressureState): boolean {
  switch (state.kind) {
    case "summary_ready":
      return true;
    // Already being applied — offering `compact_apply` or the UI button would
    // invite a second request for a cutover that is mid-flight.
    case "applying":
    case "none":
    case "preparing":
    case "failed":
      return false;
    default:
      return assertNeverFailingClosed(state);
  }
}

/**
 * Read the preparation state for a turn, resolving every failure to `none`.
 *
 * `read` is injected rather than imported so this seam stays dependency-free
 * and independently testable; the turn loop binds it to the preparation repo's
 * `getLivePreparationPressureState`.
 *
 * A throwing read must never block a turn, and must never be mistaken for a
 * live preparation. Both requirements point the same way: log and return
 * `none`, which denies the bypass and hides the apply affordance.
 */
export async function resolvePreparationPressureState(
  sessionId: string,
  read: (sessionId: string) => Promise<PreparationPressureState>,
): Promise<PreparationPressureState> {
  try {
    return await read(sessionId);
  } catch (err) {
    logger.warn("compact.preparation_state.read_failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "none" };
  }
}

/**
 * Exhaustiveness guard that resolves to the SAFE answer instead of throwing.
 *
 * A new union member added without updating these switches is a compile error
 * (the `never` parameter). At runtime — a state row from a newer schema than
 * the running binary — it degrades to "no bypass, not ready" rather than
 * taking down the turn.
 */
function assertNeverFailingClosed(state: never): false {
  logger.warn("compact.preparation_state.unknown_kind", {
    kind: (state as { kind?: unknown }).kind,
  });
  return false;
}
