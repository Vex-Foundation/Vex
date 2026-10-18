/**
 * THE VEX PRESENCE STATE: one word, one fill and one scope for what the agent
 * is doing, derived from signals the renderer already holds
 * (docs/design/R3-MINIMAL.md section 5).
 *
 * Pure. No React, no store, no IPC and no clock: `useVexPresence` reads the
 * stores and hands this module a `VexSituation`; everything here is a lookup
 * or a precedence, so every transition is testable without rendering. It
 * never invents a state the stores did not report: the fill moves only when
 * the system really does the thing.
 *
 * Precedence, strongest first:
 *
 *   waking     the boot gate is starting the local services (pre-shell only)
 *   awaiting   a pending approval freezes everything (the REAL FUNDS hold)
 *   live       a turn is in flight: thinking or working
 *   error      the turn failed, or the mission failed or paused on an error
 *   concerned  offline, the provider is rate-limited, balances are stale
 *   sleeping   paused by the user, parked on a wake, or the vault is locked
 *   running    a mission run (or the agent's own wake slice) is active
 *   done       the live to settled edge, held for `DONE_HOLD_MS` by the edge
 *   listening  the composer is focused and holds text
 *   ready      nothing in flight
 *
 * Status is a fill plus a word, never colour alone: `VEX_STATE_FILL` names the
 * fill (a swatch state) and `VEX_STATE_WORD` the word, and a surface renders
 * both.
 */

import type { EngineErrorEvent } from "@shared/schemas/engine-error.js";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";
import type { SwatchState } from "../../components/ui/swatch.js";
import type { RuntimeMode } from "../../stores/uiStore/runtime-mode.js";
import type { TurnIslandState } from "../appShell/TurnIsland/islandTurnState.js";

export type VexState =
  | "ready"
  | "listening"
  | "thinking"
  | "working"
  | "awaiting"
  | "done"
  | "concerned"
  | "error"
  | "sleeping"
  | "waking";

export const VEX_STATES: readonly VexState[] = [
  "ready",
  "listening",
  "thinking",
  "working",
  "awaiting",
  "done",
  "concerned",
  "error",
  "sleeping",
  "waking",
];

/** The word each state is shown with. A fill never stands without it. */
export const VEX_STATE_WORD: Readonly<Record<VexState, string>> = {
  ready: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  working: "Working",
  awaiting: "Waiting for approval",
  done: "Done",
  concerned: "Concerned",
  error: "Error",
  sleeping: "Sleeping",
  waking: "Waking up",
};

/**
 * The fill that carries each state, as the swatch's own `data-s` value, so a
 * surface passes it straight to `Swatch` or `StateWord`
 * (docs/design/R3-MINIMAL.md section 1.6). What each draws: outline for Ready,
 * a still dot screen for Listening, hatch for Thinking, solid for Working and
 * Done, the target for Waiting for approval, the stepping dot screen for
 * Waking up, ink hatch for Concerned, the ink cross for Error and the dotted
 * outline for Sleeping. Blue on paper (periwinkle at night) except the two
 * warning states, which the swatch paints in ink.
 */
export type VexFill = SwatchState;

export const VEX_STATE_FILL: Readonly<Record<VexState, VexFill>> = {
  ready: "idle",
  listening: "listening",
  thinking: "thinking",
  working: "done",
  awaiting: "awaiting",
  done: "done",
  concerned: "concerned",
  error: "error",
  sleeping: "sleeping",
  waking: "ongoing",
};

/** What the state is about: the open chat, the mission session or the project. */
export type VexScope = "This chat:" | "This mission:" | "This project:";

/**
 * The scope of the state word. Studio is always the project; with a session
 * open it is the session's own mode; on the welcome (no session) there is no
 * scope and the word stands alone ("Ready").
 */
export function vexScopeOf(input: {
  readonly runtimeMode: RuntimeMode;
  readonly sessionMode: "agent" | "mission" | null;
}): VexScope | null {
  if (input.runtimeMode === "studio") return "This project:";
  if (input.sessionMode === null) return null;
  return input.sessionMode === "mission" ? "This mission:" : "This chat:";
}

/** The word, with the lock plate's own wording for a locked vault. */
export function vexWordOf(
  state: VexState,
  options: { readonly locked?: boolean } = {},
): string {
  if (state === "sleeping" && options.locked === true) return "Sleeping · Locked";
  return VEX_STATE_WORD[state];
}

/** What the live turn is doing, in the two states the fill distinguishes. */
export type VexLive = "thinking" | "working";

