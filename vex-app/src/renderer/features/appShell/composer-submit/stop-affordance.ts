/**
 * THE stop affordance, named once and read by BOTH surfaces that offer Stop:
 * the composer's send/stop key and the `MissionControls` toolbar button (M6).
 *
 * ## Why one selector
 *
 * The two surfaces answered "should Stop be offered, and what is it called?"
 * separately - one from `stoppable` through `StopAvailability`, the other from
 * "a run row exists" - so they could contradict each other on the same session,
 * and neither said WHAT would be stopped. This resolves both questions in one
 * place; neither surface may re-derive them.
 *
 * ## Both dispatch the same route
 *
 * The composer fires `runtime.requestStop` and the toolbar fires
 * `mission.stop`. Those are two channel names for ONE dispatcher:
 * `main/ipc/mission/stop.ts` and `main/ipc/runtime/request-stop.ts` both
 * delegate to `runStopDispatch`, which owns the audit row and the control-state
 * emit. So the surfaces already agree about the EFFECT, and this module makes
 * them agree about the offer and the words.
 *
 * ## The three states, unchanged
 *
 * `StopAvailability` keeps its fail-open posture (`readStopAvailability`).
 * `unknown` means the engine was ASKED and did not answer, and it still fails
 * toward SHOWING the key: nothing will push an errored read back to the truth,
 * and a hidden Stop over a spending agent is the worse failure. The M5 activity
 * push does not change that reasoning - it makes `unknown` rarer, not safer.
 * The pre-first-read case stays `known-unavailable` (a session whose state was
 * never asked for has no work of ours in it), because reading it as unknown put
 * a Stop key where Send belongs on every session open.
 *
 * PRESENTATION ONLY: no authority. Main decides `stoppable`; the privileged
 * dispatcher decides what a Stop actually does.
 */

import type { StopAvailability } from "./stop-availability.js";

/** What the operator is stopping - the session's own vocabulary. */
export type StopTargetMode = "mission" | "agent";

export interface StopAffordance {
  /** Whether a Stop control should be offered at all. */
  readonly offered: boolean;
  /**
   * The accessible name. Named by TARGET, never "Stop generating": the key
   * stops a mission run or an autonomous agent session, and both outlive the
   * generation the old label described.
   */
  readonly label: string;
  /** The availability this was resolved from, for surfaces that stamp it. */
  readonly availability: StopAvailability;
}

const LABEL: Readonly<Record<StopTargetMode, string>> = {
  mission: "Stop mission",
  agent: "Stop agent",
};

/**
 * @param availability main's answer, read through `readStopAvailability`.
 * @param mode the session's mode; decides the words, never the offer.
 * @param foregroundTurnPending a chat turn this window owns is in flight. It
 *   is an INDEPENDENT reason to offer Stop: the window can always cancel its
 *   own request, whatever the durable state says about the session.
 */
export function resolveStopAffordance(
  availability: StopAvailability,
  mode: StopTargetMode,
  foregroundTurnPending: boolean,
): StopAffordance {
  return {
    offered: foregroundTurnPending || availability !== "known-unavailable",
    label: LABEL[mode],
    availability,
  };
}
