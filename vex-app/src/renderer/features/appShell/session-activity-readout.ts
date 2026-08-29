/**
 * ONE readout of `RuntimeStateDto.activity` for every surface that names what
 * a session is doing (M5).
 *
 * WHY A SHARED SELECTOR. Two surfaces answer this question in two places - the
 * status strip above the composer and the desk-rule tape word - and before the
 * activity projection existed they answered it from different inputs, so a
 * wake-driven agent turn read RUNNING on one and Idle on the other. The DTO
 * ended the disagreement about the FACT; this module ends the disagreement
 * about the WORD. Neither surface may re-derive either.
 *
 * PRESENTATION ONLY. No authority, no policy: the activity was decided in main
 * (`session-control-state.ts`), and this turns it into a word plus a machine
 * label for tests and styling hooks.
 */

import type { RuntimeActivity } from "@shared/schemas/runtime.js";

/** Machine label - the `data-` attribute both surfaces stamp. */
export type SessionActivityState = "running" | "sleeping" | "idle";

export interface SessionActivityReadout {
  readonly state: SessionActivityState;
  /** Sentence-case word for assistive tech and the tape. */
  readonly label: string;
  /**
   * The scheduled wake instant, `null` unless sleeping. The CALLER formats it:
   * the tape has no room for a time and the strip does.
   */
  readonly nextWakeAt: string | null;
}

/**
 * `undefined` in, `null` out - and NOT an idle readout.
 *
 * The DTO declares `activity` required and main always projects it, so this is
 * not a state production is expected to reach. It is handled because the value
 * crosses a process boundary (rule 04: what crossed IPC is unknown until
 * checked) and the cost of being wrong is asymmetric: an absent field must not
 * throw out of a status strip and take the surrounding surface down with it.
 * Callers already read `null` as "say nothing", which is the honest answer to
 * an unreadable state - never "idle", which would ASSERT the session is doing
 * nothing.
 */
export function readSessionActivityReadout(
  activity: RuntimeActivity | undefined,
): SessionActivityReadout | null {
  if (activity === undefined) return null;
  switch (activity.kind) {
    case "running":
      return { state: "running", label: "Running", nextWakeAt: null };
    case "sleeping":
      return {
        state: "sleeping",
        label: "Sleeping",
        nextWakeAt: activity.nextWakeAt,
      };
    case "none":
      return { state: "idle", label: "Idle", nextWakeAt: null };
  }
}

/**
 * The wake instant as a local wall-clock time.
 *
 * A TIME, not a countdown: a countdown is a second clock that has to be kept
 * ticking and re-rendered, and it goes stale silently the moment the query
 * stops refreshing. An unparseable value degrades to `null` so the caller
 * prints the state word alone rather than "Invalid Date".
 */
export function formatWakeTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