/**
 * The turn island's state as a Vex state. The island's "vexing" register
 * (`working`: preparing, or waiting for the model) is Thinking; a tool call, a
 * running tool and the answer being written are Working. A live turn whose
 * island view is not known yet (the quiet gap before the first delta) is
 * Thinking, the honest word for "the model has the turn".
 */
export function vexLiveOf(turn: TurnIslandState | null): VexLive {
  switch (turn) {
    case "calling":
    case "running":
    case "writing":
      return "working";
    default:
      return "thinking";
  }
}

/** Why the turn or the mission is in the Error state. */
export type VexErrorCause =
  /** A session failure event; `scope` names which part failed. */
  | { readonly kind: "failure"; readonly scope: EngineErrorEvent["scope"] }
  /** The mission run is paused on an error and waits for Recover. */
  | { readonly kind: "mission_paused" }
  /** The mission run ended failed. */
  | { readonly kind: "mission_failed" };

/** Why Vex is Concerned. */
export type VexConcernCause =
  | { readonly kind: "offline" }
  /** The provider is rate-limited or unavailable (the `capacity` category). */
  | { readonly kind: "capacity"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "stale_balances" };

/** Why Vex is Sleeping. */
export type VexSleepCause =
  | { readonly kind: "locked" }
  | { readonly kind: "user_paused" }
  /** Parked on a wake; `wakeAt` is the wake instant as a local time, when known. */
  | { readonly kind: "wake"; readonly wakeAt: string | null };

/**
 * How a finished turn ended, when a caller can say more than "it finished".
 * `finished` is the honest default: the turn settled with no failure and no
 * approval waiting. `confirmed` and `goal_reached` are for a caller holding
 * evidence of a confirmed result or an accepted mission stop.
 */
export type VexDoneKind = "finished" | "confirmed" | "goal_reached";

/**
 * Everything the state and its narration are read from, assembled by
 * `useVexPresence` from the stores. Every field is a fact a store reported;
 * absent facts are `null` or `false`, never guesses.
 */
export interface VexSituation {
  readonly waking: boolean;
  /** Pending approvals for the open chat (or app-wide with no chat open). */
  readonly awaiting: {
    readonly count: number;
    /** The plain sentence naming one approval, when a caller can build it. */
    readonly sentence: string | null;
  } | null;
  /** The turn in flight. `word` is the turn island's own live phrase. */
  readonly live: {
    readonly kind: VexLive;
    readonly word: string;
    readonly userMessage: string | null;
  } | null;
  readonly error: VexErrorCause | null;
  readonly concern: VexConcernCause | null;
  readonly sleep: VexSleepCause | null;
  /** A mission run, or the agent's own wake slice, is active. */
  readonly running: boolean;
  /** The mission run's status when one is read; narration only. */
  readonly missionStatus: MissionRunStatus | null;
  readonly done: VexDoneKind | null;
  readonly listening: boolean;
}

/** A situation with nothing in flight; tests and callers override fields. */
export const QUIET_SITUATION: VexSituation = {
  waking: false,
  awaiting: null,
  live: null,
  error: null,
  concern: null,
  sleep: null,
  running: false,
  missionStatus: null,
  done: null,
  listening: false,
};

/** The one state a situation shows. See the precedence in the file header. */
export function vexStateOf(situation: VexSituation): VexState {
  if (situation.waking) return "waking";
  if (situation.awaiting !== null && situation.awaiting.count > 0) return "awaiting";
  if (situation.live !== null) return situation.live.kind;
  if (situation.error !== null) return "error";
  if (situation.concern !== null) return "concerned";
  if (situation.sleep !== null) return "sleeping";
  if (situation.running) return "working";
  if (situation.done !== null) return "done";
  if (situation.listening) return "listening";
  return "ready";
}

/**
 * How long Done is held after the live to settled edge. One shot: the edge
 * arms a single timeout, nothing loops, and a new live turn clears it.
 */
export const DONE_HOLD_MS = 4_000;

/**
 * Whether a live to settled edge ends in Done. Only a real edge counts (the
 * turn WAS live and now is not), and only a clean one: a turn that failed, or
 * that stopped to wait for a signature, is not finished.
 */
export function isDoneEdge(input: {
  readonly wasLive: boolean;
  readonly live: boolean;
  readonly blocked: boolean;
}): boolean {
  return input.wasLive && !input.live && !input.blocked;
}

/**
 * The timer's start for the live turn, in epoch ms, or `null`. Only a live
 * turn with a known start shows a timer: a mission that runs between turns and
 * an approval that waits have no honest elapsed time to count.
 */
export function vexTimerStartOf(
  state: VexState,
  live: boolean,
  startedAtMs: number | null,
): number | null {
  if (!live) return null;
  if (state !== "thinking" && state !== "working") return null;
  return startedAtMs;
}
