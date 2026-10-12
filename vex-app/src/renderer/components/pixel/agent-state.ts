/**
 * The agent state the print shows, from signals the renderer already has; no
 * new IPC and no timer. It is the running head's tape word
 * (`features/appShell/DeskRuleTapeState.tsx`) drawn as a flock, so the
 * precedence is the tape's, strongest first:
 *
 *   awaiting  a pending approval freezes everything (the REAL FUNDS hold)
 *   live      a chat submit is active or a stream is open; every turn island
 *             word (Working, Thinking, Calling, Running, Writing) sits here
 *   paused    the mission run is paused (`paused_*`)
 *   running   a mission run is active, or the agent's own wake slice runs
 *   idle      nothing in flight (Sleeping draws idle too)
 *
 * The trigger table is `docs/design/V10-SPREAD.md section 6`.
 *
 * Honesty: the flock moves only while the system really does the thing. The
 * caller passes each signal from a store, never from a clock.
 */

/** The five states, named as the tape names them. */
export type DeskAgentState = "idle" | "live" | "running" | "awaiting" | "paused";

export const DESK_AGENT_STATES: readonly DeskAgentState[] = [
  "idle",
  "live",
  "running",
  "awaiting",
  "paused",
];

export interface DeskAgentSignals {
  /** At least one approval is pending. */
  readonly awaiting?: boolean;
  /** A chat submit is active or the stream preview is streaming. */
  readonly live?: boolean;
  /** An active mission run whose status starts with `paused`. */
  readonly paused?: boolean;
  /** An active mission run, or the session's activity reads running. */
  readonly running?: boolean;
}

/** The one state the print shows for a set of signals. */
export function deskAgentStateOf(signals: DeskAgentSignals): DeskAgentState {
  if (signals.awaiting === true) return "awaiting";
  if (signals.live === true) return "live";
  if (signals.paused === true) return "paused";
  if (signals.running === true) return "running";
  return "idle";
}
